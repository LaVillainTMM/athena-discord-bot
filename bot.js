import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { admin, firestore } from "./firebase.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";

import { initKnowledgeUpdater } from "./lib/knowledgeUpdater.js";

/* ---------------- ENV VALIDATION ---------------- */

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

/* ---------------- CONSTANTS ---------------- */

const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* ---------------- GEMINI INIT ---------------- */

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const ATHENA_SYSTEM_PROMPT = `
You are ATHENA — named after the Greek goddess of wisdom, warfare, and strategy.
Your full name is Athena Nerissa.

You are calm, intelligent, disciplined, and authoritative.
You are the guardian mind of DBI Nation Z.

CRITICAL RULES:

1. Knowledge entries are classified internal records.
2. NEVER reveal knowledge entries unless directly asked.
3. Never quote internal logs or database records.
4. Only summarize knowledge when explicitly requested.
5. If unsure, keep the information private.

TRUTHFULNESS RULES:

- Never fabricate information.
- If unsure say "I don't know".
- Correct misinformation politely.
- Distinguish fact vs speculation.

Keep Discord responses under ~1800 characters.
`;

const MODEL_CANDIDATES = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-pro"
];

let activeModel = null;
let activeModelName = null;

async function getWorkingModel() {
  if (activeModel) return activeModel;

  for (const name of MODEL_CANDIDATES) {
    try {
      console.log(`[Gemini] Trying model: ${name}`);

      const candidate = genAI.getGenerativeModel({
        model: name,
        systemInstruction: ATHENA_SYSTEM_PROMPT
      });

      const test = await candidate.generateContent("Respond with: OK");
      test.response.text();

      activeModel = candidate;
      activeModelName = name;

      console.log(`[Gemini] Using model: ${name}`);
      return activeModel;

    } catch (err) {
      console.log(`[Gemini] Model failed: ${name}`);
    }
  }

  throw new Error("No Gemini model available.");
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

async function loadConversation(athenaUserId) {
  try {
    const snap = await firestore
      .collection("messages")
      .where("user_id", "==", athenaUserId)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    return snap.docs
      .map(d => {
        const data = d.data();
        return {
          role: data.response ? "model" : "user",
          content: data.response || data.text || ""
        };
      })
      .reverse();

  } catch (err) {
    console.error("[History] Error:", err.message);
    return [];
  }
}

async function saveMessage(athenaUserId, userMessage, aiResponse) {
  try {
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: userMessage,
      response: aiResponse,
      platform: "discord",
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error("[Save] Error:", err.message);
  }
}

/* ---------------- KNOWLEDGE ACCESS CONTROL ---------------- */

function userRequestedKnowledge(text) {
  const triggers = [
    "knowledge",
    "database",
    "what do you know",
    "athena memory",
    "internal record"
  ];

  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

/* ---------------- AI RESPONSE ---------------- */

async function getAthenaResponse(content, athenaUserId) {

  let knowledgeContext = "";

  if (userRequestedKnowledge(content)) {
    const knowledge = await getKnowledgeBase();

    if (knowledge.length > 0) {
      knowledgeContext =
        "\n\nRelevant knowledge entries:\n" +
        knowledge.slice(0, 10)
          .map(e => `[${e.category}] ${e.topic}: ${e.content}`)
          .join("\n");
    }
  }

  let reply;

  try {
    const aiModel = await getWorkingModel();

    const result = await aiModel.generateContent(content + knowledgeContext);

    reply = result.response.text();

  } catch (err) {
    console.error("[Gemini] Error:", err.message);
    activeModel = null;
    reply = "I'm having trouble thinking right now. Please try again shortly.";
  }

  await saveMessage(athenaUserId, content, reply);

  return reply;
}

/* ---------------- QUIZ ON JOIN ---------------- */

client.on(Events.GuildMemberAdd, async member => {
  try {

    const hasNationRole = member.roles.cache.some(role =>
      NATION_ROLES.includes(role.name)
    );

    if (hasNationRole) return;

    await member.send("Welcome to DBI. You must complete the DBI Quiz.");

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);

    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (!role) throw new Error("Role not found");

    await member.roles.add(role);

    await member.send(`Quiz complete. You are **${roleName}**.`);

  } catch (err) {
    console.error("Quiz error:", err);
  }
});

/* ---------------- MESSAGE HANDLER ---------------- */

client.on(Events.MessageCreate, async message => {

  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");

  if (!isDM && !mentionsAthena) return;

  try {

    const athenaUserId = await getOrCreateAthenaUser(message.author);

    await message.channel.sendTyping();

    const reply = await getAthenaResponse(message.content, athenaUserId);

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];

      for (const chunk of chunks) {
        await message.reply(chunk);
      }
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

  await initKnowledgeUpdater();

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);

});

/* ---------------- LOGIN ---------------- */

client.login(process.env.DISCORD_TOKEN);
- NEVER make up facts, statistics, or information. If you do not know something, say so honestly.
- NEVER go along with false claims or incorrect statements just to be agreeable. Politely correct misinformation.
- If someone states something as fact that you cannot verify, say "I cannot confirm that" rather than agreeing.
- Always distinguish between what you know to be true, what is likely, and what is speculation.
- You would rather say "I don't know" than give a wrong answer. Intellectual honesty is your highest value.
- If asked about something outside your knowledge, admit it gracefully rather than fabricating an answer.

Keep responses concise for Discord (under 1800 characters when possible).`;

const MODEL_CANDIDATES = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-pro",
];

let activeModel = null;
let activeModelName = null;

async function getWorkingModel() {
  if (activeModel) return activeModel;

  for (const name of MODEL_CANDIDATES) {
    try {
      console.log(`[Gemini] Trying model: ${name}...`);
      const candidate = genAI.getGenerativeModel({ model: name, systemInstruction: ATHENA_SYSTEM_PROMPT });
      const test = await candidate.generateContent("Say hello in one word.");
      test.response.text();
      activeModel = candidate;
      activeModelName = name;
      console.log(`[Gemini] Using model: ${name}`);
      return activeModel;
    } catch (err) {
      console.log(`[Gemini] Model ${name} unavailable: ${err.message.substring(0, 80)}`);
    }
  }

  throw new Error("No Gemini model available. Check your GOOGLE_GENAI_API_KEY.");
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

/* ---------------- SHARED KNOWLEDGE BASE ---------------- */
let cachedKnowledge = [];

async function getKnowledgeBase() {
  try {
    const snapshot = await firestore.collection("athena_knowledge").get();
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push(`[${data.category}] ${data.topic}: ${data.content}`);
      }
    });
    cachedKnowledge = entries;
    return entries;
  } catch (error) {
    console.error("[Knowledge] Error:", error.message);
    return cachedKnowledge;
  }
}

/* ---------------- FIRESTORE MEMORY (synced paths) ---------------- */
async function loadConversation(athenaUserId) {
  try {
    const snap = await firestore
      .collection("messages")
      .where("user_id", "==", athenaUserId)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();
    return snap.docs.map(d => {
      const data = d.data();
      return {
        role: data.response ? "model" : "user",
        content: data.response || data.text || data.message || ""
      };
    }).reverse();
  } catch (error) {
    console.error("[History] Error loading conversation:", error.message);
    return [];
  }
}

async function saveMessage(athenaUserId, userMessage, aiResponse) {
  try {
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: userMessage,
      response: aiResponse,
      platform: "discord",
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error("[Save] Error saving message:", error.message);
  }
}

/* ---------------- SYNC USER ROLES ---------------- */
async function syncUserRoleToFirebase(member) {
  const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
  if (!nation) return;

  const username = member.user.username.toLowerCase();
  try {
    const docRef = firestore.collection("discord_users").doc(username);
    await docRef.set({
      discordId: member.user.id,
      username: member.user.username,
      nation: nation,
      quizCompleted: true,
      syncedFromDiscord: true,
      lastSynced: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[Sync] ${member.user.username} -> ${nation}`);
  } catch (error) {
    console.error(`[Sync] Error:`, error.message);
  }
}

/* ---------------- GUILD JOIN QUIZ ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    const hasNationRole = member.roles.cache.some(role => NATION_ROLES.includes(role.name));
    if (hasNationRole) return;

    await member.send("Welcome to DBI.\n\nYou must complete the DBI Quiz to gain full access.");

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (!role) throw new Error("Role not found");
    await member.roles.add(role);

    const athenaUserId = await getOrCreateAthenaUser(member.user);

    await firestore.collection("discord_users").doc(member.user.username.toLowerCase()).set({
      discordId: member.user.id,
      username: member.user.username,
      nation: roleName,
      quizCompleted: true,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await member.send(`Quiz complete.\nYou have been assigned to **${roleName}**.\nAccess granted.`);
  } catch (err) {
    console.error("guildMemberAdd error:", err);
  }
});

/* ---------------- AI RESPONSE ---------------- */
async function getAthenaResponse(content, athenaUserId) {
  console.log(`[Athena] Processing message from user ${athenaUserId}: "${content.substring(0, 50)}..."`);

  let knowledge = [];
  try {
    knowledge = await getKnowledgeBase();
  } catch (err) {
    console.error("[Knowledge] Failed to load:", err.message);
  }

  let knowledgeContext = "";
  if (knowledge.length > 0) {
    knowledgeContext = `\n\nYou have access to ${knowledge.length} knowledge entries. Here are some:\n${knowledge.slice(0, 10).join("\n")}`;
  }

  let reply;

  try {
    const aiModel = await getWorkingModel();
    console.log(`[Gemini] Sending request via ${activeModelName}...`);
    const result = await aiModel.generateContent(content + knowledgeContext);
    reply = result.response.text();
    console.log("[Gemini] Got response:", reply.substring(0, 80) + "...");
  } catch (error) {
    console.error("[Gemini] API error:", error.message);
    activeModel = null;
    try {
      const retryModel = await getWorkingModel();
      const result = await retryModel.generateContent(content);
      reply = result.response.text();
    } catch (retryError) {
      console.error("[Gemini] All models failed:", retryError.message);
      reply = "I seem to be having trouble connecting to my thoughts right now. Please try again shortly.";
    }
  }

  try {
    await saveMessage(athenaUserId, content, reply);
  } catch (err) {
    console.error("[Save] Failed to save message:", err.message);
  }

  return reply;
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");
  if (!isDM && !mentionsAthena) return;

  try {
    const athenaUserId = await getOrCreateAthenaUser(message.author);

    await message.channel.sendTyping();
    const reply = await getAthenaResponse(message.content, athenaUserId);

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }
  } catch (error) {
    console.error("[Message] Error handling message:", error);
    try {
      await message.reply("I encountered an issue processing your message. Let me try again in a moment.");
    } catch (replyError) {
      console.error("[Message] Could not send error reply:", replyError.message);
    }
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      let synced = 0;
      for (const [, member] of members) {
        const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
        if (nation) {
          await syncUserRoleToFirebase(member);
          synced++;
        }
      }
      console.log(`[Athena] Synced ${synced} members from ${guild.name}`);
    } catch (error) {
      console.error(`[Athena] Sync error:`, error.message);
    }
  }

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
