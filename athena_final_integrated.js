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
import { googleAI } from '@genkit-ai/googleai';
import { genkit } from 'genkit';

// configure a Genkit instance
const ai = genkit({
  plugins: [googleAI()],
  // FIX: Explicitly use the model string to avoid 404 errors
  model: 'googleai/gemini-1.5-flash', 
});

/**
 * The helloFlow you requested.
 * This is now wrapped in a try-catch to prevent crashes.
 */
const helloFlow = ai.defineFlow('helloFlow', async (name) => {
  try {
    console.log(`[Genkit] Starting helloFlow for ${name}...`);
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
const requiredEnv = ["DISCORD_TOKEN", "GOOGLE_GENAI_API_KEY"];
requiredEnv.forEach(env => {
  if (!process.env[env]) {
    console.error(`Fatal Error: ${env} is not defined.`);
    process.exit(1);
  }
});

// ==========================
// Firebase Initialization
// ==========================
let db;
try {
  // Your specific Project ID from the config you provided
  const PROJECT_ID = "athenaai-memory"; 
  
  let firebaseCreds;
  if (process.env.FIREBASE_CREDENTIALS) {
    firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    console.log("[Firebase] Using credentials from environment variable.");
    
    const credPath = path.join("/tmp", "firebase-credentials.json");
    fs.writeFileSync(credPath, JSON.stringify(firebaseCreds));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
  }

  admin.initializeApp({
    credential: firebaseCreds
      ? admin.credential.cert(firebaseCreds)
      : admin.credential.applicationDefault(),
    projectId: PROJECT_ID,
  });

  db = admin.firestore();
  console.log(`[Firebase] Connected to project: ${PROJECT_ID}`);

  enableFirebaseTelemetry();
  console.log("[Firebase] Genkit telemetry enabled");
} catch (error) {
  console.error("[Firebase] Initialization failed:", error.message);
  console.log("[Firebase] Bot will run without database features.");
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
    GatewayIntentBits.GuildPresences,
  ],
});

const ATHENA_SYSTEM_PROMPT = `
You are ATHENA, an intelligent, calm, wise advisor.
You speak naturally, confidently, and with empathy.
You are helpful, thoughtful, and precise.
`;

const conversationHistory = new Map();

// ==========================
// Helper Functions
// ==========================

async function syncUserToFirebase(member) {
  if (!db) return;
  try {
    const docRef = db.collection("discord_users").doc(member.user.id);
    await docRef.set({
      discordId: member.user.id,
      username: member.user.username,
      globalName: member.user.globalName,
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      appUser: true
    }, { merge: true });
    console.log(`[Firestore] Synced user: ${member.user.username}`);
  } catch (e) {
    console.error("[Firestore] Sync error:", e.message);
  }
}

async function storeMessage(userId, username, userMsg, botResp) {
  if (!db) return;
  try {
    await db.collection("message_history").add({
      userId, username, userMsg, botResp,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("[Firestore] Message log error:", e.message);
  }
}

async function getAthenaResponse(userMessage, userId, username) {
  const history = conversationHistory.get(userId) || [];
  const genkitMessages = [
    { role: 'system', content: [{ text: ATHENA_SYSTEM_PROMPT }] },
    ...history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      content: [{ text: msg.content }]
    })),
    { role: 'user', content: [{ text: userMessage }] }
  ];

  try {
    const response = await ai.generate({
      messages: genkitMessages,
      config: { temperature: 0.7, maxOutputTokens: 500 }
    });

    const reply = response.text;
    const updatedHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
    conversationHistory.set(userId, updatedHistory.slice(-10));
    
    await storeMessage(userId, username, userMessage, reply);
    return reply;
  } catch (error) {
    console.error("[Genkit] Response Error:", error.message);
    return "I'm having trouble thinking right now. Please try again.";
  }
}

// ==========================
// Discord Event Handlers
// ==========================

client.once(Events.ClientReady, () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "over the nations", type: ActivityType.Watching }],
    status: "online",
  });
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  
  const isDM = message.channel.type === 1;
  const isMentioned = message.mentions.has(client.user);
  const containsName = /\bathena\b/i.test(message.content);
  
  if (!isDM && !isMentioned && !containsName) return;

  console.log(`[Discord] Message received from ${message.author.username}`);

  if (message.member) await syncUserToFirebase(message.member);

  let content = message.content.replace(/<@!?\d+>/g, "").trim();
  content = content.replace(/^athena[,:]?\s*/i, "").trim();
  
  if (!content) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(content, message.author.id, message.author.username);
    await message.reply(reply);
  } catch (error) {
    console.error("[Discord] Reply Error:", error.message);
  }
});

console.log("[Discord] Connecting...");
client.login(process.env.DISCORD_TOKEN);
