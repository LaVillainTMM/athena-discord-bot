import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus
} from "@discordjs/voice";

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
    return connection;
  } catch (err) {
    console.error("Voice join failed:", err);
    connection.destroy();
    return null;
  }
}
