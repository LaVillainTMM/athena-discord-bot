// bot.js
import "dotenv/config";
import { Client, GatewayIntentBits, Events, ChannelType, Partials } from "discord.js";
import { admin, firestore } from "./firebase.js";
import { centralizeAllUsers } from "./centralizeUsers.js";
import { getOrCreateAthenaUser as getOrCreateCentralUser } from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { initKnowledgeUpdater } from "./lib/knowledgeUpdater.js";

/* ---------------- CONSTANTS ---------------- */
const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

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
async function saveMessage(athenaUserId, userMessage, aiResponse, discordTimestamp = null) {
  try {
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: typeof userMessage === "string" ? userMessage : userMessage.content,
      response: aiResponse,
      platform: "discord",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      discordTimestamp: discordTimestamp || (userMessage?.createdAt || new Date()),
      timezone: "UTC"
    });
  } catch (err) {
    console.error("[Save]", err.message);
  }
}

/* ---------------- QUIZ ON JOIN ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    if (member.roles.cache.some(r => NATION_ROLES.includes(r.name))) return;

    await member.send("Welcome to DBI. Please complete the entrance quiz.");
    await getOrCreateCentralUser("discord", member.user.id, member.user.username);

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (role) await member.roles.add(role);
    await member.send(`Quiz complete. You are **${roleName}**.`);
  } catch (err) {
    console.error("Quiz error", err);
  }
});

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM || message.channel.type === ChannelType.GroupDM;
  const mentioned = message.content.toLowerCase().includes("athena");

  if (!isDM && !mentioned) return;

  try {
    const athenaUserId = await getOrCreateCentralUser("discord", message.author.id, message.author.username);
    await message.channel.sendTyping();

    // Get AI response (Gemini or your generative AI)
    const reply = `AI response placeholder for: ${message.content}`;

    if (reply.length > 2000) {
      const parts = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const p of parts) await message.reply(p);
    } else {
      await message.reply(reply);
    }

    await saveMessage(athenaUserId, message, reply);

  } catch (err) {
    console.error("[Message Error]", err);
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  await centralizeAllUsers();

  // Init background knowledge updater
  await initKnowledgeUpdater(firestore, {
    collection: "athena_knowledge",
    intervalMs: 5 * 60 * 1000
  });

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
