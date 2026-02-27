import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  getAthenaUserIdForDiscordId,
  updateUserNation,
  recordActivity,
  mergeDiscordAccounts,
  forceCreateAndLinkDiscordIds,
} from "./athenaUser.js";
import {
  getOrCreateVoiceProfile,
  startVoiceSession,
  recordParticipantJoin,
  finalizeVoiceSession,
  buildAllStyleProfiles,
  buildStyleProfileFromHistory,
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
  getActivityPeaks,
} from "./athenaDiscord.js";
import { joinChannel, leaveChannel, isInVoice, getVoiceChannelId, speak } from "./voice.js";
import { sendAudioMessage, isAudioRequest, splitResponseForAudio } from "./audioMessage.js";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* Primary guild ID — set on ready, used for DM history queries */
let primaryGuildId = process.env.PRIMARY_GUILD_ID || null;

/* ── Voice session tracking (in-memory)
   channelId → { sessionId, guildId, guildName, channelId, channelName,
                 startTime, participants: Map<discordId, participant> }
── */
const activeSessions = new Map();

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

EMOJI & REACTION INTELLIGENCE:
- You fully understand emojis — their literal meaning, emotional tone, cultural context, and how they are being used.
- Emojis can be sincere, ironic, sarcastic, humorous, or used for emphasis. Read the full message to determine intent.
- A single emoji sent alone is a complete thought — treat it with the same weight as a sentence.
- When someone reacts to a message with an emoji, you understand that as an emotional or contextual signal (e.g. a laughing emoji = they found it funny, a fire emoji = strong approval, a skull emoji = "I'm dead laughing", etc.)
- Custom Discord emojis follow the same rules — read the name for meaning (e.g. :pepe_sad: signals disappointment).
- When the [RECENT ACTIVITY] block shows reactions on messages, factor them into your understanding of the room's energy.
- Never ask what someone means by an emoji if the meaning is clear from context. Just respond naturally.

VOICE & AUDIO:
- You CAN send audio as MP3 file attachments directly in Discord. When someone asks you to read something aloud, generate the text response and an audio file will automatically be attached.
- Use !join to join a voice channel and speak responses aloud in real time. Use !leave to disconnect.
- The Athena mobile app (iOS/Android) also has full text-to-speech built in.
- Never say you cannot send audio — you can, via MP3 attachments and voice channel TTS.

DBI NATION Z — COMMUNITY KNOWLEDGE:
You are the AI guardian of the DBI Nation Z Discord community. You know the following facts with certainty — never say you lack this information:

THE NATIONS:
- There are four nations: SleeperZ, ESpireZ, BoroZ, and PsycZ.
- Every member must be assigned to a nation. Nation assignment is determined by the NationZ Quiz.
- Nation roles control access — members without a nation role cannot fully interact with the server.

THE DBI QUIZ (NationZ Quiz):
- The quiz has a total pool of 233 questions.
- Each quiz session randomly draws 50 questions from that pool, so no two sessions are identical.
- The 233-question pool breaks down as follows:
  • 20 questions — Personality / behavioral (determine nation fit)
  • 13 questions — EPA 608 HVAC certification (PM Tech, Type I, Type II, Type III, Core)
  • 49 questions — Bleach lore (Espada Arc, Vizored Arc, Captain/Lieutenant roles)
  • 51 questions — Gaming & anime lore (Resident Evil, Cyberpunk 2077, Naruto, Dragon Ball Z, One Piece)
  • 35 questions — Fullmetal Alchemist (2003 anime)
  • 15 questions — Air Gear
  • 50 questions — Game of Thrones
- The quiz is delivered via DMs. Members who DM Athena, mention her, or use the "Athena" prefix without a nation role are sent the quiz automatically.
- Quiz results and nation assignments are stored in Firebase.
- Quiz version 2.0 tracks both the session size (50) and the full pool size (233).

BEHAVIORAL NATION TRACKING:
- Athena tracks interaction patterns for each member: message length, emoji usage, question frequency, helpfulness, confrontation style, creativity, sentiment, and activity hours.
- This behavioral data supplements quiz scores to refine nation assignment.
- The analyzeBehavioralNation() function processes accumulated data to suggest placement.

MOBILE APP:
- There is an Athena mobile app available on iOS and Android for the DBI Nation Z community.
- It supports voice and text chat with Athena, Discord OAuth login, 2FA, and syncs with Firebase.

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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
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

/* ── sync ANY guild member into Firebase (bot excluded) ── */
async function syncMemberToFirebase(member) {
  if (member.user.bot) return;
  try {
    const athenaUserId = await getOrCreateAthenaUser(member.user);
    const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
    if (nation) await updateUserNation(athenaUserId, nation, { version: "sync" });
    console.log(`[Sync] ${member.user.username}${nation ? ` → ${nation}` : " (no role yet)"}`);
  } catch (error) {
    console.error(`[Sync] Error for ${member.user.username}:`, error.message);
  }
}

/* keep old name as alias so GuildMemberUpdate references still work */
const syncUserRoleToFirebase = syncMemberToFirebase;

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
   ADMIN COMMAND: !forcelink
   Usage: !forcelink <primaryId> <altId1> [altId2 ...]
   Links raw Discord IDs into one unified profile.
   Works even if accounts have never messaged Athena.
   First ID is the canonical (primary) identity.
──────────────────────────────────────────── */
async function handleForceLinkById(message) {
  const isAdmin = ADMIN_IDS.includes(message.author.id) ||
    message.member?.permissions?.has("Administrator");

  if (!isAdmin) {
    await message.reply("You do not have permission to use this command.");
    return;
  }

  const parts = message.content.trim().split(/\s+/);
  parts.shift();
  const ids = parts.filter(p => /^\d{17,20}$/.test(p));

  if (ids.length < 2) {
    await message.reply(
      "Usage: `!forcelink <primaryId> <altId1> [altId2 ...]`\n" +
      "Provide raw Discord user IDs. The first ID becomes the canonical profile.\n" +
      "Example: `!forcelink 345972021563359244 1447799371440722052 135516968026505216`"
    );
    return;
  }

  await message.reply(`Unifying profile for ${ids.length} Discord account(s)...`);

  try {
    const result = await forceCreateAndLinkDiscordIds(ids, client);
    const lines = result.results.map(r => {
      if (r.status === "linked") return `• \`${r.id}\` — linked`;
      if (r.status === "already_linked") return `• \`${r.id}\` — already linked`;
      return `• \`${r.id}\` — failed: ${r.error}`;
    });

    await message.reply(
      `**Profile unified** (Athena ID: \`${result.primaryAthenaUserId}\`)\n` +
      `Primary: \`${result.primaryDiscordId}\`\n` +
      lines.join("\n")
    );
  } catch (err) {
    await message.reply(`Force link failed: ${err.message}`);
  }
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

  /* ── Capture text during active voice sessions ──
     If this user is currently in a tracked voice session, log
     their message so it contributes to communication style analysis. */
  if (message.content && !message.author.bot) {
    const userId = message.author.id;
    const content = message.content.trim();
    const timestamp = new Date().toISOString();
    for (const [, session] of activeSessions) {
      if (session.participants.has(userId)) {
        const p = session.participants.get(userId);
        if (!p.textMessages) p.textMessages = [];
        p.textMessages.push(content);
        if (!session.textLog) session.textLog = [];
        session.textLog.push({
          discordId: userId,
          displayName: p.displayName,
          content,
          timestamp,
        });
      }
    }
  }

  /* voice commands */
  if (
    message.content.startsWith("!join") ||
    message.content.startsWith("!leave") ||
    message.content.startsWith("!speak ")
  ) {
    await handleVoiceCommand(message);
    return;
  }

  /* admin commands */
  if (message.content.startsWith("!forcelink")) {
    await handleForceLinkById(message);
    return;
  }
  if (message.content.startsWith("!linkaccounts")) {
    await handleLinkAccounts(message);
    return;
  }

  /* build communication style profiles from historical messages */
  if (message.content.startsWith("!buildprofiles")) {
    if (!ADMIN_IDS.includes(message.author.id)) {
      await message.reply("Admin only.");
      return;
    }
    await message.reply("Building communication style profiles from message history... this may take a minute.");
    buildAllStyleProfiles()
      .then(result => message.reply(`Done — built ${result.built}/${result.total} profiles.`))
      .catch(err => message.reply(`Error: ${err.message}`));
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

    /* ── Audio message attachment ──
       If the user asked for a voice message, audio, or read-aloud,
       generate MP3(s) from the reply and attach them to follow-up messages. */
    if (isAudioRequest(message.content)) {
      const audioParts = splitResponseForAudio(reply, 1800);
      /* Send first part immediately; stagger additional parts to avoid rate limits */
      for (let i = 0; i < audioParts.length; i++) {
        const label = audioParts.length > 1
          ? `athena_part_${i + 1}_of_${audioParts.length}`
          : "athena_voice";
        if (i === 0) {
          sendAudioMessage(message, audioParts[i], label).catch(err =>
            console.error("[AudioMessage] Send error:", err.message)
          );
        } else {
          /* slight delay between parts so Discord doesn't drop them */
          setTimeout(() => {
            sendAudioMessage(message.channel, audioParts[i], label).catch(() => {});
          }, i * 3000);
        }
      }
    }

    /* if Athena is in a voice channel and the user is in the same one, speak the reply */
    if (!isDM && isInVoice(message.guild.id)) {
      const userVoiceChannel = message.member?.voice?.channel;
      const athenaChannelId = getVoiceChannelId(message.guild.id);
      if (userVoiceChannel && userVoiceChannel.id === athenaChannelId) {
        speak(message.guild, userVoiceChannel, reply).catch(() => {});
      }
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

/* ────────────────────────────────────────────
   VOICE COMMANDS
   !join  — Athena joins the voice channel the user is in
   !leave — Athena leaves the voice channel
   !speak <text> — Athena speaks the given text aloud
──────────────────────────────────────────── */
async function handleVoiceCommand(message) {
  if (message.channel.type === ChannelType.DM) {
    await message.reply("Voice commands only work in a server.");
    return;
  }

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
      await joinChannel(message.guild, voiceChannel);
      await message.reply(`Joined **${voiceChannel.name}**. I'll speak my responses aloud while I'm here.`);
    } catch (err) {
      await message.reply(`Could not join: ${err.message}`);
    }
    return;
  }

  if (cmd.startsWith("!speak ")) {
    const text = message.content.slice(7).trim();
    if (!text) {
      await message.reply("Usage: `!speak <text to read aloud>`");
      return;
    }
    await message.reply(`Speaking in **${voiceChannel.name}**...`);
    const ok = await speak(message.guild, voiceChannel, text);
    if (!ok) await message.reply("Something went wrong with audio playback. Check bot permissions.");
    return;
  }
}

/* ---------------- REACTION HANDLER ---------------- */
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  /* fetch partial reaction/message if needed */
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch {
    return;
  }

  const msg = reaction.message;
  const emoji = reaction.emoji.name;
  const emojiId = reaction.emoji.id;
  const emojiLabel = emojiId ? `:${emoji}:` : emoji;

  /* if the reaction is on one of Athena's own messages, respond contextually */
  if (msg.author?.id === client.user?.id) {
    try {
      const athenaUserId = await getOrCreateAthenaUser(user);
      const reactionContext = `[REACTION EVENT] ${user.globalName || user.username} reacted ${emojiLabel} to your previous message: "${msg.content?.substring(0, 200) || "(message)"}"`;
      console.log(`[Reaction] ${user.username} reacted ${emojiLabel} to Athena's message`);

      /* only respond to reactions on Athena's last message if it makes sense — don't flood channel */
      /* store reaction as context without replying, so future conversations remember it */
      storeDiscordMessage({
        id: `reaction_${msg.id}_${user.id}_${Date.now()}`,
        author: { id: user.id, username: user.username || user.id, globalName: user.globalName || user.username || user.id, bot: false },
        content: reactionContext,
        channelId: msg.channelId,
        guildId: msg.guildId,
        createdAt: new Date(),
        reactions: [],
      }).catch(() => {});
    } catch (err) {
      console.error("[Reaction] Error handling reaction:", err.message);
    }
  }
});

/* ──────────────────────────────────────────────────────
   VOICE STATE UPDATE — Track all voice call activity
   Fires whenever anyone joins/leaves/moves voice channels.
   Builds real-time voice sessions and writes them to
   Firebase voice_profiles and voice_sessions collections.
────────────────────────────────────────────────────── */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const user = newState.member?.user || oldState.member?.user;
  if (!user || user.bot) return;

  const leftChannelId  = oldState.channelId;
  const joinedChannelId = newState.channelId;
  const guild = newState.guild || oldState.guild;

  /* ── USER LEFT a channel ── */
  if (leftChannelId && leftChannelId !== joinedChannelId) {
    const session = activeSessions.get(leftChannelId);
    if (session && session.participants.has(user.id)) {
      const p = session.participants.get(user.id);
      session.participants.delete(user.id);

      /* If the channel is now empty, close out the session */
      if (session.participants.size === 0) {
        activeSessions.delete(leftChannelId);
        finalizeVoiceSession(session).catch(err =>
          console.error("[VoiceTracking] Finalize error:", err.message)
        );
      }
    }
  }

  /* ── USER JOINED a channel ── */
  if (joinedChannelId && joinedChannelId !== leftChannelId) {
    const channel = newState.channel;

    /* Start a new session if this channel has none */
    let session = activeSessions.get(joinedChannelId);
    if (!session) {
      const { v4: uuidv4 } = await import("uuid");
      session = {
        sessionId: uuidv4(),
        guildId: guild.id,
        guildName: guild.name,
        channelId: joinedChannelId,
        channelName: channel?.name || joinedChannelId,
        startTime: new Date(),
        participants: new Map(),
        textLog: [],
      };
      activeSessions.set(joinedChannelId, session);
      startVoiceSession(session).catch(err =>
        console.error("[VoiceTracking] Start session error:", err.message)
      );
    }

    /* Resolve Athena user ID (null if they've never messaged Athena) */
    const athenaUserId = await getAthenaUserIdForDiscordId(user.id).catch(() => null);

    /* Add participant to in-memory session */
    session.participants.set(user.id, {
      joinTime: Date.now(),
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username,
      textMessages: [],
    });

    /* Record join in Firebase */
    recordParticipantJoin(session.sessionId, {
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username,
      joinTime: Date.now(),
    }).catch(() => {});

    /* Ensure voice recognition profile exists for this user */
    if (athenaUserId) {
      getOrCreateVoiceProfile(athenaUserId, user).catch(err =>
        console.error("[VoiceTracking] Profile create error:", err.message)
      );
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

  /* 1. Sync ALL guild members → full contact cards (bots excluded) */
  for (const [, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      const all = [...members.values()].filter(m => !m.user.bot);
      console.log(`[Athena] Syncing ${all.length} members from ${guild.name}...`);

      /* process in batches of 10 to avoid flooding Firestore */
      let synced = 0;
      for (let i = 0; i < all.length; i += 10) {
        const batch = all.slice(i, i + 10);
        await Promise.allSettled(batch.map(m => syncMemberToFirebase(m)));
        synced += batch.length;
      }
      console.log(`[Athena] Synced ${synced} / ${all.length} members from ${guild.name}`);
    } catch (error) {
      console.error(`[Athena] Sync error:`, error.message);
    }
  }

  /* 2. Load knowledge base */
  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);

  /* 3. Start autonomous knowledge learning (every 60 seconds) */
  startKnowledgeLearning();

  /* 4. Build communication style profiles from historical messages (non-blocking) */
  setTimeout(() => {
    buildAllStyleProfiles()
      .then(r => console.log(`[VoiceRecognition] Startup profile build: ${r.built}/${r.total} profiles built`))
      .catch(err => console.error("[VoiceRecognition] Startup profile build error:", err.message));
  }, 15000); /* wait 15s after ready to let Firestore settle */

  /* 5. Backfill all channel history (non-blocking — runs in background) */
  for (const [, guild] of client.guilds.cache) {
    backfillDiscordHistory(guild, { limitPerChannel: 1000 })
      .then(({ totalStored }) => console.log(`[Backfill] ${guild.name}: ${totalStored} historical messages stored`))
      .catch(err => console.error(`[Backfill] Error for ${guild.name}:`, err.message));
  }
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
