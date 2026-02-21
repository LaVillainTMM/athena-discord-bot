// athenaDiscord.js
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { firestore, admin } from "./firebase.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: ["CHANNEL"] // Required to receive DMs
});

async function storeDiscordMessage(message) {
  try {
    await firestore.collection("messages").add({
      message_id: message.id,
      content: message.content,
      channel_id: message.channelId,
      guild_id: message.guild?.id || null,
      user_id: message.author.id,
      username: message.author.username,
      is_bot: message.author.bot,
      platform: "discord",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("[Messages] Stored:", message.author.username);
  } catch (err) {
    console.error("[Messages] Firestore write failed:", err);
  }
}

// -------------------- Helper: Store Message --------------------
async function storeMessage(message) {
  if (message.author.bot) return;

  const platform = "discord";
  const platformId = message.author.id;
  const text = message.content;

  try {
    // 1️⃣ Ensure Athena user exists
    const athenaUserId = await getOrCreateAthenaUser(platform, platformId, message.author.username);

    // 2️⃣ Store message in `messages` collection
    const msgRef = await firestore.collection("messages").add({
      user_id: athenaUserId,
      platform,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("[Firebase] Message stored:", msgRef.id);

    // 3️⃣ Store in `knowledge_updates`
    await firestore.collection("knowledge_updates").doc(msgRef.id).set({
      user_id: athenaUserId,
      platform,
      original_message: text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "discord"
    });

    // 4️⃣ Sync immediately into athena_knowledge
    const knowledgeRef = firestore.collection("athena_knowledge").doc(msgRef.id);
    await knowledgeRef.set({
      user_id: athenaUserId,
      platform,
      topic: "user_message",
      content: text,
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "discord"
    });

  } catch (err) {
    console.error("[Firebase] Failed to store message:", err);
  }
}

// -------------------- Event: New Discord DM --------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (message.channel.type === ChannelType.DM) {
      console.log("[Discord] DM received from", message.author.id);
      await storeMessage(message);
    }
  } catch (err) {
    console.error("[Discord] Error handling message:", err);
  }
});

// -------------------- Backfill Existing Messages --------------------
async function backfillExistingMessages() {
  console.log("[Backfill] Starting migration...");
  const batchSize = 200;
  let lastDoc = null;

  while (true) {
    let query = firestore
      .collection("messages")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(batchSize);

    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    for (const msg of snap.docs) {
      const data = msg.data();
      const platform = data.platform || "discord";
      const platformId = data.user_id;

      // Ensure Athena user exists
      const athenaUserId = await getOrCreateAthenaUser(platform, platformId);

      // Update messages collection with Athena ID
      await msg.ref.update({ user_id: athenaUserId });

      // Backfill into knowledge_updates
      const knowledgeUpdateRef = firestore.collection("knowledge_updates").doc(msg.id);
      const knowledgeUpdateDoc = await knowledgeUpdateRef.get();
      if (!knowledgeUpdateDoc.exists) {
        await knowledgeUpdateRef.set({
          user_id: athenaUserId,
          platform,
          original_message: data.text || data.content || "",
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          backfilled: true
        });
      }

      // Backfill into athena_knowledge
      const knowledgeRef = firestore.collection("athena_knowledge").doc(msg.id);
      const knowledgeDoc = await knowledgeRef.get();
      if (!knowledgeDoc.exists) {
        await knowledgeRef.set({
          user_id: athenaUserId,
          platform,
          topic: "user_message",
          content: data.text || data.content || "",
          verified: false,
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          source: "discord",
          backfilled: true
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log("[Backfill] Complete.");
}

// -------------------- Start Bot --------------------
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await backfillExistingMessages();
});

// Login bot
client.login(process.env.DISCORD_TOKEN);
