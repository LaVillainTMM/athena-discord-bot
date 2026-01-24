// bot.js — CLEAN, SAFE, RAILWAY-READY

import "dotenv/config";
import admin from "firebase-admin";
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  ChannelType
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getOrCreateAthenaUser } from "./athenaUser.js";



if (!member.roles.cache.some(r => r.name.endsWith("NationZ"))) {
  await member.send(
    "You must complete the DBI Quiz to gain full access to the server."
  );
}



/* ---------------- ENV VALIDATION ---------------- */

if (!process.env.FIREBASE_SERVICE_ACCOUNT)
  throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
if (!process.env.DISCORD_TOKEN)
  throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY)
  throw new Error("GOOGLE_GENAI_API_KEY missing");

/* ---------------- FIREBASE INIT ---------------- */

import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, "\n")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}


/* ---------------- GEMINI INIT ---------------- */

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction:
    "You are ATHENA — calm, intelligent, disciplined, and authoritative. You guide users with clarity and purpose."
});

/* ---------------- FIRESTORE MEMORY ---------------- */



client.on("guildMemberAdd", async member => {
  if (!member.roles.cache.some(r => r.name.endsWith("Z"))) {
    await member.send(
      "Welcome. You must complete the DBI Quiz to access the server."
    );
  }
});



const runQuiz = require("./quiz/quizRunner");
const assignRole = require("./quiz/roleAssigner");

client.on("messageCreate", async message => {
  if (message.content === "!start-quiz") {
    const answers = await runQuiz(message.author);
    const roleName = assignRole(answers);

    const role = message.guild.roles.cache.find(
      r => r.name === roleName
    );

    const member = await message.guild.members.fetch(message.author.id);
    await member.roles.add(role);

    await message.author.send(
      `Quiz complete. You have been assigned to **${roleName}**.`
    );
  }
});


async function loadConversation(athenaUserId) {
  const snap = await firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("messages")
    .orderBy("ts", "asc")
    .limit(20)
    .get();

  return snap.docs.map(d => d.data());
}

async function saveMessage(athenaUserId, role, content) {
  await firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("messages")
    .add({
      role,
      content,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
}

/* ---------------- AI RESPONSE ---------------- */

async function getAthenaResponse(content, athenaUserId) {
  const history = await loadConversation(athenaUserId);

  const chat = model.startChat({
    history: history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }))
  });

  const result = await chat.sendMessage(content);
  const reply = result.response.text();

  await saveMessage(athenaUserId, "user", content);
  await saveMessage(athenaUserId, "assistant", reply);

  return reply;
}

/* ---------------- DISCORD CLIENT ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* ---------------- EVENTS ---------------- */

client.once(Events.ClientReady, () => {
  console.log(`[Athena] Online as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");
  if (!isDM && !mentionsAthena) return;

  const athenaUserId = await getOrCreateAthenaUser(message.author);

  await message.channel.sendTyping();
  const reply = await getAthenaResponse(message.content, athenaUserId);
  await message.reply(reply);
});

/* ---------------- LOGIN ---------------- */

client.login(process.env.DISCORD_TOKEN);
