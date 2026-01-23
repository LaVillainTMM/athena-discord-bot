// Load .env file only if it exists (for local development)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

if (fs.existsSync(".env")) {
  require("dotenv").config();
}

const admin = require("firebase-admin");
const { Client, GatewayIntentBits, Events, ActivityType, Partials } = require("discord.js");
import { GoogleGenerativeAI } from "@google/generative-ai";

// ==========================
// Google AI Initialization
// ==========================
// Using the new API key provided
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
// Using the explicit model name
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ==========================
// Firebase Initialization
// ==========================
let db;
try {
  const PROJECT_ID = "athenaai-memory"; 
  let firebaseCreds;
  if (process.env.FIREBASE_CREDENTIALS) {
    firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
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
} catch (error) {
  console.error("[Firebase] Initialization failed:", error.message);
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
  partials: [Partials.Channel, Partials.Message, Partials.User],
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

async function syncDetailedUser(member) {
  if (!db) return;
  try {
    const userRef = db.collection("Users").doc(member.user.id);
    const status = member.presence?.clientStatus || {};
    
    await userRef.set({
      phoneNumber: null, 
      legalFirstName: null,
      legalLastName: null,
      preferredReplyType: "text",
      discord_id: member.user.id,
      Discord_Username: member.user.username,
      globalName: member.user.globalName,
      desktopDevice: !!status.desktop,
      mobileDevice: !!status.mobile,
      appDevice: !!status.web,
      voice_profile_id: "lavail_voice",
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    
    console.log(`[Firestore] Synced user profile for ${member.user.username}`);
  } catch (e) {
    console.error("[Firestore] User sync error:", e.message);
  }
}

async function logMessage(userId, platform, userMsg, botResp, timestamp) {
  if (!db) return;
  try {
    const logEntry = {
      content: userMsg,
      response: botResp,
      timestamp: new Date(timestamp),
      savedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    let logField = "Discord_Message_Log";
    if (platform === "Desktop") logField = "Desktop_Message_Log";
    if (platform === "Mobile") logField = "Mobile_Message_Log";
    if (platform === "App") logField = "App_Message_Log";

    const userRef = db.collection("Users").doc(userId);
    await userRef.collection(logField).add(logEntry);
    
    console.log(`[Firestore] Logged ${platform} message for user ${userId}`);
  } catch (e) {
    console.error("[Firestore] Logging error:", e.message);
  }
}

async function getAthenaResponse(userMessage, userId, username, timestamp, platform) {
  const history = conversationHistory.get(userId) || [];
  
  try {
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: ATHENA_SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "I am Athena. I am ready to assist you." }] },
        ...history.map(msg => ({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        }))
      ],
    });

    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();

    const updatedHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
    conversationHistory.set(userId, updatedHistory.slice(-20)); 
    
    await logMessage(userId, platform, userMessage, reply, timestamp);
    
    return reply;
  } catch (error) {
    console.error("[Google AI] Error:", error.message);
    return "I'm having trouble thinking right now. Please check my API connection.";
  }
}

// ==========================
// Discord Event Handlers
// ==========================

client.once(Events.ClientReady, () => {
  console.log(`[Discord] Athena online as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  
  const isDM = message.channel.type === 1;
  const isMentioned = message.mentions.has(client.user);
  const containsName = /\bathena\b/i.test(message.content);
  
  if (!isDM && !isMentioned && !containsName) return;

  if (message.member) await syncDetailedUser(message.member);

  let content = message.content.replace(/<@!?\d+>/g, "").trim();
  content = content.replace(/^athena[,:]?\s*/i, "").trim();
  
  if (!content) return;

  try {
    await message.channel.sendTyping();
    const platform = "Discord"; 
    const reply = await getAthenaResponse(content, message.author.id, message.author.username, message.createdTimestamp, platform);
    await message.reply(reply);
  } catch (error) {
    console.error("[Discord] Reply Error:", error.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
