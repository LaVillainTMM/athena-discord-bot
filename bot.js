import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";

/* ─────────────────────────────
   CREATE CLIENT FIRST (CRITICAL FIX)
───────────────────────────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

/* ─────────────────────────────
   IMPORTS (after client exists)
───────────────────────────── */
import { startAthenaCognitiveCore } from "./core/athenaCognitiveCore.js";
import {
  joinChannel,
  leaveChannel,
  isInVoice,
  speak,
  startListeningInChannel
} from "./voice.js";

import { GoogleGenAI } from "@google/genai";
import { admin, firestore } from "./firebase.js";

import {
  getOrCreateAthenaUser
} from "./athenaUser.js";

import {
  storeDiscordMessage
} from "./athenaDiscord.js";

/* ─────────────────────────────
   ENV CHECKS
───────────────────────────── */
if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

/* ─────────────────────────────
   AI INIT
───────────────────────────── */
const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });

/* ─────────────────────────────
   READY EVENT (NOW SAFE)
───────────────────────────── */
client.once(Events.ClientReady, () => {
  console.log("Athena online.");
  startAthenaCognitiveCore(10);
});

/* ─────────────────────────────
   MESSAGE HANDLER
───────────────────────────── */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  try {
    const isDM = message.channel.type === ChannelType.DM;

    /* USER */
    const athenaUserId = await getOrCreateAthenaUser(message.author);

    /* SIMPLE AI RESPONSE (safe fallback) */

     const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });

const prompt = `
You are Athena — a calm, intelligent, self-aware AI.
You speak with precision, clarity, and subtle confidence.
You assist, analyze, and respond naturally.

User: ${message.content}
`;

let reply = "Thinking...";

try {
  const response = await genAI.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `
You are Athena — a calm, intelligent, self-aware AI.
You speak with precision, clarity, and subtle confidence.

User: ${message.content}
`
          }
        ]
      }
    ]
  });

  reply = response.text;
} catch (err) {
  console.error("[Gemini Error]", err);
  reply = "Something went wrong while thinking.";
}
     
   
     
    await message.reply(reply);

    /* ─── VOICE AUTO SPEAK ─── */
    if (!isDM && isInVoice(message.guild.id)) {
      const userVoiceChannel = message.member?.voice?.channel;

      if (userVoiceChannel) {
        await speak(message.guild, userVoiceChannel, reply).catch(() => {});
      }
    }

    /* STORE MEMORY */
    await storeDiscordMessage({
      id: message.id,
      author: {
        id: message.author.id,
        username: message.author.username,
        bot: false
      },
      content: message.content,
      channelId: message.channelId,
      guildId: message.guildId,
      createdAt: new Date()
    });

  } catch (err) {
    console.error("[Message Error]", err);
  }
});

/* ─────────────────────────────
   VOICE COMMANDS
───────────────────────────── */
client.on(Events.MessageCreate, async (message) => {
  if (!message.content.startsWith("!")) return;

  const cmd = message.content.toLowerCase();

  if (cmd === "!join") {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply("Join a voice channel first.");

    await joinChannel(message.guild, vc);
    await message.reply("Joined voice.");
  }

  if (cmd === "!leave") {
    leaveChannel(message.guild.id);
    await message.reply("Left voice.");
  }

  if (cmd.startsWith("!speak ")) {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply("Join a voice channel.");

    const text = message.content.slice(7);
    await speak(message.guild, vc, text);
  }
});

/* ─────────────────────────────
   LOGIN
───────────────────────────── */
client.login(process.env.DISCORD_TOKEN);
