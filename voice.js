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
import opusPkg from "@discordjs/opus";
const { OpusEncoder } = opusPkg;

import { unlink, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import { execFile } from "child_process";
import { PassThrough } from "stream";
import ffmpegPath from "ffmpeg-static";

import { admin, firestore, realtimeDB } from "./firebase.js";

/* Map of guildId → { connection, player, channelId } */
const voiceConnections = new Map();

/* Prevent duplicate listeners */
const listeningGuilds = new Set();

/* Azure TTS */
const AZURE_VOICE = "en-GB-SoniaNeural";
const AZURE_OUTPUT_FORMAT = "audio-24khz-160kbitrate-mono-mp3";

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* Azure TTS → MP3 file */
async function azureTtsToFile(text, filepath) {
  const key = process.env.AZURE_SPEECH_KEY;
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
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT,
        "User-Agent": "AthenaBot",
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

/* Split text for fallback TTS */
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

/* Join voice */
export async function joinChannel(guild, voiceChannel, discordClient = null) {
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
  await entersState(connection, VoiceConnectionStatus.Ready, 45000);
} catch {
  if (connection.state.status !== VoiceConnectionStatus.Ready) {
    connection.destroy();
    throw new Error(`Voice connection failed for ${voiceChannel.name}`);
   }
  }

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 30000),
        entersState(connection, VoiceConnectionStatus.Connecting, 30000),
      ]);
    } catch {
      connection.destroy();
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    voiceConnections.delete(guild.id);
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const state = { connection, player, channelId: voiceChannel.id };

  await entersState(connection, VoiceConnectionStatus.Ready, 45000);

const state = { connection, player, channelId: voiceChannel.id };
voiceConnections.set(guild.id, state);

console.log(`[Voice] Connected to ${voiceChannel.name}`);

if (discordClient && !listeningGuilds.has(guild.id)) {
  console.log(`[VoiceRecognition] Listening in #${voiceChannel.name}`);
  startListeningInChannel(connection, guild, discordClient);
  listeningGuilds.add(guild.id);
}

  return state;
}

/* Leave voice */
export function leaveChannel(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;

  state.connection.destroy();
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

function playAndWait(player, resource) {
  return new Promise((resolve) => {
    const onIdle = () => {
      player.removeListener("error", onError);
      resolve();
    };

    const onError = () => {
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      resolve();
    };

    player.play(resource);
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}

/* Speak */
export async function speak(guild, voiceChannel, text) {
  try {
    const state = await joinChannel(guild, voiceChannel);

    if (process.env.AZURE_SPEECH_KEY) {
      const filepath = `/tmp/voice_${Date.now()}.mp3`;

      try {
        await azureTtsToFile(text.substring(0, 5000), filepath);
        const resource = createAudioResource(filepath, {
          inputType: StreamType.Arbitrary,
        });

        await playAndWait(state.player, resource);
      } finally {
        unlink(filepath, () => {});
      }
    } else {
      const chunks = splitText(text);

      for (const chunk of chunks) {
        const stream = await gttsTtsStream(chunk);
        const resource = createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
        });

        await playAndWait(state.player, resource);
      }
    }

    return true;
  } catch {
    return false;
  }
}

/* Voice Recording */

const activeRecordings = new Map();

/* Whisper transcription */
async function transcribeWithWhisper(mp3FilePath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const { readFileSync } = await import("fs");
  const audio = readFileSync(mp3FilePath);

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  if (!res.ok) return null;

  const data = await res.json();
  return data.text?.trim() || null;
}

/* PCM → MP3 */
function pcmToMp3(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const inputPath = outputPath.replace(".mp3", ".pcm");

    writeFileSync(inputPath, pcmBuffer);

    execFile(
      ffmpegPath,
      [
        "-y",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        inputPath,
        "-acodec",
        "libmp3lame",
        "-b:a",
        "64k",
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

function extractTopics(text) {
  if (!text) return [];

  const keywords = [
    "AI",
    "Athena",
    "Unity",
    "Discord",
    "Firebase",
    "ship",
    "quantum",
    "physics",
    "space",
    "military",
  ];

  const lower = text.toLowerCase();

  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

/* Store transcript */
async function storeVoiceLog(userId, user, guild, data) {
  const timestamp = new Date().toISOString();

  const topics = extractTopics(data.transcript);

  const logEntry = {
    discordId: userId,
    username: user.username,
    displayName: user.globalName || user.username,
    guildId: guild.id,
    guildName: guild.name,
    timestamp,
    ...data,
    topics,
  };

  const fingerprintRef = firestore.collection("voice_fingerprints").doc(userId);

  await fingerprintRef.collection("audio_logs").add(logEntry);

  await fingerprintRef.set(
    {
      discordId: userId,
      username: user.username,
      displayName: user.globalName || user.username,
      lastSeen: timestamp,
      sampleCount: admin.firestore.FieldValue.increment(1),
      totalDurationMs: admin.firestore.FieldValue.increment(data.durationMs),
      lastTranscript: data.transcript || null,
    },
    { merge: true }
  );

  await realtimeDB.ref(`live_voice/${guild.id}`).push(logEntry);
}

/* Process voice sample */
async function processVoiceSample(
  userId,
  user,
  guild,
  channelId,
  opusChunks,
  durationMs
) {
  if (!opusChunks.length) return;

  const encoder = new OpusEncoder(48000, 2);
  const pcmChunks = [];

  for (const packet of opusChunks) {
    try {
      const decoded = encoder.decode(packet);
      pcmChunks.push(decoded);
    } catch {}
  }

  if (!pcmChunks.length) return;

  const pcmBuffer = Buffer.concat(pcmChunks);

  const mp3Path = `/tmp/voice_${userId}_${Date.now()}.mp3`;

  await pcmToMp3(pcmBuffer, mp3Path);

  const transcript = await transcribeWithWhisper(mp3Path);

  await storeVoiceLog(userId, user, guild, {
    channelId,
    durationMs,
    transcript,
    sampleSizeBytes: pcmBuffer.length,
  });

  unlink(mp3Path, () => {});
}

/* Start listening */
export function startListeningInChannel(connection, guild, discordClient) {
  if (!process.env.VOICE_RECORDING_ENABLED) return;

  const { receiver } = connection;

  receiver.speaking.on("start", async (userId) => {
    const key = `${guild.id}_${userId}`;
    if (activeRecordings.has(key)) return;

    const user = await discordClient.users.fetch(userId).catch(() => null);
    if (!user || user.bot) return;

    activeRecordings.set(key, true);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1500,
      },
    });

    const opusChunks = [];
    const start = Date.now();

    opusStream.on("data", (chunk) => opusChunks.push(chunk));

    opusStream.on("end", async () => {
      activeRecordings.delete(key);

      const duration = Date.now() - start;

      if (duration < 300) return;

      await processVoiceSample(
        userId,
        user,
        guild,
        connection.joinConfig.channelId,
        opusChunks,
        duration
      );
    });

    opusStream.on("error", () => {
      activeRecordings.delete(key);
    });
  });
    }
