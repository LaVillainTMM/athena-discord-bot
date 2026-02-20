require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { db, admin } = require("./firebase");
const axios = require("axios");

// =============================
// DISCORD CLIENT
// =============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);
  await logKnowledgeCount();
});

// =============================
// GEMINI FUNCTION
// =============================

async function getGeminiResponse(prompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
      }
    );

    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("[Gemini Error]", error.response?.data || error.message);
    return "I encountered an issue processing that request.";
  }
}

// =============================
// KNOWLEDGE STORAGE
// =============================

async function storeKnowledge(userId, userMessage, botResponse) {
  try {
    await db.collection("knowledge").add({
      userId,
      userMessage,
      botResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[Firestore Write Error]", err);
  }
}

async function logKnowledgeCount() {
  const snapshot = await db.collection("knowledge").get();
  console.log(`[Athena] Knowledge Entries: ${snapshot.size}`);
}

// Auto log every hour
setInterval(logKnowledgeCount, 60 * 60 * 1000);

// =============================
// MESSAGE SPLITTER (Discord 2000 limit)
// =============================

function splitMessage(text, size = 1900) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// =============================
// DBI QUIZ ROUTE
// =============================

async function sendDBIQuiz(message) {
  const snapshot = await db
    .collection("dbi_quiz_questions")
    .orderBy("questionNumber")
    .limit(50)
    .get();

  if (snapshot.empty) {
    return message.reply("The DBI Quiz database is empty.");
  }

  let quizText = "**DBI 50 Question Quiz**\n\n";

  snapshot.forEach((doc) => {
    const data = doc.data();
    quizText += `**${data.questionNumber}.** ${data.question}\n\n`;
  });

  const parts = splitMessage(quizText);

  for (const part of parts) {
    await message.channel.send(part);
  }
}

// =============================
// ROUTER LAYER
// =============================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.toLowerCase();

  console.log(
    `[Athena] Processing message from ${message.author.id}: "${message.content}"`
  );

  // =============================
  // 1️⃣ DBI QUIZ ROUTE (BEFORE GEMINI)
  // =============================
  if (
    content.includes("dbi quiz") ||
    content.includes("50 question") ||
    content.includes("start quiz")
  ) {
    return await sendDBIQuiz(message);
  }

  // =============================
  // 2️⃣ NORMAL AI CHAT
  // =============================
  const response = await getGeminiResponse(message.content);

  await storeKnowledge(message.author.id, message.content, response);

  await message.reply(response);
});

// =============================
// LOGIN
// =============================

client.login(process.env.DISCORD_TOKEN);  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-pro",
];

let activeModel = null;
let activeModelName = null;

async function getWorkingModel() {
  if (activeModel) return activeModel;

  for (const name of MODEL_CANDIDATES) {
    try {
      console.log(`[Gemini] Trying model: ${name}...`);
      const candidate = genAI.getGenerativeModel({ model: name, systemInstruction: ATHENA_SYSTEM_PROMPT });
      const test = await candidate.generateContent("Say hello in one word.");
      test.response.text();
      activeModel = candidate;
      activeModelName = name;
      console.log(`[Gemini] Using model: ${name}`);
      return activeModel;
    } catch (err) {
      console.log(`[Gemini] Model ${name} unavailable: ${err.message.substring(0, 80)}`);
    }
  }

  throw new Error("No Gemini model available. Check your GOOGLE_GENAI_API_KEY.");
}

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

/* ---------------- SHARED KNOWLEDGE BASE ---------------- */
let cachedKnowledge = [];

async function getKnowledgeBase() {
  try {
    const snapshot = await firestore.collection("athena_knowledge").get();
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push(`[${data.category}] ${data.topic}: ${data.content}`);
      }
    });
    cachedKnowledge = entries;
    return entries;
  } catch (error) {
    console.error("[Knowledge] Error:", error.message);
    return cachedKnowledge;
  }
}

/* ---------------- FIRESTORE MEMORY (synced paths) ---------------- */
async function loadConversation(athenaUserId) {
  try {
    const snap = await firestore
      .collection("messages")
      .where("user_id", "==", athenaUserId)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();
    return snap.docs.map(d => {
      const data = d.data();
      return {
        role: data.response ? "model" : "user",
        content: data.response || data.text || data.message || ""
      };
    }).reverse();
  } catch (error) {
    console.error("[History] Error loading conversation:", error.message);
    return [];
  }
}

async function saveMessage(athenaUserId, userMessage, aiResponse) {
  try {
    await firestore.collection("messages").add({
      user_id: athenaUserId,
      text: userMessage,
      response: aiResponse,
      platform: "discord",
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error("[Save] Error saving message:", error.message);
  }
}

/* ---------------- SYNC USER ROLES ---------------- */
async function syncUserRoleToFirebase(member) {
  const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
  if (!nation) return;

  const username = member.user.username.toLowerCase();
  try {
    const docRef = firestore.collection("discord_users").doc(username);
    await docRef.set({
      discordId: member.user.id,
      username: member.user.username,
      nation: nation,
      quizCompleted: true,
      syncedFromDiscord: true,
      lastSynced: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[Sync] ${member.user.username} -> ${nation}`);
  } catch (error) {
    console.error(`[Sync] Error:`, error.message);
  }
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

    const athenaUserId = await getOrCreateAthenaUser(member.user);

    await firestore.collection("discord_users").doc(member.user.username.toLowerCase()).set({
      discordId: member.user.id,
      username: member.user.username,
      nation: roleName,
      quizCompleted: true,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await member.send(`Quiz complete.\nYou have been assigned to **${roleName}**.\nAccess granted.`);
  } catch (err) {
    console.error("guildMemberAdd error:", err);
  }
});

/* ---------------- AI RESPONSE ---------------- */
async function getAthenaResponse(content, athenaUserId) {
  console.log(`[Athena] Processing message from user ${athenaUserId}: "${content.substring(0, 50)}..."`);

  let knowledge = [];
  try {
    knowledge = await getKnowledgeBase();
  } catch (err) {
    console.error("[Knowledge] Failed to load:", err.message);
  }

  let knowledgeContext = "";
  if (knowledge.length > 0) {
    knowledgeContext = `\n\nYou have access to ${knowledge.length} knowledge entries. Here are some:\n${knowledge.slice(0, 10).join("\n")}`;
  }

  let reply;

  try {
    const aiModel = await getWorkingModel();
    console.log(`[Gemini] Sending request via ${activeModelName}...`);
    const result = await aiModel.generateContent(content + knowledgeContext);
    reply = result.response.text();
    console.log("[Gemini] Got response:", reply.substring(0, 80) + "...");
  } catch (error) {
    console.error("[Gemini] API error:", error.message);
    activeModel = null;
    try {
      const retryModel = await getWorkingModel();
      const result = await retryModel.generateContent(content);
      reply = result.response.text();
    } catch (retryError) {
      console.error("[Gemini] All models failed:", retryError.message);
      reply = "I seem to be having trouble connecting to my thoughts right now. Please try again shortly.";
    }
  }

  try {
    await saveMessage(athenaUserId, content, reply);
  } catch (err) {
    console.error("[Save] Failed to save message:", err.message);
  }

  return reply;
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");
  if (!isDM && !mentionsAthena) return;

  try {
    const athenaUserId = await getOrCreateAthenaUser(message.author);

    await message.channel.sendTyping();
    const reply = await getAthenaResponse(message.content, athenaUserId);

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }
  } catch (error) {
    console.error("[Message] Error handling message:", error);
    try {
      await message.reply("I encountered an issue processing your message. Let me try again in a moment.");
    } catch (replyError) {
      console.error("[Message] Could not send error reply:", replyError.message);
    }
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      let synced = 0;
      for (const [, member] of members) {
        const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
        if (nation) {
          await syncUserRoleToFirebase(member);
          synced++;
        }
      }
      console.log(`[Athena] Synced ${synced} members from ${guild.name}`);
    } catch (error) {
      console.error(`[Athena] Sync error:`, error.message);
    }
  }

  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
