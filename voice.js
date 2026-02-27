import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} from "@discordjs/voice";
import { createWriteStream, unlink } from "fs";
import https from "https";
import { PassThrough } from "stream";

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
