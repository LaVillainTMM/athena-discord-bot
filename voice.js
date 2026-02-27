import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} from "@discordjs/voice";
import gtts from "node-gtts";
import { PassThrough } from "stream";

/* Map of guildId → { connection, player, channelId } */
const voiceConnections = new Map();

/* Split long text at sentence boundaries for Google TTS chunk limit */
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

/* Create a TTS audio stream using Google Translate TTS (no API key needed) */
function ttsStream(text) {
  const tts = new gtts("en");
  const pass = new PassThrough();
  tts.stream(text).pipe(pass);
  return pass;
}

/* Join a voice channel — returns the voice state for this guild */
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

/* Leave the voice channel in a guild */
export function leaveChannel(guildId) {
  const state = voiceConnections.get(guildId);
  if (!state) return false;
  state.connection.destroy();
  voiceConnections.delete(guildId);
  console.log(`[Voice] Left voice channel in guild ${guildId}`);
  return true;
}

/* Check if Athena is currently in a voice channel in this guild */
export function isInVoice(guildId) {
  return voiceConnections.has(guildId);
}

/* Get the voice channel ID Athena is currently in for this guild */
export function getVoiceChannelId(guildId) {
  return voiceConnections.get(guildId)?.channelId ?? null;
}

/* Speak text in a voice channel — joins if not already there
   Returns true on success, false on failure */
export async function speak(guild, voiceChannel, text) {
  try {
    const state = await joinChannel(guild, voiceChannel);
    const chunks = splitText(text);

    for (const chunk of chunks) {
      await new Promise((resolve) => {
        const stream = ttsStream(chunk);
        const resource = createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
        });

        state.player.play(resource);

        const onIdle = () => {
          state.player.removeListener("error", onError);
          resolve();
        };
        const onError = (err) => {
          console.error("[Voice] Playback error:", err.message);
          state.player.removeListener(AudioPlayerStatus.Idle, onIdle);
          resolve();
        };

        state.player.once(AudioPlayerStatus.Idle, onIdle);
        state.player.once("error", onError);
      });
    }
    return true;
  } catch (err) {
    console.error("[Voice] speak() failed:", err.message);
    return false;
  }
}
