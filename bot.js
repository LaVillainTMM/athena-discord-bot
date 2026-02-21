// bot.js
import "dotenv/config";
import { Client, GatewayIntentBits, Events, ChannelType, Partials } from "discord.js";
import { admin, firestore } from "./firebase.js";
import { centralizeAllUsers } from "./centralizeUsers.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { initKnowledgeUpdater } from "./lib/knowledgeUpdater.js";

/* ---------------- CONSTANTS ---------------- */
const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];
const ALLOWED_CHANNELS = ["chat", "questions"]; // channels/categories to track

/* ---------------- DISCORD CLIENT ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ---------------- KNOWLEDGE CACHE ---------------- */
let cachedKnowledge = [];

// ---------------- Load knowledge from athena_knowledge ----------------
async function getKnowledgeBase() {
  try {
    const snapshot = await firestore.collection("athena_knowledge").get();
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push({ category: data.topic || "general", content: data.content });
      }
    });
    cachedKnowledge = entries;
    return entries;
  } catch (err) {
    console.error("[Knowledge] Load error:", err.message);
    return cachedKnowledge;
  }
}

// ---------------- SAVE MESSAGE ----------------
async function saveMessage(athenaUserId, message, aiResponse = null, source = "discord") {
  try {
    // Store in messages only
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: message.content,
      response: aiResponse,
      platform: "discord",
      channel_id: message.channel.id,
      guild_id: message.guild?.id || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      discordTimestamp: message.createdAt || new Date(),
      source
    });
  } catch (err) {
    console.error("[Save] Failed to store message:", err);
  }
}

// ---------------- QUIZ ON JOIN ----------------
client.on(Events.GuildMemberAdd, async member => {
  try {
    if (member.roles.cache.some(r => NATION_ROLES.includes(r.name))) return;

    await member.send("Welcome to DBI. Please complete the entrance quiz.");
    await getOrCreateAthenaUser("discord", member.user.id, member.user.username);

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (role) await member.roles.add(role);
    await member.send(`Quiz complete. You are **${roleName}**.`);
  } catch (err) {
    console.error("Quiz error", err);
  }
});

// ---------------- MESSAGE HANDLER ----------------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM || message.channel.type === ChannelType.GroupDM;
  const mentioned = message.mentions.has(client.user);

  // Only respond to DMs, mentions, or allowed channels
  if (!isDM && !mentioned && !ALLOWED_CHANNELS.includes(message.channel.name.toLowerCase())) return;

  try {
    const athenaUserId = await getOrCreateAthenaUser("discord", message.author.id, message.author.username);

    // Store all messages Athena sees in messages only
    await saveMessage(athenaUserId, message, null, isDM ? "dm" : mentioned ? "mention" : "channel");

    // Typing indicator
    await message.channel.sendTyping();

    // TODO: Replace with your generative AI call (Gemini, etc.)
    const aiReply = `AI response placeholder for: ${message.content}`;

    // Send reply in chunks if too long
    if (aiReply.length > 2000) {
      const parts = aiReply.match(/[\s\S]{1,1990}/g) || [aiReply];
      for (const p of parts) await message.reply(p);
    } else {
      await message.reply(aiReply);
    }

    // Save the AI response along with user message
    await saveMessage(athenaUserId, message, aiReply, isDM ? "dm" : mentioned ? "mention" : "channel");

    // NOTE: Do NOT add messages automatically to knowledge_updates
    // Only add entries there when Athena identifies new knowledge
  } catch (err) {
    console.error("[Message Error]", err);
  }
});

// ---------------- READY ----------------
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  // Centralize all users
  await centralizeAllUsers();

  // Initialize background knowledge updater
  await initKnowledgeUpdater(firestore, {
    collection: "athena_knowledge",
    intervalMs: 5 * 60 * 1000
  });

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
});

// ---------------- LOGIN ----------------
client.login(process.env.DISCORD_TOKEN);
