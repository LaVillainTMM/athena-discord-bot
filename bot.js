
// Load environment variables from .env file
require("dotenv").config();

const admin = require("firebase-admin");
const { Client, GatewayIntentBits, Events, ActivityType } = require("discord.js");

// ==========================
// Environment Variable Check
// ==========================
// Ensure critical environment variables are present before starting.
if (!process.env.DISCORD_TOKEN) {
  console.error("Fatal Error: DISCORD_TOKEN is not defined in your .env file.");
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("Fatal Error: OPENAI_API_KEY is not defined in your .env file.");
  process.exit(1);
}

// ==========================
// Firebase Initialization
// ==========================
let db;
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  db = admin.firestore();
  console.log("[Firebase] Connected successfully (Admin SDK)");
} catch (error) {
  console.error("[Firebase] Admin init failed:", error.message);
  console.log("[Firebase] Bot will run without Firebase sync features.");
}

// ==========================
// Discord Client Initialization
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Ensure this intent is enabled in the Discord Developer Portal
  ],
});

// ==========================
// Athena System Prompt
// ==========================
const ATHENA_SYSTEM_PROMPT = `
You are ATHENA, an intelligent, calm, wise AI advisor.
You speak naturally, confidently, and with empathy.
You do not claim false memory unless it is provided.
You are helpful, thoughtful, and precise.
`;

// ==========================
// In-Memory Caches
// ==========================
const conversationHistory = new Map();
let cachedKnowledge = [];

// ==========================
// Helper Functions
// ==========================

/**
 * Gets the current date and time as a formatted string.
 */
function getCurrentDateTime() {
  return new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Fetches and caches the knowledge base from Firestore.
 */
async function getKnowledgeBase() {
  if (!db) return cachedKnowledge; // Return from cache if DB is not available

  try {
    const snapshot = await db.collection("athena_knowledge").get();
    const knowledge = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        knowledge.push(`[${data.category}] ${data.topic}: ${data.content}`);
      }
    });
    cachedKnowledge = knowledge; // Update cache
    console.log(`[Firestore] Knowledge base loaded with ${cachedKnowledge.length} entries.`);
    return cachedKnowledge;
  } catch (error) {
    console.error("[Firestore] Knowledge base fetch error:", error.message);
    return cachedKnowledge; // Return stale cache on error
  }
}

/**
 * Synchronizes a Discord user's role to a Firestore document.
 */
async function syncUserRoleToFirebase(member) {
  if (!db) return;

  try {
    const username = member.user.username;
    const nationRole = member.roles.cache.find(r => r.name.startsWith("Nation:"));
    const nation = nationRole ? nationRole.name.replace("Nation:", "").trim() : null;

    const docRef = db.collection("discord_users").doc(username);
    const existingDoc = await docRef.get();

    await docRef.set(
      {
        discordId: member.user.id,
        username,
        nation,
        quizCompleted: true,
        syncedFromDiscord: true,
        completedAt:
          existingDoc.exists && existingDoc.data().completedAt
            ? existingDoc.data().completedAt
            : admin.firestore.FieldValue.serverTimestamp(),
        lastSynced: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`[Firestore] Synced user role for ${username}`);
  } catch (error) {
    console.error(`[Firestore] Sync error for user ${member.user.username}:`, error.message);
  }
}

/**
 * Gets a response from the OpenAI API.
 */
async function getAthenaResponse(userMessage, userId) {
  const history = conversationHistory.get(userId) || [];
  const knowledge = await getKnowledgeBase();

  let systemPrompt = `${ATHENA_SYSTEM_PROMPT}\nCurrent date & time: ${getCurrentDateTime()}`;
  if (knowledge.length) {
    systemPrompt += `\n\nKnowledge Base:\n${knowledge.join("\n")}`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20), // Keep the last 20 messages for context
    { role: "user", content: userMessage },
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "I'm not sure how to respond to that.";

    // Update conversation history
    const updatedHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
    conversationHistory.set(userId, updatedHistory.slice(-20));

    return reply;

  } catch (error) {
    console.error("[OpenAI] Error:", error.message);
    return "I encountered an error while trying to think. Please try again later.";
  }
}

// ==========================
// Discord Event Handlers
// ==========================

client.once(Events.ClientReady, async () => {
  console.log(`Athena online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "over the nations", type: ActivityType.Watching }],
    status: "online",
  });
  // Initial load of the knowledge base on startup
  await getKnowledgeBase();
});

client.on(Events.GuildMemberUpdate, async (_, newMember) => {
  await syncUserRoleToFirebase(newMember);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const content = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(content, message.author.id);
    await message.reply(reply);
  } catch (error) {
    console.error("Athena reply error:", error.message);
    await message.reply("Something went wrong while I was thinking. Please try again.");
  }
});

// ==========================
// Login to Discord
// ==========================
console.log("Logging into Discord...");
client.login(process.env.DISCORD_TOKEN);
