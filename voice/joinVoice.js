import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus
} from "@discordjs/voice";

/*
  Stores active voice connections
  guildId -> connection
*/
const activeConnections = new Map();

/* ===============================
   JOIN VOICE
================================ */
export async function joinVoice(member) {

  if (!member.voice.channel) return null;

  const connection = joinVoiceChannel({
    channelId: member.voice.channel.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);

    console.log("✅ Athena connected to voice");

    // ✅ Track connection
    activeConnections.set(member.guild.id, connection);

    return connection;

  } catch (err) {
    console.error("Voice join failed:", err);
    connection.destroy();
    return null;
  }
}

/* ===============================
   CHECK VOICE STATUS
================================ */
export function isInVoice(guildId) {
  return activeConnections.has(guildId);
}

/* ===============================
   OPTIONAL: LEAVE VOICE
================================ */
export function leaveVoice(guildId) {
  const connection = activeConnections.get(guildId);

  if (connection) {
    connection.destroy();
    activeConnections.delete(guildId);
    console.log("👋 Athena left voice");
  }
}
