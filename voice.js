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

/* Channels Athena was kicked from (4014) — guardian honors this for 5min.
   Map<channelId, expiresAtMs>. Exported for bot.js guardian. */
export const recentEvictions = new Map();

/* Listener registry — populated by startListeningInChannel(). Used by the
   Destroyed-handler immediate recovery path so a freshly re-joined connection
   gets its receiver re-subscribed (otherwise transcription dies silently). */
const activeListeners = new Map(); /* channelId → { client, sessionId } */

export function hasActiveListener(channelId) {
  return activeListeners.has(channelId);
}

export function isChannelEvicted(channelId) {
  const exp = recentEvictions.get(channelId);
  if (!exp) return false;
  if (Date.now() > exp) {
    recentEvictions.delete(channelId);
    return false;
  }
  return true;
}

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
    /* Already in this exact channel — return only if the connection is healthy.
       If the underlying connection is in Disconnected/Destroyed/unknown state,
       force a fresh join instead of handing back a dead connection. */
    if (existing.channelId === voiceChannel.id) {
      const status = existing.connection.state.status;
      const healthy =
        status === VoiceConnectionStatus.Ready ||
        status === VoiceConnectionStatus.Signalling ||
        status === VoiceConnectionStatus.Connecting;
      if (healthy) return existing;
      console.warn(`[Voice] Existing connection for #${voiceChannel.name} is ${status} — destroying and re-establishing.`);
      intentionalLeaves.add(guild.id);
      try { existing.connection.destroy(); } catch {}
      voiceConnections.delete(guild.id);
    } else
    /* If existing connection is passive and the new request is explicit, allow upgrade.
       Mark these destroys as intentional so the Destroyed handler does NOT
       trigger immediate recovery (which would re-join the OLD channel and
       race the new join). */
    if (existing.passive && !passive) {
      intentionalLeaves.add(guild.id);
      existing.connection.destroy();
      voiceConnections.delete(guild.id);
    } else if (!existing.passive) {
      /* Explicit connection already exists — move to new channel */
      intentionalLeaves.add(guild.id);
      existing.connection.destroy();
      voiceConnections.delete(guild.id);
    } else if (voiceConnections.has(guild.id)) {
      /* Both passive, different channel — return existing rather than thrash. */
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

  /* ── Reconnect on transient disconnects using proper rejoin() strategy ──
     If the voice gateway is the one disconnecting (closeCode 4014 = moved/kicked,
     or transient ws drops), the standard pattern is to race Signalling vs Connecting:
     either means the connection is auto-recovering. Otherwise destroy cleanly so
     the guardian in bot.js can re-establish a fresh connection. */
  connection.on(VoiceConnectionStatus.Disconnected, async (_, newState) => {
    const reason    = newState.reason;
    const closeCode = newState.closeCode ?? "n/a";
    console.log(`[Voice] Disconnected from #${voiceChannel.name} — reason: ${reason}, closeCode: ${closeCode}`);

    if (
      reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      closeCode === 4014
    ) {
      /* 4014 = forcibly removed (kicked / moved). Discord won't auto-reconnect.
         Mark the channel as "evicted" for 5 minutes so the bot.js guardian doesn't
         immediately re-join — that respected the mod's intent to kick her. */
      console.warn(`[Voice] 4014 close in #${voiceChannel.name} — honoring eviction for 5 min.`);
      recentEvictions.set(voiceChannel.id, Date.now() + 5 * 60 * 1000);
      try { connection.destroy(); } catch {}
      return;
    }

    /* Race auto-recovery: if the voice manager moves to Signalling/Connecting
       within 5s, recovery is in progress. Otherwise rejoin manually. */
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log(`[Voice] Auto-recovery in progress for #${voiceChannel.name}...`);
      return;
    } catch {
      /* No auto-recovery — try manual rejoin a few times then surrender to guardian */
    }

    if (connection.rejoinAttempts < 5) {
      const delay = (connection.rejoinAttempts + 1) * 5_000;
      console.log(`[Voice] Manual rejoin attempt ${connection.rejoinAttempts + 1}/5 in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      try { connection.rejoin(); } catch (err) {
        console.warn(`[Voice] rejoin() threw: ${err.message} — destroying for guardian.`);
        try { connection.destroy(); } catch {}
      }
    } else {
      console.warn(`[Voice] Exhausted 5 rejoin attempts for #${voiceChannel.name} — destroying for guardian.`);
      try { connection.destroy(); } catch {}
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

  /* ── Clean up the map when the connection is fully destroyed ──
     If destruction was unexpected (no intentional leave, channel still has
     humans, not under eviction cooldown), trigger an immediate fresh-join
     attempt rather than waiting up to 30s for the bot.js guardian. */
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    voiceConnections.delete(guild.id);
    console.log(`[Voice] Connection destroyed for guild ${guild.id} (#${voiceChannel.name})`);

    if (intentionalLeaves.has(guild.id)) {
      intentionalLeaves.delete(guild.id);
      return;
    }
    if (isChannelEvicted(voiceChannel.id)) return;

    /* Fire-and-forget immediate recovery — guardian remains the safety net. */
    setImmediate(async () => {
      try {
        const fresh = guild.channels.cache.get(voiceChannel.id);
        if (!fresh) return;
        const humans = [...fresh.members.values()].filter(m => !m.user.bot).length;
        if (humans === 0) return;
        if (voiceConnections.has(guild.id)) return; /* something already reconnected */
        console.log(`[Voice] Immediate recovery: rejoining #${fresh.name} (${humans} humans present)`);
        const freshState = await joinChannel(guild, fresh, { passive });

        /* CRITICAL: a fresh connection has a fresh receiver. The previous
           receiver.speaking listeners are gone with the destroyed connection,
           so transcription would silently stop. Re-subscribe using the params
           captured the first time startListeningInChannel was called for this
           channel. */
        const listenerCfg = activeListeners.get(voiceChannel.id);
        if (listenerCfg) {
          startListeningInChannel(
            freshState.connection,
            guild,
            listenerCfg.client,
            listenerCfg.sessionId
          );
          console.log(`[Voice] Immediate recovery: re-attached listener in #${fresh.name}`);
        } else {
          console.warn(`[Voice] Immediate recovery: no active listener config for #${fresh.name} — transcription will not resume until guardian re-joins.`);
        }
      } catch (err) {
        console.warn(`[Voice] Immediate recovery failed for #${voiceChannel.name}: ${err.message} — guardian will retry.`);
      }
    });
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const state = { connection, player, channelId: voiceChannel.id, passive };
  voiceConnections.set(guild.id, state);
  console.log(`[Voice] Joined #${voiceChannel.name} in ${guild.name} (${passive ? "passive/silent" : "active"})`);
  return state;
}

/* Tracks guilds where leave was deliberately invoked, so the Destroyed
   handler doesn't trigger immediate-recovery for an intentional leave. */
const intentionalLeaves = new Set();

/* ── Leave the voice channel in a guild ── */
export function leaveChannel(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;
  intentionalLeaves.add(guildId);
  /* Clear listener registry for this channel so it doesn't accumulate stale
     entries across the bot's lifetime. Auto-recovery won't fire here because
     the leave is marked intentional. */
  if (state.channelId) activeListeners.delete(state.channelId);
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

    console.log(`[Firestore:voice_fingerprints] Stored audio_log for ${user.username} — "${transcript || "no transcript"}" (${durationMs}ms)`);
  } catch (err) {
    console.error("[Firestore:voice_fingerprints] storeVoiceLog FAILED:", err.message);
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
  /* Idempotency: never attach the speaking listener twice to the same
     connection — that would double-record audio and write duplicate
     fingerprints. We tag the connection object with a hidden flag once
     attached. */
  if (connection.__athenaListenerAttached) {
    console.log(`[VoiceListen] Listener already attached to this connection in ${guild.name} — skipping duplicate.`);
    return;
  }
  connection.__athenaListenerAttached = true;

  const { receiver } = connection;
  console.log(`[VoiceListen] Listening for voices in ${guild.name}${sessionId ? ` (session ${sessionId})` : ""}`);

  /* Register this listener config so immediate-recovery can re-attach it
     if the connection is unexpectedly destroyed. Keyed by current channelId. */
  const stateForGuild = voiceConnections.get(guild.id);
  const channelId = stateForGuild?.channelId;
  if (channelId) {
    activeListeners.set(channelId, { client: discordClient, sessionId });
  }

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
