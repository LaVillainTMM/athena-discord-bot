// 1. Environment and Credentials Setup
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

if (fs.existsSync(".env")) {
  require("dotenv").config();
}

const serviceAccountPath = "/tmp/serviceAccountKey.json";
if (process.env.FIREBASE_CREDENTIALS) {
  try {
    fs.writeFileSync(serviceAccountPath, process.env.FIREBASE_CREDENTIALS);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  } catch (err) {
    console.error("[System] Failed to write credentials file:", err.message);
  }
}

// 2. Imports
import admin from "firebase-admin";
import { Client, GatewayIntentBits, Events, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 3. Initialize Firebase
try {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
  });
  console.log("[Firebase] Initialized successfully.");
} catch (err) {
  console.error("[Firebase] Initialization error:", err.message);
}

// 4. Initialize Google Generative AI (Official SDK)
// This replaces Genkit and will NOT block new model names
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-pro",
  systemInstruction: "You are ATHENA, an intelligent, calm, wise advisor. You speak naturally, confidently, and with empathy. You are helpful, thoughtful, and precise."
});

// 5. Discord Bot Logic
const db = admin.firestore();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const conversationHistory = new Map();

async function getAthenaResponse(userMessage, userId) {
  const history = conversationHistory.get(userId) || [];
  
  try {
    // Start a chat session with history
    const chat = model.startChat({
      history: history.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })),
    });

    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();

    // Update local history
    const updatedHistory = [
      ...history, 
      { role: "user", content: userMessage }, 
      { role: "assistant", content: reply }
    ];
    conversationHistory.set(userId, updatedHistory.slice(-20)); 
    
    return reply;
  } catch (error) {
    console.error("[Gemini SDK] Error:", error.message);
    return "I'm having trouble thinking right now. (Gemini SDK Error)";
  }
}

client.on(Events.ClientReady, () => {
  console.log(`[Discord] Athena online as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  
  // Respond if DM or if "athena" is mentioned
  const isDM = message.channel.type === 1;
  const mentionsAthena = message.content.toLowerCase().includes("athena");
  
  if (!isDM && !mentionsAthena) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(message.content, message.author.id);
    await message.reply(reply);
  } catch (error) {
    console.error("[Discord] Error:", error.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
