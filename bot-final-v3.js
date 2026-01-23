// Load .env file only if it exists (for local development)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

if (fs.existsSync(".env")) {
  require("dotenv").config();
}

// ==========================
// Railway Helper: Create the Service Account File
// ==========================
const serviceAccountPath = "/tmp/serviceAccountKey.json";
if (process.env.FIREBASE_CREDENTIALS) {
  fs.writeFileSync(serviceAccountPath, process.env.FIREBASE_CREDENTIALS);
}

// ==========================
// Firebase Initialization
// ==========================
var admin = require("firebase-admin");
var serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
});

// ==========================
// Genkit & Google AI Integration
// ==========================
const { Client, GatewayIntentBits, Events, Partials } = require("discord.js");
const { enableFirebaseTelemetry } = require("@genkit-ai/firebase");
import { googleAI } from '@genkit-ai/googleai';
import { genkit } from 'genkit';

const ai = genkit({
  plugins: [
    googleAI({
      apiKey: process.env.GOOGLE_GENAI_API_KEY
    })
  ],
  // Using the full string ID to bypass internal registry checks in Genkit 0.9.0
  model: 'googleai/gemini-2.5-pro', 
});

// Define the helloFlow
const helloFlow = ai.defineFlow('helloFlow', async (name) => {
  try {
    console.log(`[Genkit] Starting helloFlow for ${name}...`);
    const { text } = await ai.generate({
      model: 'googleai/gemini-2.5-pro',
      prompt: `Hello Gemini, my name is ${name}`
    });
    console.log("[Genkit Flow Output]:", text);
  } catch (error) {
    console.error("[Genkit Flow Error]:", error.message);
  }
});

helloFlow('Chris');

// ==========================
// Discord & Bot Logic
// ==========================
const db = admin.firestore();
enableFirebaseTelemetry();

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

const ATHENA_SYSTEM_PROMPT = `You are ATHENA, an intelligent, calm, wise advisor.`;
const conversationHistory = new Map();

async function getAthenaResponse(userMessage, userId) {
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
      model: 'googleai/gemini-2.5-pro',
      messages: genkitMessages 
    });
    const reply = response.text;
    const updatedHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
    conversationHistory.set(userId, updatedHistory.slice(-20)); 
    return reply;
  } catch (error) {
    console.error("[Genkit] Error:", error.message);
    return "I'm having trouble thinking right now. (Gemini 2.5 Error)";
  }
}

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.content.toLowerCase().includes("athena") && message.channel.type !== 1) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(message.content, message.author.id);
    await message.reply(reply);
  } catch (error) {
    console.error("[Discord] Error:", error.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
