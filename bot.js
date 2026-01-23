// Load .env file only if it exists (for local development)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

if (fs.existsSync(".env")) {
  require("dotenv").config();
}

const admin = require("firebase-admin");
const { Client, GatewayIntentBits, Events, ActivityType } = require("discord.js");
const { enableFirebaseTelemetry } = require("@genkit-ai/firebase");

// ==========================
// Genkit & Google AI Integration
// ==========================
import { gemini15Flash, googleAI } from '@genkit-ai/googleai';
import { genkit } from 'genkit';

// configure a Genkit instance
const ai = genkit({
  plugins: [googleAI()],
  model: gemini15Flash, // set default model
});

/**
 * The helloFlow you requested.
 * This is now wrapped in a try-catch to prevent crashes.
 */
const helloFlow = ai.defineFlow('helloFlow', async (name) => {
  try {
    const { text } = await ai.generate(`Hello Gemini, my name is ${name}`);
    console.log("[Genkit Flow Output]:", text);
  } catch (error) {
    console.error("[Genkit Flow Error]:", error.message);
  }
});

// Run the flow as requested in your snippet
helloFlow('Chris');

// ==========================
// Environment Variable Check
// ==========================
if (!process.env.DISCORD_TOKEN) {
  console.error("Fatal Error: DISCORD_TOKEN is not defined.");
  process.exit(1);
}
if (!process.env.GCLOUD_PROJECT) {
  console.error("Fatal Error: GCLOUD_PROJECT is not defined.");
  process.exit(1);
}
if (!process.env.GOOGLE_GENAI_API_KEY) {
  console.error("Fatal Error: GOOGLE_GENAI_API_KEY is not defined.");
  process.exit(1);
}

// ==========================
// Firebase Initialization
// ==========================
let db;
try {
  let firebaseCreds;
  console.log("[DEBUG] FIREBASE_CREDENTIALS exists:", !!process.env.FIREBASE_CREDENTIALS);
  
  if (process.env.FIREBASE_CREDENTIALS) {
    firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    console.log("[DEBUG] Parsed Firebase credentials successfully");
    
    // Write credentials to a temporary file for Genkit to use
    const credPath = path.join("/tmp", "firebase-credentials.json");
    fs.writeFileSync(credPath, JSON.stringify(firebaseCreds));
    console.log("[DEBUG] Wrote credentials to:", credPath);
    
    // Set the environment variable that Genkit looks for
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log("[DEBUG] Set GOOGLE_APPLICATION_CREDENTIALS to:", credPath);
  } else {
    console.log("[DEBUG] FIREBASE_CREDENTIALS not found in environment");
  }

  admin.initializeApp({
    credential: firebaseCreds
      ? admin.credential.cert(firebaseCreds)
      : admin.credential.applicationDefault(),
    projectId: process.env.GCLOUD_PROJECT,
  });

  db = admin.firestore();
  console.log("[Firebase] Connected successfully (Admin SDK)");

  // Enable Genkit telemetry - it will now use the credentials file we created
  enableFirebaseTelemetry();
  console.log("[Firebase] Genkit telemetry enabled");
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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildPresences, // Required for device detection
  ],
});

// ==========================
// Athena System Prompt
// ==========================
const ATHENA_SYSTEM_PROMPT = `
You are ATHENA, an intelligent, calm, wise advisor.
You speak naturally, confidently, and with empathy.
You do not claim any false memories.
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

async function getKnowledgeBase() {
  if (!db) return cachedKnowledge;

  try {
    const snapshot = await db.collection("athena_knowledge").get();
    const knowledge = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        knowledge.push(`[${data.category}] ${data.topic}: ${data.content}`);
      }
    });
    cachedKnowledge = knowledge;
    console.log(`[Firestore] Knowledge base loaded with ${cachedKnowledge.length} entries.`);
    return cachedKnowledge;
  } catch (error) {
    console.error("[Firestore] Knowledge base fetch error:", error.message);
    return cachedKnowledge;
  }
}

/**
 * Enhanced function to sync user data, including device and app info
 */
async function syncUserToFirebase(member, message = null) {
  if (!db) return;

  try {
    const username = member.user.username;
    const nationRole = member.roles.cache.find(r => r.name.startsWith("Nation:"));
    const nation = nationRole ? nationRole.name.replace("Nation:", "").trim() : null;

    // Detect device/client info
    let deviceInfo = "Unknown";
    const presence = member.presence;
    if (presence && presence.clientStatus) {
      deviceInfo = Object.keys(presence.clientStatus).join(", ");
    }

    const docRef = db.collection("discord_users").doc(member.user.id);
    const existingDoc = await docRef.get();

    await docRef.set(
      {
        discordId: member.user.id,
        username,
        globalName: member.user.globalName,
        nation,
        device: deviceInfo,
        appUser: true,
        syncedFromDiscord: true,
        completedAt:
          existingDoc.exists && existingDoc.data().completedAt
            ? existingDoc.data().completedAt
            : admin.firestore.FieldValue.serverTimestamp(),
        lastSynced: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`[Firestore] Synced user data for ${username}`);
  } catch (error) {
    console.error(`[Firestore] Sync error for user ${member.user.username}:`, error.message);
  }
}

/**
 * Stores message history in Firebase
 */
async function storeMessageInFirebase(userId, username, userMessage, botResponse) {
  if (!db) return;

  try {
    await db.collection("message_history").add({
      userId,
      username,
      userMessage,
      botResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      platform: "Discord"
    });
    console.log(`[Firestore] Stored message for ${username}`);
  } catch (error) {
    console.error("[Firestore] Message storage error:", error.message);
  }
}

/**
 * Core AI Response logic using Genkit (Google AI)
 */
async function getAthenaResponse(userMessage, userId, username) {
  const history = conversationHistory.get(userId) || [];
  const knowledge = await getKnowledgeBase();

  let systemPrompt = `${ATHENA_SYSTEM_PROMPT}\nCurrent date & time: ${getCurrentDateTime()}`;
  if (knowledge.length) {
    systemPrompt += `\n\nKnowledge Base:\n${knowledge.join("\n")}`;
  }

  // Convert history to Genkit format
  const genkitMessages = [
    { role: 'system', content: [{ text: systemPrompt }] },
    ...history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      content: [{ text: msg.content }]
    })),
    { role: 'user', content: [{ text: userMessage }] }
  ];

  try {
    // Use Genkit to generate a response
    const response = await ai.generate({
      messages: genkitMessages,
      config: {
        temperature: 0.7,
        maxOutputTokens: 500,
      }
    });

    const reply = response.text;

    // Update in-memory history
    const updatedHistory = [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: reply }
    ];
    conversationHistory.set(userId, updatedHistory.slice(-20));

    // Store in Firebase
    await storeMessageInFirebase(userId, username, userMessage, reply);

    return reply;
  } catch (error) {
    console.error("[Genkit] Error:", error.message);
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
  await getKnowledgeBase();
});

client.on(Events.GuildMemberUpdate, async (_, newMember) => {
  await syncUserToFirebase(newMember);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  
  // In DMs, respond to all messages. In servers, require mention or name
  const isDM = message.channel.type === 1; // 1 = DM channel
  const isMentioned = message.mentions.has(client.user);
  const containsName = /\bathena\b/i.test(message.content);
  
  if (!isDM && !isMentioned && !containsName) return;

  // Sync user data on every interaction
  if (message.member) {
    await syncUserToFirebase(message.member, message);
  }

  // Remove @mentions from content
  let content = message.content.replace(/<@!?\d+>/g, "").trim();
  
  // Remove "Athena" from the beginning if present
  content = content.replace(/^athena[,:]?\s*/i, "").trim();
  
  if (!content) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(content, message.author.id, message.author.username);
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
