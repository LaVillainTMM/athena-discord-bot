import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  StreamType,
  entersState,
  EndBehaviorType,
} from "@discordjs/voice";
import opusPkg from "@discordjs/opus";
const { OpusEncoder } = opusPkg;
import { unlink, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import { execFile } from "child_process";
import { PassThrough } from "stream";
import ffmpegPath from "ffmpeg-static";
import { admin, firestore } from "./firebase.js";

/* Map of guildId → { connection, player, channelId } */
const voiceConnections = new Map();

/* ── Azure TTS config (mirrors audioMessage.js) ── */
const AZURE_VOICE         = "en-GB-SoniaNeural";
const AZURE_OUTPUT_FORMAT = "audio-24khz-160kbitrate-mono-mp3";

function escapeXml(text) {
  return text
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

/* ── Generate MP3 to a temp file via Azure TTS ── */
async function azureTtsToFile(text, filepath) {
  const key    = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION || "eastus";

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-GB'>
  <voice name='${AZURE_VOICE}'>
    <prosody rate='-5%' pitch='+2%'>${escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type":              "application/ssml+xml",
        "X-Microsoft-OutputFormat":  AZURE_OUTPUT_FORMAT,
        "User-Agent":                "AthenaBot",
      },
      body: ssml,
    }
  );

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Azure TTS ${response.status}: ${err.substring(0, 200)}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(filepath, Buffer.from(buffer));
}

/* ── Fallback: node-gtts stream (used when Azure key is absent) ── */

/* Split long text at sentence boundaries for Google TTS 190-char limit */
function splitText(text, maxLen = 190) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = s.length > maxLen ? s.substring(0, maxLen) : s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.substring(0, maxLen)];
}

async function gttsTtsStream(text) {
  const { default: gtts } = await import("node-gtts");
  const tts = new gtts("en");
  const pass = new PassThrough();
  tts.stream(text).pipe(pass);
  return pass;
}

/* ── Join a voice channel ── */
/* passive = true → selfMute so Athena can listen without appearing as a speaker */
export async function joinChannel(guild, voiceChannel, { passive = false } = {}) {
  const existing = voiceConnections.get(guild.id);
  if (existing) {
    /* Already in this exact channel — nothing to do */
    if (existing.channelId === voiceChannel.id) return existing;
    /* If existing connection is passive and the new request is explicit, allow upgrade */
    if (existing.passive && !passive) {
      existing.connection.destroy();
      voiceConnections.delete(guild.id);
    } else if (!existing.passive) {
      /* Explicit connection already exists — move to new channel */
      existing.connection.destroy();
      voiceConnections.delete(guild.id);
    } else {
      /* Both passive — already in different channel, skip */
      return existing;
    }
  }

  /* ── Permission pre-check ── */
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (me) {
    const perms = voiceChannel.permissionsFor(me);
    const missing = [];
    if (!perms.has("ViewChannel")) missing.push("View Channel");
    if (!perms.has("Connect"))     missing.push("Connect");
    if (!perms.has("Speak"))       missing.push("Speak");
    if (missing.length > 0) {
      throw new Error(
        `Missing permissions in **${voiceChannel.name}**: ${missing.join(", ")}. ` +
        `A server admin needs to grant these to the Athena bot role on that channel.`
      );
    }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId:   guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: passive, /* muted when passively listening — unmuted when explicitly joined */
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw new Error(
      `Timed out connecting to **${voiceChannel.name}**. ` +
      `Verify the bot has Connect + Speak permissions on that channel in server settings.`
    );
  }

  /* ── Reconnect on transient disconnects using proper rejoin() strategy ── */
  connection.on(VoiceConnectionStatus.Disconnected, async (_, newState) => {
    const reason    = newState.reason;
    const closeCode = newState.closeCode ?? "n/a";
    console.log(`[Voice] Disconnected from #${voiceChannel.name} — reason: ${reason}, closeCode: ${closeCode}`);

    if (
      reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      closeCode === 4014
    ) {
      /* 4014 = forcibly removed from channel (kicked / moved).
         Waiting for Connecting state is the correct recovery path here. */
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        console.log(`[Voice] Recovering from 4014 close in #${voiceChannel.name}...`);
      } catch {
        console.warn(`[Voice] 4014 recovery failed — destroying.`);
        connection.destroy();
      }
      return;
    }

    /* For all other disconnect reasons, attempt up to 5 rejoins with backoff */
    if (connection.rejoinAttempts < 5) {
      const delay = (connection.rejoinAttempts + 1) * 5_000;
      console.log(`[Voice] Rejoin attempt ${connection.rejoinAttempts + 1}/5 in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      connection.rejoin();
    } else {
      console.warn(`[Voice] Exhausted 5 rejoin attempts for #${voiceChannel.name} — destroying.`);
      connection.destroy();
    }
  });

  connection.on(VoiceConnectionStatus.Signalling, () => {
    console.log(`[Voice] Re-signalling to #${voiceChannel.name}...`);
  });
  connection.on(VoiceConnectionStatus.Connecting, () => {
    console.log(`[Voice] Reconnecting UDP to #${voiceChannel.name}...`);
  });
  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log(`[Voice] Connection ready in #${voiceChannel.name}`);
  });

  /* ── Clean up the map when the connection is fully destroyed ── */
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    voiceConnections.delete(guild.id);
    console.log(`[Voice] Connection destroyed for guild ${guild.id} (#${voiceChannel.name})`);
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const state = { connection, player, channelId: voiceChannel.id, passive };
  voiceConnections.set(guild.id, state);
  console.log(`[Voice] Joined #${voiceChannel.name} in ${guild.name} (${passive ? "passive/silent" : "active"})`);
  return state;
}

/* ── Leave the voice channel in a guild ── */
export function leaveChannel(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;
  state.connection.destroy();
  /* voiceConnections map is cleaned up by the Destroyed listener */
  console.log(`[Voice] Left voice channel in guild ${guildId}`);
  return true;
}

export function isInVoice(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;
  const status = state.connection.state.status;
  return (
    status === VoiceConnectionStatus.Ready ||
    status === VoiceConnectionStatus.Signalling ||
    status === VoiceConnectionStatus.Connecting
  );
}

export function getVoiceChannelId(guildId) {
  return voiceConnections.get(guildId)?.channelId ?? null;
}

/* ── Helper: play a single audio resource and wait for it to finish ── */
function playAndWait(player, resource) {
  return new Promise((resolve) => {
    const onIdle = () => {
      player.removeListener("error", onError);
      resolve();
    };
    const onError = (err) => {
      console.error("[Voice] Playback error:", err.message);
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      resolve();
    };
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}

/* ── Speak text in a voice channel using Azure TTS (fallback: gtts) ── */
export async function speak(guild, voiceChannel, text) {
  try {
    const state = await joinChannel(guild, voiceChannel);

    if (process.env.AZURE_SPEECH_KEY) {
      /* Azure TTS: generate MP3 file, stream it into Discord */
      const filepath = `/tmp/voice_${Date.now()}.mp3`;
      try {
        await azureTtsToFile(text.substring(0, 5000), filepath);
        const resource = createAudioResource(filepath, { inputType: StreamType.Arbitrary });
        await playAndWait(state.player, resource);
      } finally {
        unlink(filepath, () => {});
      }
    } else {
      /* Fallback: node-gtts in chunks */
      const chunks = splitText(text);
      for (const chunk of chunks) {
        const stream = await gttsTtsStream(chunk);
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
        await playAndWait(state.player, resource);
      }
    }

    return true;
  } catch (err) {
    console.error("[Voice] speak() failed:", err.message);
    return false;
  }
}

/* ──────────────────────────────────────────────────────
   VOICE LISTENING — listen to users speaking in a voice
   channel, transcribe their audio, store voice logs and
   fingerprints in Firebase for identity confirmation.
────────────────────────────────────────────────────── */

/* Tracks users currently being recorded per guild — prevents duplicate subscriptions */
const activeRecordings = new Map(); /* guildId_userId → true */

/* Transcribe an MP3 file using OpenAI Whisper */
async function transcribeWithWhisper(mp3FilePath) {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) return null;

  try {
    const { readFileSync } = await import("fs");
    const audioBytes = readFileSync(mp3FilePath);
    const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });

    const form = new FormData();
    form.set("file", audioBlob, "audio.mp3");
    form.set("model", "whisper-1");
    form.set("language", "en");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[VoiceListen] Whisper error ${res.status}:`, errText.substring(0, 150));
      return null;
    }

    const data = await res.json();
    return data.text?.trim() || null;
  } catch (err) {
    console.error("[VoiceListen] Whisper transcription failed:", err.message);
    return null;
  }
}

/* Convert raw PCM buffer → MP3 file via ffmpeg */
function pcmToMp3(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const inputPath = outputPath.replace(".mp3", ".pcm");
    writeFileSync(inputPath, pcmBuffer);

    execFile(
      ffmpegPath,
      [
        "-y",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-i", inputPath,
        "-acodec", "libmp3lame",
        "-b:a", "64k",
        outputPath,
      ],
      (err) => {
        unlink(inputPath, () => {});
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/* Store a voice log entry + update voice fingerprint in Firebase */
async function storeVoiceLog(userId, user, guild, { durationMs, transcript, sampleSizeBytes, sessionId }) {
  try {
    const fingerprintRef = firestore
      .collection("voice_fingerprints")
      .doc(userId);

    const logEntry = {
      discordId: userId,
      username: user.username,
      displayName: user.globalName || user.username,
      guildId: guild.id,
      guildName: guild.name,
      timestamp: new Date().toISOString(),
      durationMs,
      sampleSizeBytes,
      transcript: transcript || null,
      sessionId: sessionId || null,
    };

    /* Add this sample to the audio_logs subcollection */
    await fingerprintRef
      .collection("audio_logs")
      .add(logEntry);

    /* Update (or create) the fingerprint document with latest metadata */
    await fingerprintRef.set(
      {
        discordId: userId,
        username: user.username,
        displayName: user.globalName || user.username,
        avatarUrl: user.displayAvatarURL?.({ size: 256 }) ?? null,
        lastSeen: new Date().toISOString(),
        sampleCount: admin.firestore.FieldValue.increment(1),
        totalDurationMs: admin.firestore.FieldValue.increment(durationMs),
        guilds: { [guild.id]: guild.name },
        lastTranscript: transcript || null,
      },
      { merge: true }
    );

    console.log(`[VoiceListen] Stored voice log for ${user.username}: "${transcript || "no transcript"}" (${durationMs}ms)`);
  } catch (err) {
    console.error("[VoiceListen] storeVoiceLog error:", err.message);
  }
}

/* Process a captured Opus audio chunk array for one user utterance */
async function processVoiceSample(userId, user, guild, opusChunks, durationMs, sessionId) {
  if (opusChunks.length === 0) return;

  const ts = Date.now();
  const mp3Path = `/tmp/voice_${userId}_${ts}.mp3`;

  try {
    /* Decode Opus packets → raw PCM using @discordjs/opus */
    const encoder = new OpusEncoder(48000, 2);
    const pcmChunks = [];
    for (const packet of opusChunks) {
      try {
        const decoded = encoder.decode(packet);
        pcmChunks.push(decoded);
      } catch (_) {
        /* skip malformed packets */
      }
    }

    if (pcmChunks.length === 0) return;

    const pcmBuffer = Buffer.concat(pcmChunks);

    /* Convert PCM → MP3 for Whisper */
    await pcmToMp3(pcmBuffer, mp3Path);

    /* Transcribe */
    const transcript = await transcribeWithWhisper(mp3Path);

    /* Store in Firebase — include sessionId so fingerprints link to the session */
    await storeVoiceLog(userId, user, guild, {
      durationMs,
      transcript,
      sampleSizeBytes: pcmBuffer.length,
      sessionId: sessionId || null,
    });
  } catch (err) {
    console.error(`[VoiceListen] processVoiceSample error for ${user.username}:`, err.message);
  } finally {
    unlink(mp3Path, () => {});
  }
}

/* ──────────────────────────────────────────────────────
   START LISTENING IN CHANNEL
   Call after joinChannel() to subscribe to all speaking
   users, capture their audio, transcribe it, and store
   voice logs + fingerprints in Firebase.
────────────────────────────────────────────────────── */
export function startListeningInChannel(connection, guild, discordClient, sessionId = null) {
  const { receiver } = connection;
  console.log(`[VoiceListen] Listening for voices in ${guild.name}${sessionId ? ` (session ${sessionId})` : ""}`);

  receiver.speaking.on("start", async (userId) => {
    const key = `${guild.id}_${userId}`;
    if (activeRecordings.has(key)) return;

    try {
      const user = await discordClient.users.fetch(userId).catch(() => null);
      if (!user || user.bot) return;

      activeRecordings.set(key, true);
      console.log(`[VoiceListen] Recording ${user.username}...`);

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
      });

      const opusChunks = [];
      const startTime = Date.now();

      opusStream.on("data", (chunk) => opusChunks.push(chunk));

      opusStream.on("end", async () => {
        activeRecordings.delete(key);
        const durationMs = Date.now() - startTime;

        /* Ignore very short clips — noise/blips */
        if (durationMs < 300 || opusChunks.length < 3) return;

        processVoiceSample(userId, user, guild, opusChunks, durationMs, sessionId).catch((err) =>
          console.error("[VoiceListen] Async processVoiceSample error:", err.message)
        );
      });

      opusStream.on("error", (err) => {
        activeRecordings.delete(key);
        console.error(`[VoiceListen] Audio stream error for ${user.username}:`, err.message);
      });
    } catch (err) {
      activeRecordings.delete(`${guild.id}_${userId}`);
      console.error("[VoiceListen] speaking.start error:", err.message);
    }
  });
}
