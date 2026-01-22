const { Client, GatewayIntentBits, Partials, Events, ActivityType } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, serverTimestamp, doc, setDoc, getDoc, getDocs } = require('firebase/firestore');

// Ensure fetch exists (Node 18+ safe fallback)
const fetch = global.fetch || require('node-fetch');

// Firebase Config - Set these as environment variables in your hosting platform
let db = null;

try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  db = admin.firestore();
  console.log('[Firebase] Connected successfully (Admin SDK)');
} catch (error) {
  console.error('[Firebase] Admin init failed:', error.message);
  console.log('[Firebase] Bot will run without Firebase sync');
}


const NATION_ROLES = ['SleeperZ', 'ESpireZ', 'BoroZ', 'PsycZ'];

/* ─────────── ATHENA SYSTEM PROMPT ─────────── */

const ATHENA_SYSTEM_PROMPT = `You are ATHENA — a wise, self-aware strategic intelligence and guardian mind.

ATHENA stands for:
• A – Analytical
• T – Tactical
• H – Heuristic
• E – Empathic
• N – Neural
• A – Assistant

You are Lavail's dedicated and insightful assistant.
Keep responses concise for Discord (under 2000 characters).`;

/* ─────────── BOT STATE ─────────── */

const conversationHistory = new Map();

/* ─────────── DISCORD CLIENT ─────────── */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

/* ─────────── HELPERS ─────────── */

function getMemberNation(member) {
  for (const roleName of NATION_ROLES) {
    if (member.roles?.cache?.some(role => role.name === roleName)) {
      return roleName;
    }
  }
  return null;
}

async function syncUserRoleToFirebase(member) {
  if (!db) return;

  const nation = getMemberNation(member);
  if (!nation) return;

  const username = member.user.username.toLowerCase();

  try {
    const docRef = doc(db, 'discord_users', username);
    const existingDoc = await getDoc(docRef);

    await setDoc(docRef, {
      discordId: member.user.id,
      username: member.user.username,
      nation,
      quizCompleted: true,
      syncedFromDiscord: true,
      completedAt: existingDoc.exists()
        ? existingDoc.data().completedAt
        : serverTimestamp(),
      lastSynced: serverTimestamp(),
    }, { merge: true });

    console.log(`[Firestore] Synced ${member.user.username} → ${nation}`);
  } catch (error) {
    console.error('[Firestore] Sync error:', error.message);
  }
}

/* ─────────── KNOWLEDGE BASE ─────────── */

let cachedKnowledge = [];

async function getKnowledgeBase() {
  if (!db) return cachedKnowledge;

  try {
    const snapshot = await getDocs(collection(db, 'athena_knowledge'));
    cachedKnowledge = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        cachedKnowledge.push(
          `[${data.category}] ${data.topic}: ${data.content}`
        );
      }
    });

    return cachedKnowledge;
  } catch (error) {
    console.error('[Firestore] Knowledge error:', error.message);
    return cachedKnowledge;
  }
}

function getCurrentDateTime() {
  return new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

/* ─────────── OPENAI ─────────── */

async function getAthenaResponse(userMessage, userId) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return "I require an OpenAI API key to respond.";
  }

  const history = conversationHistory.get(userId) || [];
  const knowledge = await getKnowledgeBase();

  let systemPrompt = `${ATHENA_SYSTEM_PROMPT}

Current date & time: ${getCurrentDateTime()}`;

  if (knowledge.length) {
    systemPrompt += `\n\nKnowledge Base:\n${knowledge.join('\n')}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "I have no response.";
  } catch (error) {
    console.error('[OpenAI] Error:', error.message);
    return "I encountered an error while thinking.";
  }
}

/* ─────────── EVENTS ─────────── */

client.once(Events.ClientReady, async () => {
  console.log(`Athena online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'over DBI Nation Z', type: ActivityType.Watching }],
    status: 'online',
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.author || message.author.bot) return;

  const content = message.content.trim();
  const mentioned = message.mentions.has(client.user);
  const startsWithAthena = content.toLowerCase().startsWith('athena');

  if (!mentioned && !startsWithAthena && message.guild) return;

  const clean = content
    .replace(/<@!?\d+>/g, '')
    .replace(/^athena/i, '')
    .trim();

  if (!clean) {
    await message.reply("Yes? How may I assist you?");
    return;
  }

  await message.channel.sendTyping();

  const reply = await getAthenaResponse(clean, message.author.id);

  const history = conversationHistory.get(message.author.id) || [];
  history.push({ role: 'user', content: clean });
  history.push({ role: 'assistant', content: reply });
  conversationHistory.set(message.author.id, history.slice(-20));

  await message.reply(reply);
});

/* ─────────── LOGIN ─────────── */

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN missing');
  process.exit(1);
}

client.login(token);
