// backfillMessages.js
import { firestore, admin } from "./firebase.js";

async function backfillMessages() {
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

      // Fetch the corresponding Athena account
      const accountDoc = await firestore
        .collection("athena_ai")
        .doc("accounts")
        .collection(platform)
        .doc(platformId)
        .get();

      if (!accountDoc.exists) continue;

      const athenaUserId = accountDoc.data().athenaUserId;

      // 1️⃣ Update the original messages collection
      await msg.ref.update({ user_id: athenaUserId });

      // 2️⃣ Add or backfill into knowledge_updates
      await firestore.collection("knowledge_updates").doc(msg.id).set({
        user_id: athenaUserId,
        platform,
        original_message: data.text || data.content || "",
        createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        backfilled: true,
      });
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log("[Backfill] Complete.");
}

backfillMessages()
  .then(() => process.exit())
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
