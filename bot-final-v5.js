// 1. IMMEDIATELY handle environment and credentials before ANY other imports
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load .env for local development
if (fs.existsSync(".env")) {
  require("dotenv").config();
}

// 2. CRITICAL: Set up the Service Account file for BOTH Firebase and Genkit
const serviceAccountPath = "/tmp/serviceAccountKey.json";
if (process.env.FIREBASE_CREDENTIALS) {
  try {
    // Write the credentials to a file
    fs.writeFileSync(serviceAccountPath, process.env.FIREBASE_CREDENTIALS);
    // Tell ALL Google libraries (Firebase & Genkit) to use this file
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
    console.log("[System] Credentials file created and path set.");
  } catch (err) {
    console.error("[System] Failed to write credentials file:", err.message);
  }
}

// 3. Now it is safe to import Firebase and Genkit
// We use ESM imports for everything to avoid SyntaxErrors with "type": "module"
import admin from "firebase-admin";
import { Client, GatewayIntentBits, Events, Partials } from "discord.js";
import { enableFirebaseTelemetry } from "@genkit-ai/firebase";
import { googleAI } from '@genkit-ai/googleai';
import { genkit } from 'genkit';

// 4. Initialize Firebase
try {
  // Since we are in ESM, we read the file manually instead of using require()
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
  });
  console.log("[Firebase] Initialized successfully.");
} catch (err) {
  console.error("[Firebase] Initialization error:", err.message);
}

// 5. Initialize Genkit (Upgraded to Gemini 2.5 Pro)
const ai = genkit({
  plugins: [
    googleAI({
      apiKey: process.env.GOOGLE_GENAI_API_KEY
    })
  ],
  // Using direct string to bypass version checks in Genkit 0.9.0
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

// Run initial test flow
helloFlow('Chris');

// 6. Discord Bot Logic
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

client.on(Events.ClientReady, () => {
  console.log(`[Discord] Athena online as ${client.user.tag}`);
});

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
