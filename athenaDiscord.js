// athenaDiscord.js
import { Client, GatewayIntentBits } from "discord.js";
import { firestore, admin } from "./firebase.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: ["CHANNEL"] // Required to receive DMs
});

// -------------------- Helper: Store Message --------------------
async function storeMessage(message) {
  if (message.author.bot) return;

  const platform = "discord";
  const platformId = message.author.id;
  const text = message.content;

  try {
    // 1️⃣ Store message in `messages` collection
    const msgRef = await firestore.collection("messages").add({
      user_id: platformId,
      platform,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("[Firebase] Message stored:", msgRef.id);

    // 2️⃣ Get Athena account
    const accountDoc = await firestore
      .collection("athena_ai")
      .doc("accounts")
      .collection(platform)
      .doc(platformId)
      .get();

    const athenaUserId = accountDoc.exists
      ? accountDoc.data().athenaUserId
      : null;

    // 3️⃣ Store in `knowledge_updates`
    await firestore.collection("knowledge_updates").doc(msgRef.id).set({
      user_id: athenaUserId || platformId,
      platform,
      original_message: text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "discord"
    });
  } catch (err) {
    console.error("[Firebase] Failed to store message:", err);
  }
}

// -------------------- Event: New Discord DM --------------------
client.on("messageCreate", async (message) => {
  if (message.channel.type === 1) { // 1 = DM channel
    await storeMessage(message);
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

      // Get Athena account
      const accountDoc = await firestore
        .collection("athena_ai")
        .doc("accounts")
        .collection(platform)
        .doc(platformId)
        .get();

      const athenaUserId = accountDoc.exists
        ? accountDoc.data().athenaUserId
        : null;

      // Update messages collection
      await msg.ref.update({ user_id: athenaUserId || platformId });

      // Add to knowledge_updates if not exists
      const knowledgeRef = firestore.collection("knowledge_updates").doc(msg.id);
      const knowledgeDoc = await knowledgeRef.get();
      if (!knowledgeDoc.exists) {
        await knowledgeRef.set({
          user_id: athenaUserId || platformId,
          platform,
          original_message: data.text || data.content || "",
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
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
  // Optional: run backfill once on startup
  await backfillExistingMessages();
});

// Login bot
client.login(process.env.DISCORD_TOKEN);
