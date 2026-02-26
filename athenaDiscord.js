// athenaDiscord.js — Message logging and backfill utilities
// Exports functions to be called by bot.js (no separate client)

import { firestore, admin } from "./firebase.js";
import { getOrCreateAthenaUser } from "./athenaUser.js";

export async function storeDiscordMessage(message) {
  if (!message || !message.author) return;
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[Messages] Stored:", message.author.username);
  } catch (err) {
    console.error("[Messages] Firestore write failed:", err);
  }
}

export async function storeAndLinkMessage(message) {
  if (!message || !message.author || message.author.bot) return;

  const text = message.content;

  try {
    const athenaUserId = await getOrCreateAthenaUser(message.author);

    const msgRef = await firestore.collection("messages").add({
      user_id: athenaUserId,
      platform: "discord",
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await firestore.collection("knowledge_updates").doc(msgRef.id).set({
      user_id: athenaUserId,
      platform: "discord",
      original_message: text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "discord",
    });

    console.log("[Firebase] Message stored and linked:", msgRef.id);
  } catch (err) {
    console.error("[Firebase] Failed to store message:", err);
  }
}

export async function backfillExistingMessages() {
  console.log("[Backfill] Starting migration...");
  const batchSize = 200;
  let lastDoc = null;

  while (true) {
    let q = firestore
      .collection("messages")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(batchSize);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const msg of snap.docs) {
      const data = msg.data();
      const platform = data.platform || "discord";
      const platformId = data.user_id;

      const accountDoc = await firestore
        .collection("athena_ai")
        .doc("accounts")
        .collection(platform)
        .doc(platformId)
        .get();

      if (!accountDoc.exists) continue;

      const athenaUserId = accountDoc.data().athenaUserId;
      await msg.ref.update({ user_id: athenaUserId });

      const kuRef = firestore.collection("knowledge_updates").doc(msg.id);
      const kuDoc = await kuRef.get();
      if (!kuDoc.exists) {
        await kuRef.set({
          user_id: athenaUserId,
          platform,
          original_message: data.text || data.content || "",
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          backfilled: true,
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log("[Backfill] Complete.");
}
