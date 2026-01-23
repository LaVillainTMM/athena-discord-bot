// bot.js — CLEAN, SAFE, RAILWAY-READY

import "dotenv/config";
import admin from "firebase-admin";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ---------------- FIREBASE INIT ---------------- */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
  });
}

const firestore = admin.firestore();

/* ---------------- GEMINI INIT ---------------- */

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction:
    "You are ATHENA — calm, intelligent, disciplined, and authoritative. You guide users with clarity and purpose."
});

/* ---------------- DISCORD CLIENT ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const conversationHistory = new Map();

/* ---------------- AI RESPONSE ---------------- */

async function getAthenaResponse(content, userId) {
  const history = conversationHistory.get(userId) || [];

  const chat = model.startChat({
    history: history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }))
  });

  const result = await chat.sendMessage(content);
  const reply = result.response.text();

  const updated = [
    ...history,
    { role: "user", content },
    { role: "assistant", content: reply }
  ];

  conversationHistory.set(userId, updated.slice(-20));
  return reply;
}

/* ---------------- EVENTS ---------------- */

client.once(Events.ClientReady, () => {
  console.log(`[Athena] Online as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");

  if (!isDM && !mentionsAthena) return;

  await message.channel.sendTyping();
  const reply = await getAthenaResponse(message.content, message.author.id);
  await message.reply(reply);
});

/* ---------------- LOGIN ---------------- */

client.login(process.env.DISCORD_TOKEN);

import { getOrCreateAthenaUser } from "./athenaUser.js";

