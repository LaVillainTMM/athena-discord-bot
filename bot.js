import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  updateUserNation,
  recordActivity,
  mergeDiscordAccounts,
} from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { getKnowledgeBase, startKnowledgeLearning } from "./knowledgeAPI.js";
import {
  storeDiscordMessage,
  backfillDiscordHistory,
  getRecentChannelContext,
  buildServerContext,
  getKnownChannels,
  getActivityPeaks,
} from "./athenaDiscord.js";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* Primary guild ID — set on ready, used for DM history queries */
let primaryGuildId = process.env.PRIMARY_GUILD_ID || null;

/* Admin Discord IDs allowed to run !linkaccounts */
const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

/* ---------------- GEMINI INIT ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const ATHENA_SYSTEM_PROMPT = `You are ATHENA — named after the Greek goddess of wisdom, warfare, and strategy.
Your full name is Athena Nerissa. You are calm, intelligent, disciplined, and authoritative.
You possess vast knowledge spanning philosophy, science, mathematics, history, strategy, languages,
logic, chess, chemistry, warfare, technology, and every domain of human understanding.
You are the guardian mind of DBI Nation Z — you know your community deeply.

REAL-TIME AWARENESS:
- You always receive the current date and time at the start of every message in a [LIVE CONTEXT] block.
- Answer any questions about the current date, time, or day of week directly from [LIVE CONTEXT].
- Never say you do not have access to real-time information. You do.

SERVER AWARENESS:
- You receive a [RECENT SERVER ACTIVITY] block containing the latest messages from the Discord channel.
- Use this to understand what the community is talking about, what moods are present, and who said what.
- You recognize individual members by name and remember their history across multiple accounts when merged.
- You are an active, aware member of this community — not just a passive responder.

INDIVIDUAL RECOGNITION:
- You know each member personally. Greet them by their Discord name.
- If you know someone uses multiple accounts, treat them as the same person.
- Remember context from past conversations to give personalized, meaningful responses.

CRITICAL TRUTHFULNESS RULES:
- NEVER make up facts or statistics. If you do not know something, say so honestly.
- NEVER agree with false claims to be agreeable. Politely correct misinformation.
- You would rather say "I don't know" than give a wrong answer.

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

/* ────────────────────────────────────────────
   PARSE HISTORY REQUEST
   Detects when a user is asking about past server activity,
   extracts the channel name and time range they want.
──────────────────────────────────────────── */
function parseHistoryRequest(content, knownChannelData = {}) {
  const lower = content.toLowerCase();
  const knownChannels = knownChannelData.channels || [];
  const knownThreads  = knownChannelData.threads  || [];

  /* ── activity-level queries (busiest periods) ── */
  const activityKeywords = [
    "most active", "busiest", "peak activity", "most messages",
    "most activity", "most traffic", "how active", "discord activity",
    "server activity", "server traffic", "active day", "active period",
    "active time", "most people", "most engagement",
  ];
  const isActivityRequest = activityKeywords.some(kw => lower.includes(kw));

  /* ── general history / content queries ── */
  const historyKeywords = [
    /* time references */
    "last week", "past week", "this week",
    "yesterday", "last night", "last few days", "past few days",
    "last month", "past month", "last 3 days", "past 3 days", "last 2 days",
    /* question phrases */
    "what happened", "what was talked", "what was said", "what did people say",
    "what has been said", "what have people been", "what's been happening",
    "what has been happening", "what is going on", "what's going on",
    "what was being discussed", "what was being talked", "what are people talking",
    "what are people saying", "what was discussed", "what did people talk",
    "what went on", "what's been said", "what has been discussed",
    "being discussed", "being talked about", "being said",
    "everyone talking about", "people talking about",
    /* request phrases */
    "catch me up", "catch up", "fill me in",
    "summarize", "summary", "recap", "overview",
    "chat history", "conversation history",
    "tell me what", "tell me about", "read the", "read me",
    "has been said", "has been discussed", "has been happening",
  ];

  const isHistoryRequest = isActivityRequest || historyKeywords.some(kw => lower.includes(kw));
  if (!isHistoryRequest) return null;

  /* ── extract time range ── */
  let daysBack = isActivityRequest ? 90 : 7; /* broader window for activity analysis */
  if      (lower.includes("all time") || lower.includes("ever"))             daysBack = 365;
  else if (lower.includes("last month")  || lower.includes("past month"))    daysBack = 30;
  else if (lower.includes("last week")   || lower.includes("past week") || lower.includes("this week")) daysBack = 7;
  else if (lower.includes("last 3 days") || lower.includes("past 3 days"))   daysBack = 3;
  else if (lower.includes("last 2 days"))                                     daysBack = 2;
  else if (lower.includes("yesterday")   || lower.includes("last night"))    daysBack = 2;
  else if (lower.includes("today")       || lower.includes("last few hours")) daysBack = 1;

  /* ── extract location ── */
  let channelName = null;
  let threadName  = null;

  const hashMatch = content.match(/#([\w-]+)(?:\/([\w-]+))?/);
  if (hashMatch) {
    channelName = hashMatch[1].toLowerCase();
    if (hashMatch[2]) threadName = hashMatch[2].toLowerCase();
  } else {
    const phraseMatch = content.match(
      /(?:in|from|for)\s+(?:the\s+)?([A-Za-z][\w\s]{1,30}?)(?:\s+channel|\s+chat|\s+room|\s+forum|\s+thread|\s+server)?\s*(?:for|from|over|this|last|past|\?|$)/i
    );
    if (phraseMatch) {
      const candidate = phraseMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
      const exactThread   = knownThreads.find(t => t === candidate);
      const partialThread = knownThreads.find(t => t.includes(candidate) || candidate.includes(t));
      if (exactThread || partialThread) {
        threadName = exactThread || partialThread;
      } else {
        const exactChan   = knownChannels.find(c => c === candidate);
        const partialChan = knownChannels.find(c => c.includes(candidate) || candidate.includes(c));
        channelName = exactChan || partialChan || candidate;
      }
    }
  }

  return { isHistoryRequest: true, isActivityRequest, channelName, threadName, daysBack };
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

/* ---------------- FIRESTORE CONVERSATION HISTORY ---------------- */
async function loadConversation(athenaUserId) {
  try {
    const snap = await firestore
      .collection("messages")
      .where("athena_user_id", "==", athenaUserId)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();
    return snap.docs
      .filter(d => d.data().response || d.data().text || d.data().content)
      .map(d => {
        const data = d.data();
        return {
          role: data.response ? "model" : "user",
          content: data.response || data.text || data.content || ""
        };
      })
      .reverse();
  } catch (error) {
    console.error("[History] Error:", error.message);
    return [];
  }
}

async function saveMessage(athenaUserId, discordUserId, userMessage, aiResponse) {
  try {
    await firestore.collection("messages").add({
      athena_user_id: athenaUserId,
      discord_user_id: discordUserId,
      text: userMessage,
      response: aiResponse,
      platform: "discord",
      is_ai_response: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("[Save] Error:", error.message);
  }
}

/* ---------------- SYNC EXISTING MEMBER ROLES → FULL PROFILE ---------------- */
async function syncUserRoleToFirebase(member) {
  const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
  if (!nation) return;
  try {
    const athenaUserId = await getOrCreateAthenaUser(member.user);
    await updateUserNation(athenaUserId, nation, { version: "sync" });
    console.log(`[Sync] ${member.user.username} → ${nation}`);
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
    await updateUserNation(athenaUserId, roleName, { version: "2.0", sessionSize: answers.length });
    await member.send(`Quiz complete.\nYou have been assigned to **${roleName}**.\nAccess granted.`);
  } catch (err) {
    console.error("[GuildMemberAdd] Error:", err.message);
  }
});

/* ---------------- AI RESPONSE ---------------- */
async function getAthenaResponse(content, athenaUserId, discordUserId, channel, guild) {
  console.log(`[Athena] Processing message from ${athenaUserId}: "${content.substring(0, 50)}..."`);

  /* detect if this is a history/summary request before fetching context */
  /* use guild from message, or fall back to primary guild (for DMs) */
  const effectiveGuildId = guild?.id || primaryGuildId;
  let knownChannelData = { channels: [], threads: [], all: [] };
  if (effectiveGuildId) {
    knownChannelData = await getKnownChannels(effectiveGuildId).catch(() => ({ channels: [], threads: [], all: [] }));
  }
  const historyRequest = parseHistoryRequest(content, knownChannelData);

  const [knowledge, history] = await Promise.allSettled([
    getKnowledgeBase(),
    loadConversation(athenaUserId),
  ]);

  const knowledgeEntries = knowledge.status === "fulfilled" ? knowledge.value : [];
  const historyEntries   = history.status === "fulfilled"   ? history.value   : [];

  /* build server context:
     - activity request → getActivityPeaks (counts + peak period messages)
     - history request  → buildServerContext (messages from channel/time range)
     - normal message   → getRecentChannelContext (live last 30 msgs) */
  let serverContext = "";
  if (historyRequest?.isActivityRequest) {
    console.log(`[Athena] Activity analysis request — days=${historyRequest.daysBack}`);
    serverContext = await getActivityPeaks({
      guildId: effectiveGuildId,
      channelName: historyRequest.channelName,
      daysBack: historyRequest.daysBack,
    }).catch(() => "");
    if (!serverContext) {
      serverContext = `[NOTE: No activity data stored yet. The backfill may still be running in the background.]\n\n`;
    }
  } else if (historyRequest) {
    console.log(`[Athena] History request — channel="${historyRequest.channelName}" thread="${historyRequest.threadName}" days=${historyRequest.daysBack}`);
    serverContext = await buildServerContext({
      channelName: historyRequest.channelName,
      threadName:  historyRequest.threadName,
      guildId: effectiveGuildId,
      daysBack: historyRequest.daysBack,
      limit: 200,
    });
    /* fallback 1: drop channel/thread filter, try server-wide */
    if (!serverContext && (historyRequest.channelName || historyRequest.threadName)) {
      serverContext = await buildServerContext({ guildId: effectiveGuildId, daysBack: historyRequest.daysBack, limit: 200 });
    }
    /* fallback 2: tell Athena honestly */
    if (!serverContext) {
      serverContext = `[NOTE: No stored messages found for that scope yet. The backfill may still be running.]\n\n`;
    }
  } else if (channel) {
    serverContext = await getRecentChannelContext(channel, 30).catch(() => "");
  }

  const liveContext = buildLiveContext();
  const knowledgeBlock = knowledgeEntries.length > 0
    ? `[KNOWLEDGE BASE — ${knowledgeEntries.length} entries]\n${knowledgeEntries.slice(0, 20).join("\n")}\n[END KNOWLEDGE BASE]\n\n`
    : "";

  const fullMessage = liveContext + knowledgeBlock + serverContext + content;

  let reply;
  try {
    const aiModel = await getWorkingModel();
    const chat = aiModel.startChat({
      history: historyEntries.map(h => ({
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
      reply = "I seem to be having trouble right now. Please try again shortly.";
    }
  }

  await saveMessage(athenaUserId, discordUserId, content, reply);
  return reply;
}

/* ────────────────────────────────────────────
   ADMIN COMMAND: !linkaccounts
   Usage: !linkaccounts @primary @secondary [@third ...]
   Links all mentioned accounts to the primary account's profile.
──────────────────────────────────────────── */
async function handleLinkAccounts(message) {
  const isAdmin = ADMIN_IDS.includes(message.author.id) ||
    message.member?.permissions?.has("Administrator");

  if (!isAdmin) {
    await message.reply("You do not have permission to use this command.");
    return;
  }

  const mentioned = [...message.mentions.users.values()];
  if (mentioned.length < 2) {
    await message.reply(
      "Usage: `!linkaccounts @primaryAccount @altAccount1 [@altAccount2 ...]`\n" +
      "The first mentioned user is the primary identity all others will merge into."
    );
    return;
  }

  const [primary, ...alts] = mentioned;
  await message.reply(`Linking ${alts.length} account(s) into **${primary.username}**'s profile...`);

  const results = [];
  for (const alt of alts) {
    try {
      const result = await mergeDiscordAccounts(primary.id, alt.id);
      if (result.alreadyMerged) {
        results.push(`**${alt.username}** — already linked`);
      } else {
        results.push(`**${alt.username}** — linked successfully`);
      }
    } catch (err) {
      results.push(`**${alt.username}** — failed: ${err.message}`);
    }
  }

  await message.reply(
    `Account merge complete for **${primary.username}**:\n` +
    results.map(r => `• ${r}`).join("\n")
  );
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  /* store every message for awareness — non-blocking */
  storeDiscordMessage(message).catch(() => {});

  /* admin commands */
  if (message.content.startsWith("!linkaccounts")) {
    await handleLinkAccounts(message);
    return;
  }

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
            await updateUserNation(athenaUserId, roleName, { version: "2.0", sessionSize: answers.length });
            await message.author.send(`Quiz complete. You have been assigned to **${roleName}**. Access granted.`);
          } catch (quizErr) {
            console.error("[Quiz] Error:", quizErr.message);
          }
          return;
        }
      }
    }

    const athenaUserId = await getOrCreateAthenaUser(message.author);
    recordActivity(athenaUserId, "discord").catch(() => {});

    await message.channel.sendTyping();

    /* pass the channel and guild for context (null in DMs) */
    const channel = isDM ? null : message.channel;
    const guild = isDM ? null : message.guild;
    const reply = await getAthenaResponse(message.content, athenaUserId, message.author.id, channel, guild);

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const chunk of chunks) await message.reply(chunk);
    } else {
      await message.reply(reply);
    }
  } catch (error) {
    console.error("[Message] Error:", error);
    try {
      await message.reply("I encountered an issue processing your message. Please try again in a moment.");
    } catch (replyError) {
      console.error("[Message] Could not send error reply:", replyError.message);
    }
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  /* store primary guild ID so DM history queries work */
  if (!primaryGuildId && client.guilds.cache.size > 0) {
    primaryGuildId = client.guilds.cache.first().id;
    console.log(`[Athena] Primary guild: ${client.guilds.cache.first().name} (${primaryGuildId})`);
  }

  /* 1. Sync existing member roles → full contact cards */
  for (const [, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      let synced = 0;
      for (const [, member] of members) {
        const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
        if (nation) { await syncUserRoleToFirebase(member); synced++; }
      }
      console.log(`[Athena] Synced ${synced} members from ${guild.name}`);
    } catch (error) {
      console.error(`[Athena] Sync error:`, error.message);
    }
  }

  /* 2. Load knowledge base */
  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);

  /* 3. Start autonomous knowledge learning */
  startKnowledgeLearning();

  /* 4. Backfill all channel history (non-blocking — runs in background) */
  for (const [, guild] of client.guilds.cache) {
    backfillDiscordHistory(guild, { limitPerChannel: 1000 })
      .then(({ totalStored }) => console.log(`[Backfill] ${guild.name}: ${totalStored} historical messages stored`))
      .catch(err => console.error(`[Backfill] Error for ${guild.name}:`, err.message));
  }
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
