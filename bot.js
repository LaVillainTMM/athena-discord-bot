import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";
import runQuiz from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";



if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");
const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* ---------------- GEMINI INIT ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction: "You are ATHENA — calm, intelligent, disciplined, and authoritative. Your name is Athena Nerissa."
});
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

/* ---------------- FIRESTORE MEMORY ---------------- */

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
/* ---------------- GUILD JOIN QUIZ ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    const hasNationRole = member.roles.cache.some(role => NATION_ROLES.includes(role.name));
    if (hasNationRole) return;

    await member.send("Welcome to DBI.\n\nYou must complete the DBI Quiz to gain full access.");

    const answers = await runQuiz(member.user);
    const roleName = assignRole(answers);
    const role = member.guild.roles.cache.find(r => r.name === roleName);
    if (!role) throw new Error("Role not found");
    await member.roles.add(role);

    await member.send(`Quiz complete.\nYou have been assigned to **${roleName}**.\nAccess granted.`);
  } catch (err) {
    console.error("guildMemberAdd error:", err);
  }
});

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

/* ---------------- MESSAGE HANDLER ---------------- */

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

/* ---------------- READY ---------------- */

client.once(Events.ClientReady, () => {
  console.log(`[Athena] Online as ${client.user.tag}`);
});

/* ---------------- LOGIN ---------------- */

client.login(process.env.DISCORD_TOKEN);
