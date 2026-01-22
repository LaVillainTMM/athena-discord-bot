const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function main() {
  const url = 'https://example.com';
  const response = await fetch(url);
  const data = await response.json();
  console.log(data);

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
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

// ==========================
// Athena System Prompt
// ==========================
const ATHENA_SYSTEM_PROMPT = `
You are ATHENA, an intelligent, calm, wise AI advisor.
You speak naturally, confidently, and with empathy.
You do not claim false memory unless it is provided.
You are helpful, thoughtful, and precise.
`;

// ==========================
// In-Memory Conversation Cache
// ==========================
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ==========================
// Knowledge Base Cache
// ==========================
let cachedKnowledge = [];

// ==========================
// Load Knowledge Base
// ==========================
async function getKnowledgeBase() {
  if (!db) return cachedKnowledge;

  try {
    const snapshot = await db.collection('athena_knowledge').get();
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

// ==========================
// Sync Discord User → Firestore
// ==========================
async function syncUserRoleToFirebase(member) {
  if (!db) return;

  try {
    const username = member.user.username;
    const nationRole = member.roles.cache.find(r =>
      r.name.startsWith('Nation:')
    );

    const nation = nationRole ? nationRole.name.replace('Nation:', '').trim() : null;

    const docRef = db.collection('discord_users').doc(username);
    const existingDoc = await docRef.get();

    await docRef.set({
      discordId: member.user.id,
      username,
      nation,
      quizCompleted: true,
      syncedFromDiscord: true,
      completedAt: existingDoc.exists
        ? existingDoc.data().completedAt
        : admin.firestore.FieldValue.serverTimestamp(),
      lastSynced: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[Firestore] Synced ${username}`);
  } catch (error) {
    console.error('[Firestore] Sync error:', error.message);
  }
}

// ==========================
// OpenAI Call
// ==========================
async function getAthenaResponse(userId, userMessage) {
  const history = conversationHistory.get(userId) || [];
  const knowledge = await getKnowledgeBase();

  const messages = [
    { role: 'system', content: ATHENA_SYSTEM_PROMPT },
    ...(knowledge.length ? [{
      role: 'system',
      content: `Known verified information:\n${knowledge.join('\n')}`
    }] : []),
    ...history,
    { role: 'user', content: userMessage }
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || 'I’m not sure how to respond to that.';

  const updatedHistory = [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: reply }];
  conversationHistory.set(userId, updatedHistory.slice(-MAX_HISTORY));

  return reply;
}

// ==========================
// Discord Events
// ==========================
client.once(Events.ClientReady, async () => {
  console.log(`Athena online as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'watching over the nations', type: ActivityType.Watching }],
    status: 'online',
  });

  await getKnowledgeBase();
});

client.on(Events.GuildMemberUpdate, async (_, newMember) => {
  await syncUserRoleToFirebase(newMember);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const clean = message.content.replace(/<@!?\\d+>/g, '').trim();
  if (!clean) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(message.author.id, clean);
    await message.reply(reply);
  } catch (error) {
    console.error('Athena reply error:', error.message);
    await message.reply('Something went wrong while thinking. Please try again.');
  }
});

// ==========================
// Login
// ==========================
client.login(DISCORD_TOKEN);

async function syncUserRoleToFirebase(member) {
  if (!db) return;

  const nation = getMemberNation(member);
  if (!nation) return;

  const username = member.user.username.toLowerCase();

  try {
    const docRef = db.collection('discord_users').doc(username);
const existingDoc = await docRef.get();

await docRef.set({
  discordId: member.user.id,
  username: member.user.username,
  nation,
  quizCompleted: true,
  syncedFromDiscord: true,
  completedAt: existingDoc.exists
    ? existingDoc.data().completedAt
    : admin.firestore.FieldValue.serverTimestamp(),
  lastSynced: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });


    console.log(`[Firestore] Synced ${member.user.username} → ${nation}`);
  } catch (error) {
    console.error('[Firestore] Sync error:', error.message);
  }
}

/* ─────────── KNOWLEDGE BASE ─────────── */

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
