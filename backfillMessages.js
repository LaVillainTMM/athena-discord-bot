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

      // Ensure platform is always a valid non-empty string
      let platform = data.platform;
      if (!platform || typeof platform !== "string" || platform.trim() === "") {
        platform = "discord";
      }

      const platformId = data.user_id;
      if (!platformId) continue;

      const accountDoc = await firestore
        .collection("athena_ai")
        .doc("accounts")
        .collection(platform)
        .doc(platformId)
        .get();

      if (!accountDoc.exists) continue;

      await msg.ref.update({
        user_id: accountDoc.data().athenaUserId
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
