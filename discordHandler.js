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

client.on("ready", () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const platform = "discord";
  const platformId = message.author.id;
  const text = message.content;

  try {
    // 1️⃣ Store the message in Firebase messages collection
    const msgRef = await firestore.collection("messages").add({
      user_id: platformId,
      platform,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("[Firebase] Message stored:", msgRef.id);

    // 2️⃣ Optionally, store immediately in knowledge_updates
    const accountDoc = await firestore
      .collection("athena_ai")
      .doc("accounts")
      .collection(platform)
      .doc(platformId)
      .get();

    if (accountDoc.exists) {
      await firestore.collection("knowledge_updates").doc(msgRef.id).set({
        user_id: accountDoc.data().athenaUserId,
        platform,
        original_message: text,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    console.error("[Firebase] Failed to store message:", err);
  }
});

// Login your bot
client.login(process.env.DISCORD_TOKEN);
