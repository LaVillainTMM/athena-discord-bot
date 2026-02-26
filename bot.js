// bot.js

import "dotenv/config";
import { knowledgeAPI } from "./knowledgeAPI.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { VertexAI } from "@google-cloud/vertexai";
import { Client, GatewayIntentBits, Events, ChannelType, Partials } from "discord.js";
import { admin, firestore } from "./firebase.js";
import { centralizeAllUsers } from "./centralizeUsers.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { startAutonomousLearning } from "./lib/knowledgeUpdater.js";
import { fetchFact } from "./lib/fetchFact.js";

/* ---------------- CONSTANTS ---------------- */
const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];
const ALLOWED_CHANNELS = ["chat", "questions"];

/* ---------------- DISCORD CLIENT ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ---------------- KNOWLEDGE CACHE ---------------- */
let cachedKnowledge = [];

/* ---------------- GEMINI + VERTEX INIT ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const vertexAI = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: "us-central1"
});

/* ---------------- KNOWLEDGE BASE ---------------- */
async function getKnowledgeBase() {
  try {
    const snapshot = await firestore.collection("athena_knowledge").get();
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push({ category: data.topic || "general", content: data.content });
      }
    });
    cachedKnowledge = entries;
    return entries;
  } catch (err) {
    console.error("[Knowledge] Load error:", err.message);
    return cachedKnowledge;
  }
}

/* ---------------- SAVE MESSAGE ---------------- */
async function saveMessage(athenaUserId, message, aiResponse = null, source = "discord") {
  try {
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: message.content,
      response: aiResponse,
      platform: "discord",
      channel_id: message.channel.id,
      guild_id: message.guild?.id || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      discordTimestamp: message.createdAt || new Date(),
      source
    });
  } catch (err) {
    console.error("[Save] Failed to store message:", err);
  }
}

/* ---------------- QUIZ ON JOIN ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    if (member.roles.cache.some(r => NATION_ROLES.includes(r.name))) return;

    await member.send("Welcome to DBI. Please complete the entrance quiz.");
    await getOrCreateAthenaUser("discord", member.user.id, member.user.username);

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (role) await member.roles.add(role);
    await member.send(`Quiz complete. You are **${roleName}**.`);
  } catch (err) {
    console.error("Quiz error", err);
  }
});

/* ---------------- GENERATIVE AI FUNCTIONS ---------------- */

// Gemini API primary
async function generateGeminiAPIReply(messageContent) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const result = await model.generateContent(`
You are Athena, a wise analytical AI assistant.

Respond intelligently, calmly, and clearly.

User:
${messageContent}`);
    return result.response.text();
  } catch (err) {
    console.error("[Gemini API Error]", err);
    throw err;
  }
}

// Vertex AI fallback
async function generateVertexReply(messageContent) {
  try {
    const model = vertexAI.getGenerativeModel({ model: "gemini-1.5-pro-002" });
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: messageContent }] }
      ]
    });
    return result.response.candidates[0].content.parts[0].text;
  } catch (err) {
    console.error("[Vertex AI Error]", err);
    return "Athena is currently unable to respond.";
  }
}

// Unified function with fallback
async function generateAthenaReply(messageContent) {
  try {
    return await generateGeminiAPIReply(messageContent);
  } catch (err) {
    console.log("⚠️ Gemini API failed, switching to Vertex...");
    return await generateVertexReply(messageContent);
  }
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM || message.channel.type === ChannelType.GroupDM;
  const mentioned = message.mentions.has(client.user);

  if (!isDM && !mentioned && !ALLOWED_CHANNELS.includes(message.channel.name.toLowerCase())) return;

  try {
    const athenaUserId = await getOrCreateAthenaUser("discord", message.author.id, message.author.username);

    // Store user message
    await saveMessage(athenaUserId, message, null, isDM ? "dm" : mentioned ? "mention" : "channel");

    // Typing indicator
    await message.channel.sendTyping();

    // Generate AI reply
    const aiReply = await generateAthenaReply(message.content);

    // Reply in chunks if needed
    if (aiReply.length > 2000) {
      const parts = aiReply.match(/[\s\S]{1,1990}/g) || [aiReply];
      for (const p of parts) await message.reply(p);
    } else {
      await message.reply(aiReply);
    }

    // Store AI response
    await saveMessage(athenaUserId, message, aiReply, isDM ? "dm" : mentioned ? "mention" : "channel");

    // Automatic knowledge detection
    if (message.content.split(" ").length > 5) {
      await knowledgeAPI.storeNewKnowledge({
        title: `Discord Fact from ${message.author.username}`,
        body: message.content,
        sourceUserId: athenaUserId,
        platform: "discord"
      });
    }
  } catch (err) {
    console.error("[Message Error]", err);
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  try {
    await centralizeAllUsers();

    // Start autonomous learning
    startAutonomousLearning(fetchFact);

    // Load cached knowledge
    const knowledge = await getKnowledgeBase();
    console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
  } catch (err) {
    console.error("[READY] Error during setup:", err);
  }
});

/* ---------------- FIREBASE TEST ---------------- */
async function firebaseTest() {
  await fetch(
    "https://athenaai-memory-default-rtdb.firebaseio.com/test_discord.json",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "discord online", time: Date.now() })
    }
  );
}
firebaseTest();

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
