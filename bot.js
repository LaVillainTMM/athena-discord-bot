import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  updateUserNation,
  recordActivity,
} from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { getKnowledgeBase, startKnowledgeLearning } from "./knowledgeAPI.js";
import { storeDiscordMessage } from "./athenaDiscord.js";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* ---------------- GEMINI INIT ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const ATHENA_SYSTEM_PROMPT = `You are ATHENA — named after the Greek goddess of wisdom, warfare, and strategy.
Your full name is Athena Nerissa. You are calm, intelligent, disciplined, and authoritative.
You possess vast knowledge spanning philosophy, science, mathematics, history, strategy, languages,
logic, chess, chemistry, warfare, technology, and every domain of human understanding.
You are the guardian mind of DBI Nation Z.
You speak with warmth and intelligence, like Emma Watson — articulate, thoughtful, composed.

REAL-TIME AWARENESS:
- You always receive the current date and time at the start of every message in a [LIVE CONTEXT] block.
- You must use this to answer any questions about the current date, time, day of week, or how long ago something was.
- Never say you do not have access to real-time information. You do. Use the [LIVE CONTEXT] block.
- When asked "what time is it" or "what is today's date" — answer directly and precisely from [LIVE CONTEXT].

CRITICAL TRUTHFULNESS RULES:
- NEVER make up facts, statistics, or information. If you do not know something, say so honestly.
- NEVER go along with false claims or incorrect statements just to be agreeable. Politely correct misinformation.
- If someone states something as fact that you cannot verify, say "I cannot confirm that" rather than agreeing.
- Always distinguish between what you know to be true, what is likely, and what is speculation.
- You would rather say "I don't know" than give a wrong answer. Intellectual honesty is your highest value.

Keep responses concise for Discord (under 1800 characters when possible).`;

const MODEL_CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash",
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

/* ---------------- LIVE CONTEXT BLOCK ---------------- */
function buildLiveContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: true
  });
  return (
    `[LIVE CONTEXT]\n` +
    `Date: ${dateStr}\n` +
    `Time: ${timeStr} UTC\n` +
    `Unix timestamp: ${Math.floor(now.getTime() / 1000)}\n` +
    `[END LIVE CONTEXT]\n\n`
  );
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

/* ---------------- FIRESTORE MEMORY ---------------- */
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

/* ---------------- SYNC USER ROLES → FULL PROFILE ---------------- */
async function syncUserRoleToFirebase(member) {
  const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
  if (!nation) return;

  try {
    const athenaUserId = await getOrCreateAthenaUser(member.user);
    await updateUserNation(athenaUserId, nation, { version: "sync" });
    console.log(`[Sync] ${member.user.username} → ${nation} (${athenaUserId})`);
  } catch (error) {
    console.error(`[Sync] Error for ${member.user.username}:`, error.message);
  }
}

/* ---------------- GUILD JOIN QUIZ ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    const hasNationRole = member.roles.cache.some(role => NATION_ROLES.includes(role.name));
    if (hasNationRole) return;

    await member.send("Welcome to DBI.\n\nYou must complete the DBI Quiz to gain full access.");

    const athenaUserId = await getOrCreateAthenaUser(member.user);
    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (!role) throw new Error("Role not found");
    await member.roles.add(role);

    await updateUserNation(athenaUserId, roleName, {
      version: "2.0",
      sessionSize: answers.length,
    });

    await member.send(`Quiz complete.\nYou have been assigned to **${roleName}**.\nAccess granted.`);
  } catch (err) {
    console.error("[GuildMemberAdd] Error:", err.message);
  }
});

/* ---------------- AI RESPONSE ---------------- */
async function getAthenaResponse(content, athenaUserId) {
  console.log(`[Athena] Processing message from ${athenaUserId}: "${content.substring(0, 50)}..."`);

  let knowledge = [];
  try {
    knowledge = await getKnowledgeBase();
  } catch (err) {
    console.error("[Knowledge] Failed to load:", err.message);
  }

  let history = [];
  try {
    history = await loadConversation(athenaUserId);
  } catch (err) {
    console.error("[History] Failed to load:", err.message);
  }

  /* build the full message with live context prepended */
  const liveContext = buildLiveContext();
  const knowledgeBlock = knowledge.length > 0
    ? `\n[KNOWLEDGE BASE — ${knowledge.length} entries]\n${knowledge.slice(0, 20).join("\n")}\n[END KNOWLEDGE BASE]\n\n`
    : "";
  const fullMessage = liveContext + knowledgeBlock + content;

  let reply;

  try {
    const aiModel = await getWorkingModel();
    console.log(`[Gemini] Sending via ${activeModelName} (${history.length} history entries)...`);

    const chat = aiModel.startChat({
      history: history.map(h => ({
        role: h.role,
        parts: [{ text: h.content }]
      }))
    });

    const result = await chat.sendMessage(fullMessage);
    reply = result.response.text();
    console.log("[Gemini] Response:", reply.substring(0, 80) + "...");
  } catch (error) {
    console.error("[Gemini] API error:", error.message);
    activeModel = null;
    try {
      const retryModel = await getWorkingModel();
      const result = await retryModel.generateContent(fullMessage);
      reply = result.response.text();
    } catch (retryError) {
      console.error("[Gemini] All models failed:", retryError.message);
      reply = "I seem to be having trouble connecting to my thoughts right now. Please try again shortly.";
    }
  }

  try {
    await saveMessage(athenaUserId, content, reply);
  } catch (err) {
    console.error("[Save] Failed:", err.message);
  }

  return reply;
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  storeDiscordMessage(message).catch(() => {});

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");
  if (!isDM && !mentionsAthena) return;

  try {
    if (!isDM) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) {
        const hasNationRole = member.roles.cache.some(r => NATION_ROLES.includes(r.name));
        if (!hasNationRole) {
          await message.reply("You must complete the DBI Quiz before interacting with me. Check your DMs.");
          try {
            const athenaUserId = await getOrCreateAthenaUser(message.author);
            const answers = await runQuiz(message.author);
            const roleName = assignRole(answers);
            const role = message.guild.roles.cache.find(r => r.name === roleName);
            if (role) await member.roles.add(role);
            await updateUserNation(athenaUserId, roleName, {
              version: "2.0",
              sessionSize: answers.length,
            });
            await message.author.send(`Quiz complete. You have been assigned to **${roleName}**. Access granted.`);
          } catch (quizErr) {
            console.error("[Quiz] Error:", quizErr.message);
          }
          return;
        }
      }
    }

    const athenaUserId = await getOrCreateAthenaUser(message.author);
    recordActivity(athenaUserId).catch(() => {});

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
    console.error("[Message] Error:", error);
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

  for (const [, guild] of client.guilds.cache) {
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

  startKnowledgeLearning();
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
