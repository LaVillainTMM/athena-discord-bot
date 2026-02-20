// firestoreAudit.js
import { firestore, admin } from "./firebase.js";

async function auditAndPatchFirestore() {
  console.log("[Audit] Starting Firestore audit...");

  // Required collections for Athena
  const requiredCollections = [
    "athena_knowledge",
    "discord_users",
    "messages",
    "voice_profiles",
    "quiz_results",      // optional but recommended
    "knowledge_updates"  // optional logging collection
  ];

  // Fetch existing collections
  const existingCollectionsSnapshot = await firestore.listCollections();
  const existingCollections = existingCollectionsSnapshot.map(c => c.id);

  console.log("[Audit] Existing collections:", existingCollections);

  for (const collectionName of requiredCollections) {
    if (!existingCollections.includes(collectionName)) {
      console.log(`[Audit] Missing collection detected: ${collectionName}. Creating...`);

      // Firestore doesn’t allow truly empty collections, so add a placeholder doc
      const docRef = firestore.collection(collectionName).doc("_init");
      await docRef.set({
        initializedAt: admin.firestore.FieldValue.serverTimestamp(),
        note: "Collection initialized by Firestore audit script. Remove _init doc after adding real data."
      });

      console.log(`[Audit] Collection ${collectionName} initialized with placeholder document.`);
    } else {
      console.log(`[Audit] Collection ${collectionName} exists ✅`);
    }
  }

  console.log("[Audit] Firestore audit complete ✅");
}

auditAndPatchFirestore()
  .then(() => {
    console.log("Audit script finished successfully.");
    process.exit(0);
  })
  .catch(err => {
    console.error("Audit script failed:", err);
    process.exit(1);
  });
