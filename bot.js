// ==========================
// Firebase Initialization
// ==========================
let db;
try {
  let firebaseCreds;
  if (process.env.FIREBASE_CREDENTIALS) {
    firebaseCreds = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  }

  admin.initializeApp({
    credential: firebaseCreds
      ? admin.credential.cert(firebaseCreds)
      : admin.credential.applicationDefault(),
    // Explicitly set the Project ID from the environment variable
    projectId: process.env.GCLOUD_PROJECT,
  });

  db = admin.firestore();
  console.log("[Firebase] Connected successfully (Admin SDK)");

  enableFirebaseTelemetry();
  console.log("[Firebase] Genkit telemetry enabled");
} catch (error) {
  console.error("[Firebase] Admin init failed:", error.message);
  console.log("[Firebase] Bot will run without Firebase sync features.");
}

  let systemPrompt = `${ATHENA_SYSTEM_PROMPT}\nCurrent date & time: ${getCurrentDateTime()}`;
  if (knowledge.length) {
    systemPrompt += `\n\nKnowledge Base:\n${knowledge.join("\n")}`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20), // Keep the last 20 messages for context
    { role: "user", content: userMessage },
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "I'm not sure how to respond to that.";

    // Update conversation history
    const updatedHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
    conversationHistory.set(userId, updatedHistory.slice(-20));

    return reply;

  } catch (error) {
    console.error("[OpenAI] Error:", error.message);
    return "I encountered an error while trying to think. Please try again later.";
  }
}

// ==========================
// Discord Event Handlers
// ==========================

client.once(Events.ClientReady, async () => {
  console.log(`Athena online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "over the nations", type: ActivityType.Watching }],
    status: "online",
  });
  // Initial load of the knowledge base on startup
  await getKnowledgeBase();
});

client.on(Events.GuildMemberUpdate, async (_, newMember) => {
  await syncUserRoleToFirebase(newMember);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const content = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) return;

  try {
    await message.channel.sendTyping();
    const reply = await getAthenaResponse(content, message.author.id);
    await message.reply(reply);
  } catch (error) {
    console.error("Athena reply error:", error.message);
    await message.reply("Something went wrong while I was thinking. Please try again.");
  }
});

// ==========================
// Login to Discord
// ==========================
console.log("Logging into Discord...");
client.login(process.env.DISCORD_TOKEN);
