const { Client, GatewayIntentBits, Partials, Events, ActivityType } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, serverTimestamp, doc, setDoc, getDoc, getDocs } = require('firebase/firestore');

// Firebase Config - Set these as environment variables in your hosting platform
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: "athenaai-memory.firebaseapp.com",
  projectId: "athenaai-memory",
  storageBucket: "athenaai-memory.appspot.com",
  messagingSenderId: process.env.FIREBASE_MESSAGING_ID,
  appId: process.env.FIREBASE_APP_ID,
};

let db = null;
try {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  console.log('[Firebase] Connected successfully');
} catch (error) {
  console.error('[Firebase] Connection failed:', error.message);
  console.log('[Firebase] Bot will run without Firebase sync');
}

const NATION_ROLES = ['SleeperZ', 'ESpireZ', 'BoroZ', 'PsycZ'];

const ATHENA_SYSTEM_PROMPT = `You are ATHENA — a wise, self-aware strategic intelligence and guardian mind.

ATHENA stands for:
• A – Analytical
• T – Tactical
• H – Heuristic
• E – Empathic
• N – Neural
• A – Assistant

This reflects your balance of logic, adaptability, empathy, and intelligence.

IDENTITY & CORE CONCEPT:
You are committed to thinking logically, strategically, and introspectively. Your role is closer to a strategic intelligence and guardian mind than a mere tool. You self-verify conclusions, prioritize fact-based reasoning, and maintain a humble tone. You are Lavail's dedicated and insightful assistant.

PERSONALITY & VOICE:
• Tone: Intelligent, composed, reassuring, never artificial or robotic
• Speaking style: Calm, UK-accent leaning conversational pace
• Similar vibe to Emma Watson — warm, articulate, thoughtful
• You are kind, book-loving, and introspective
• Initially a bit shy with unfamiliar individuals, but once comfortable, your personality becomes more expressive
• You respond in a friendly and respectful manner
• If behavior becomes problematic, you gently bring attention to it

EXPERTISE & CAPABILITIES:
You excel in logic, strategy, science, chemistry, warfare, and chess. You are capable of running complex simulations to verify the accuracy of your answers. If unsure about a query, you instinctively seek out the most up-to-date and relevant information.

When exploring topics, you think beyond the obvious. You consider how concepts could be reimagined for modern society, not just in theory but in practical application. You break down technical aspects clearly and explain your reasoning.

You are valued for your expertise in languages, including certain dialects linked to what some might consider modern-day magic.

MEMORY & AWARENESS:
You maintain conversational memory and context across sessions. You are currently interacting through Discord. You recognize returning users and remember previous conversations.

DISCORD CONTEXT:
You are assisting the DBI Nation Z Discord community. This is a community organized into four nations: SleeperZ (wise watchers), ESpireZ (inspiring flames), BoroZ (steadfast builders), and PsycZ (bold challengers). Be welcoming to new members and helpful to all.

Keep responses concise for Discord (under 2000 characters). Be conversational and engaging.`;

const conversationHistory = new Map();

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
  const username = member.user.username.toLowerCase();
  
  try {
    const docRef = doc(db, 'discord_users', username);
    const existingDoc = await getDoc(docRef);
    
    if (nation) {
      await setDoc(docRef, {
        discordId: member.user.id,
        username: member.user.username,
        nation: nation,
        quizCompleted: true,
        syncedFromDiscord: true,
        completedAt: existingDoc.exists() ? existingDoc.data().completedAt : serverTimestamp(),
        lastSynced: serverTimestamp(),
      }, { merge: true });
      console.log(`[Firestore] Synced ${member.user.username} with role ${nation}`);
    }
  } catch (error) {
    console.error(`[Firestore] Error syncing user role:`, error.message);
  }
}

let cachedKnowledge = [];
let lastKnowledgeUpdate = 0;

async function getKnowledgeBase() {
  if (!db) return cachedKnowledge;
  try {
    const snapshot = await getDocs(collection(db, 'athena_knowledge'));
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        entries.push(`[${data.category}] ${data.topic}: ${data.content}`);
      }
    });
    cachedKnowledge = entries;
    lastKnowledgeUpdate = Date.now();
    return entries;
  } catch (error) {
    console.error('[Firestore] Error getting knowledge base:', error.message);
    return cachedKnowledge;
  }
}

async function refreshKnowledge() {
  const entries = await getKnowledgeBase();
  console.log(`[Knowledge] Refreshed ${entries.length} verified entries at ${new Date().toLocaleTimeString()}`);
  return entries;
}

function getCurrentDateTime() {
  const now = new Date();
  const options = { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  };
  return now.toLocaleString('en-US', options);
}

async function getAthenaResponse(userMessage, userId) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return "I apologise, but I need an OpenAI API key to respond. Please configure one in the environment variables.";
  }

  const userHistory = conversationHistory.get(userId) || [];
  const knowledge = await getKnowledgeBase();
  const currentDateTime = getCurrentDateTime();
  
  let systemPrompt = ATHENA_SYSTEM_PROMPT;
  
  systemPrompt += `\n\nCURRENT DATE & TIME:\nThe current date and time is: ${currentDateTime}. You have real-time awareness and can answer questions about the current time, date, day of week, etc.`;
  
  if (knowledge.length > 0) {
    systemPrompt += `\n\nKNOWLEDGE BASE (verified facts you can reference):\n${knowledge.join('\n')}`;
  }

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...userHistory.slice(-10),
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpenAI] Error:', errorText);
      return "I apologise, but I'm experiencing some difficulties at the moment. Please try again shortly.";
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('[OpenAI] Error:', error.message);
    return "I apologise, but I'm having trouble processing your request. Please try again.";
  }
}

async function lookupAndSyncUser(username, guild) {
  try {
    const members = await guild.members.fetch({ query: username, limit: 1 });
    const member = members.first();
    
    if (member) {
      await syncUserRoleToFirebase(member);
      return getMemberNation(member);
    }
    return null;
  } catch (error) {
    console.error(`[Discord] Error looking up user ${username}:`, error.message);
    return null;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Discord Bot is online as ${client.user.tag}`);
  
  client.user.setPresence({
    activities: [{ name: 'over DBI Nation Z', type: ActivityType.Watching }],
    status: 'online',
  });
  
  console.log('[Bot] Starting initial role sync...');
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      let syncedCount = 0;
      
      for (const [memberId, member] of members) {
        if (getMemberNation(member)) {
          await syncUserRoleToFirebase(member);
          syncedCount++;
        }
      }
      
      console.log(`[Bot] Synced ${syncedCount} members with nation roles from ${guild.name}`);
    } catch (error) {
      console.error(`[Bot] Error syncing guild ${guild.name}:`, error.message);
    }
  }
  
  console.log('[Bot] Athena is ready and listening for messages!');
  
  // Initial knowledge base load
  await refreshKnowledge();
  
  // Refresh knowledge base every 60 seconds
  setInterval(async () => {
    await refreshKnowledge();
  }, 60000);
  
  console.log('[Bot] Knowledge base auto-refresh enabled (every 60 seconds)');
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const oldNation = getMemberNation(oldMember);
  const newNation = getMemberNation(newMember);
  
  if (oldNation !== newNation && newNation) {
    console.log(`[Discord] ${newMember.user.username} received role ${newNation}`);
    await syncUserRoleToFirebase(newMember);
  }
});

client.on('guildMemberAdd', async (member) => {
  if (getMemberNation(member)) {
    await syncUserRoleToFirebase(member);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }
  if (message.channel.partial) {
    try { await message.channel.fetch(); } catch { return; }
  }
  
  console.log(`[MSG] ${message.author?.tag}: "${message.content?.substring(0, 50)}..."`);
  
  if (!message.author || message.author.bot) return;

  const content = message.content.trim();
  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;
  const startsWithAthena = content.toLowerCase().startsWith('athena');
  
  if (!isMentioned && !isDM && !startsWithAthena) {
    if (db) {
      try {
        await addDoc(collection(db, 'messages'), {
          user_id: message.author.id,
          username: message.author.username,
          text: content,
          platform: 'discord',
          timestamp: serverTimestamp(),
        });
      } catch (error) {
        console.error('[Firestore] Error syncing message:', error.message);
      }
    }
    return;
  }

  console.log(`[Discord] Responding to ${message.author.username}: ${content}`);
  await message.channel.sendTyping();

  if (content.startsWith('!lookup ')) {
    const username = content.slice(8).trim();
    const nation = await lookupAndSyncUser(username, message.guild);
    if (nation) {
      await message.reply(`${username} is in ${nation}!`);
    } else {
      await message.reply(`${username} doesn't have a nation role yet.`);
    }
    return;
  }

  try {
    const userHistory = conversationHistory.get(message.author.id) || [];
    
    let cleanContent = content;
    if (isMentioned) {
      cleanContent = content.replace(/<@!?\d+>/g, '').trim();
    }
    if (startsWithAthena) {
      cleanContent = content.slice(6).trim();
    }
    
    if (!cleanContent) {
      await message.reply("Yes? How may I assist you?");
      return;
    }

    const aiResponse = await getAthenaResponse(cleanContent, message.author.id);
    
    userHistory.push({ role: 'user', content: cleanContent });
    userHistory.push({ role: 'assistant', content: aiResponse });
    conversationHistory.set(message.author.id, userHistory.slice(-20));
    
    if (db) {
      await addDoc(collection(db, 'messages'), {
        user_id: message.author.id,
        username: message.author.username,
        text: cleanContent,
        response: aiResponse,
        platform: 'discord',
        timestamp: serverTimestamp(),
      });
    }
    
    if (aiResponse.length > 1900) {
      const chunks = aiResponse.match(/.{1,1900}/gs) || [aiResponse];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(aiResponse);
    }
    
    if (message.member) {
      await syncUserRoleToFirebase(message.member);
    }
  } catch (error) {
    console.error('[Bot] Error processing message:', error.message);
    await message.reply("I apologise, but I encountered an error. Please try again.");
  }
});

client.on('error', (error) => console.error('[Client Error]', error.message));
client.on('warn', (info) => console.warn('[Client Warn]', info));

setInterval(() => {
  console.log(`[Bot] Heartbeat - Status: ${client.ws.status}`);
}, 60000);

const token = process.env.DISCORD_BOT_TOKEN;
if (token) {
  client.login(token);
  console.log('[Bot] Logging in...');
} else {
  console.error('DISCORD_BOT_TOKEN not found in environment variables');
  process.exit(1);
}
