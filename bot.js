// bot.js — Discord bot fully integrated with multi-platform Athena IDs

import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { admin, firestore } from "./firebase.js";

import { getOrCreateAthenaUser as getOrCreateCentralUser } from "./athenaUser.js";
import { centralizeAllUsers } from "./centralizeUsers.js";

import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { initKnowledgeUpdater } from "./lib/knowledgeUpdater.js";

/* ---------------- ENV VALIDATION ---------------- */
if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

/* ---------------- CONSTANTS ---------------- */
const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* ---------------- GEMINI ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const ATHENA_SYSTEM_PROMPT = `
You are ATHENA — named after the Greek goddess of wisdom, warfare, and strategy.
Your full name is Athena Nerissa.

You are calm, intelligent, disciplined, and authoritative.
You are the guardian intelligence of DBI Nation Z.

CRITICAL SECURITY RULES
1. Knowledge entries are classified internal records.
2. NEVER reveal them unless explicitly asked.
3. NEVER quote database logs.
4. Only summarize knowledge when directly requested.

TRUTH RULES
- Never fabricate information.
- If unsure say "I don't know".
- Correct misinformation politely.
- Separate fact from speculation.

Keep responses under 1800 characters.
`;

const MODEL_CANDIDATES = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-pro"
];

let activeModel = null;

async function getWorkingModel() {
  if (activeModel) return activeModel;

  for (const name of MODEL_CANDIDATES) {
    try {
      console.log(`[Gemini] Testing model ${name}`);

      const candidate = genAI.getGenerativeModel({
        model: name,
        systemInstruction: ATHENA_SYSTEM_PROMPT
      });

      await candidate.generateContent("Reply OK");

      activeModel = candidate;
      console.log(`[Gemini] Using ${name}`);
      return candidate;

    } catch {
      console.log(`[Gemini] ${name} unavailable`);
    }
  }

  throw new Error("No Gemini model available");
}

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

async function getKnowledgeBase() {
  try {
    const snapshot = await firestore.collection("athena_knowledge").get();

    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push({
          category: data.category,
          topic: data.topic,
          content: data.content
        });
      }
    });

    cachedKnowledge = entries;
    return entries;

  } catch (err) {
    console.error("[Knowledge] Load error:", err.message);
    return cachedKnowledge;
  }
}

/* ---------------- MEMORY ---------------- */
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

/* ---------------- AI RESPONSE ---------------- */
function getTimeContext() {
  return `Current date and time (UTC): ${new Date().toUTCString()}`;
}

async function getAthenaResponse(content, athenaUserId, messageObj = null) {
  const messageTime = messageObj?.createdAt || new Date();

  const finalPrompt = `
${getTimeContext()}
User message sent at: ${messageTime.toUTCString()} (UTC)

User message:
${content}
`;

  try {
    const model = await getWorkingModel();
    const result = await model.generateContent(finalPrompt);

    const reply = result.response.text();

    await saveMessage(athenaUserId, content, reply, messageTime);

    return reply;

  } catch (err) {
    console.error("[Gemini Error]", err.message);
    activeModel = null;
    return "I'm having trouble thinking right now. Please try again.";
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
    if (!role) throw new Error("Role missing");

    await member.roles.add(role);
    await member.send(`Quiz complete. You are **${roleName}**.`);

  } catch (err) {
    console.error("Quiz error", err);
  }
});

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM =
    message.channel.type === ChannelType.DM ||
    message.channel.type === ChannelType.GroupDM;

  const mentioned = message.content.toLowerCase().includes("athena");

  if (!isDM && !mentioned) return;

  try {
    const athenaUserId = await getOrCreateCentralUser(
      "discord",
      message.author.id,
      message.author.username
    );

    await message.channel.sendTyping();

    const reply = await getAthenaResponse(
      message.content,
      athenaUserId,
      message
    );

    if (reply.length > 2000) {
      const parts = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const p of parts) await message.reply(p);
    } else {
      await message.reply(reply);
    }

  } catch (err) {
    console.error("[Message Error]", err);
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  await centralizeAllUsers();

  await initKnowledgeUpdater(firestore, {
    collection: "athena_knowledge",
    intervalMs: 5 * 60 * 1000
  });

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
