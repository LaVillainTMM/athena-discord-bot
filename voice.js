import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  EndBehaviorType,
} from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import { createWriteStream, unlink, writeFileSync } from "fs";
import { execFile } from "child_process";
import https from "https";
import { PassThrough } from "stream";
import ffmpegPath from "ffmpeg-static";
import { admin, firestore } from "./firebase.js";

/* Map of guildId → { connection, player, channelId } */
const voiceConnections = new Map();

/* ── ElevenLabs config (mirrors audioMessage.js) ── */
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "pFZP5JQG7iQjIQuC4Bku"; /* Lily — British female, velvety actress */
const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const VOICE_SETTINGS = {
  stability: 0.42,
  similarity_boost: 0.80,
  style: 0.38,
  use_speaker_boost: true,
};

/* ── Generate MP3 to a temp file via ElevenLabs ── */
function elevenLabsToFile(text, filepath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: VOICE_SETTINGS,
    });

    const options = {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept": "audio/mpeg",
      },
    };

    const fileStream = createWriteStream(filepath);
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (d) => (errBody += d));
        res.on("end", () => {
          fileStream.destroy();
          reject(new Error(`ElevenLabs ${res.statusCode}: ${errBody.substring(0, 150)}`));
        });
        return;
      }
      res.pipe(fileStream);
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── Fallback: node-gtts stream (used when ElevenLabs key is absent) ── */

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
export async function joinChannel(guild, voiceChannel) {
  const existing = voiceConnections.get(guild.id);
  if (existing) {
    if (existing.channelId === voiceChannel.id) return existing;
    existing.connection.destroy();
    voiceConnections.delete(guild.id);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    connection.destroy();
    throw new Error("Could not connect to voice channel. Check bot permissions.");
  }

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      voiceConnections.delete(guild.id);
    }
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const state = { connection, player, channelId: voiceChannel.id };
  voiceConnections.set(guild.id, state);
  console.log(`[Voice] Joined #${voiceChannel.name} in ${guild.name}`);
  return state;
}

/* ── Leave the voice channel in a guild ── */
export function leaveChannel(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;
  state.connection.destroy();
  voiceConnections.delete(guildId);
  console.log(`[Voice] Left voice channel in guild ${guildId}`);
  return true;
}

export function isInVoice(guildId) {
  return voiceConnections.has(guildId);
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

/* ── Speak text in a voice channel using ElevenLabs (fallback: gtts) ── */
export async function speak(guild, voiceChannel, text) {
  try {
    const state = await joinChannel(guild, voiceChannel);

    if (ELEVENLABS_API_KEY) {
      /* ElevenLabs: generate MP3 file, stream it into Discord */
      const filepath = `/tmp/voice_${Date.now()}.mp3`;
      try {
        await elevenLabsToFile(text.substring(0, 5000), filepath);
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
async function storeVoiceLog(userId, user, guild, { durationMs, transcript, sampleSizeBytes }) {
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
async function processVoiceSample(userId, user, guild, opusChunks, durationMs) {
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

    /* Store in Firebase */
    await storeVoiceLog(userId, user, guild, {
      durationMs,
      transcript,
      sampleSizeBytes: pcmBuffer.length,
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
export function startListeningInChannel(connection, guild, discordClient) {
  const { receiver } = connection;
  console.log(`[VoiceListen] Listening for voices in ${guild.name}`);

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

        processVoiceSample(userId, user, guild, opusChunks, durationMs).catch((err) =>
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
