import { joinVoiceChannel, entersState, VoiceConnectionStatus } 
from "@discordjs/voice";

export async function joinVoice(member) {

  const channel = member.voice.channel;
  if (!channel) return null;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    console.log("✅ Athena joined voice channel");
    return connection;
  } catch (error) {
    connection.destroy();
    console.error("Voice connection failed:", error);
    return null;
  }
}
