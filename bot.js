import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { startAthenaCognitiveCore } from "./core/athenaCognitiveCore.js";

import {
  joinChannel,
  leaveChannel,
  isInVoice,
  speak,
  startListeningInChannel
} from "./voice.js";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";

import {
  getOrCreateAthenaUser,
  getAthenaUserIdForDiscordId,
  updateUserNation,
  recordActivity,
  mergeDiscordAccounts,
  forceCreateAndLinkDiscordIds
} from "./athenaUser.js";

import {
  getOrCreateVoiceProfile,
  startVoiceSession,
  recordParticipantJoin,
  finalizeVoiceSession,
  buildAllStyleProfiles,
  buildStyleProfileFromHistory,
  getRecentVoiceSessions,
  formatVoiceSessionsForContext
} from "./voiceRecognition.js";

import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";

import { getKnowledgeBase, startKnowledgeLearning } from "./knowledgeAPI.js";

import {
  storeDiscordMessage,
  backfillDiscordHistory,
  getRecentChannelContext,
  buildServerContext,
  getKnownChannels,
  getActivityPeaks
} from "./athenaDiscord.js";

import {
  sendAudioMessage,
  isAudioRequest,
  splitResponseForAudio
} from "./audioMessage.js";

import {
  syncLatestDojPressReleases,
  searchAndStoreDoj,
  getDojKnowledgeSummary
} from "./lib/dojKnowledge.js";

import {
  storeMemberVisualProfile,
  identifyMembersInImage
} from "./visualIdentity.js";


if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

client.once(Events.ClientReady, async () => {
  console.log(`Athena online as ${client.user.tag}`);

  startAthenaCognitiveCore(10);

  try {
    await getKnowledgeBase();
    startKnowledgeLearning();
  } catch (err) {
    console.error("Knowledge init error:", err.message);
  }

  try {
    await syncLatestDojPressReleases();
  } catch {}

  if (!primaryGuildId && client.guilds.cache.size > 0) {
    primaryGuildId = client.guilds.cache.first().id;
  }

  for (const [, guild] of client.guilds.cache) {
    backfillDiscordHistory(guild).catch(() => {});
  }
});


const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

let primaryGuildId = process.env.PRIMARY_GUILD_ID || null;

const activeSessions = new Map();

const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;

  if (message.content.startsWith("!")) {
    await handleCommand(message);
    return;
  }

  try {
    const athenaUserId = await getOrCreateAthenaUser(message.author);

    await storeDiscordMessage({
      id: message.id,
      author: message.author,
      content: message.content,
      channelId: message.channelId,
      guildId: message.guildId,
      createdAt: message.createdAt
    });

    recordActivity(athenaUserId, "message");

  } catch (err) {
    console.error("Message processing error:", err);
  }
});


async function handleCommand(message) {

  const cmd = message.content.trim().toLowerCase();

  if (cmd.startsWith("!leave")) {
    const left = leaveChannel(message.guild.id);
    await message.reply(left ? "I've left the voice channel." : "I wasn't in a voice channel.");
    return;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply("You need to be in a voice channel first.");
    return;
  }

  if (cmd.startsWith("!join")) {
    try {
      const state = await joinChannel(message.guild, voiceChannel);
      const cmdSessionId = activeSessions.get(voiceChannel.id)?.sessionId ?? null;
      startListeningInChannel(state.connection, message.guild, client, cmdSessionId);
      await message.reply(`Joined **${voiceChannel.name}**.`);
    } catch (err) {
      await message.reply(`Could not join: ${err.message}`);
    }
    return;
  }

  if (cmd.startsWith("!speak ")) {
    const text = message.content.slice(7).trim();
    if (!text) {
      await message.reply("Usage: `!speak <text>`");
      return;
    }

    await message.reply(`Speaking in **${voiceChannel.name}**...`);

    const ok = await speak(message.guild, voiceChannel, text);

    if (!ok) await message.reply("Something went wrong with audio playback.");

    return;
  }
}


client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch {
    return;
  }

  const msg = reaction.message;
  const emoji = reaction.emoji.name;

  if (msg.author?.id === client.user?.id) {
    try {
      const athenaUserId = await getOrCreateAthenaUser(user);

      const reactionContext =
        `[REACTION EVENT] ${user.globalName || user.username} reacted ${emoji} to: "${msg.content?.substring(0,200) || "(message)"}"`;

      await storeDiscordMessage({
        id: `reaction_${msg.id}_${user.id}_${Date.now()}`,
        author: user,
        content: reactionContext,
        channelId: msg.channelId,
        guildId: msg.guildId,
        createdAt: new Date()
      });

    } catch (err) {
      console.error("Reaction handler error:", err);
    }
  }
});


client.on(Events.VoiceStateUpdate, async (oldState, newState) => {

  const user = newState.member?.user || oldState.member?.user;
  if (!user || user.bot) return;

  const leftChannelId = oldState.channelId;
  const joinedChannelId = newState.channelId;
  const guild = newState.guild || oldState.guild;

  if (leftChannelId && leftChannelId !== joinedChannelId) {

    const session = activeSessions.get(leftChannelId);

    if (session) {

      session.participants.delete(user.id);

      const leftChannel = oldState.channel;

      const humansRemaining = leftChannel
        ? [...leftChannel.members.values()].filter(m => !m.user.bot).length
        : session.participants.size;

      if (humansRemaining === 0) {
        activeSessions.delete(leftChannelId);

        finalizeVoiceSession(session).catch(err =>
          console.error("Voice finalize error:", err)
        );
      }
    }
  }

  if (joinedChannelId && joinedChannelId !== leftChannelId) {

    const channel = newState.channel;

    let session = activeSessions.get(joinedChannelId);

    if (!session) {

      session = {
        sessionId: crypto.randomUUID(),
        guildId: guild.id,
        guildName: guild.name,
        channelId: joinedChannelId,
        channelName: channel?.name || joinedChannelId,
        startTime: new Date(),
        participants: new Map(),
        textLog: []
      };

      activeSessions.set(joinedChannelId, session);

      startVoiceSession(session).catch(() => {});
    }

    const athenaUserId =
      await getAthenaUserIdForDiscordId(user.id).catch(() => null);

    session.participants.set(user.id, {
      joinTime: Date.now(),
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username
    });

    recordParticipantJoin(session.sessionId, {
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username,
      joinTime: Date.now()
    }).catch(() => {});

    if (athenaUserId) {
      getOrCreateVoiceProfile(athenaUserId, user).catch(() => {});
    }
  }
});


client.login(process.env.DISCORD_TOKEN);
