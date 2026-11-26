

import "dotenv/config";
import { firestore, rtdb, admin } from "./firebase.js";

async function testKnowledgeStorage() {
  const ref = firestore
    .collection("athena_knowledge")
    .doc("_diagnostic_test");

  try {
    await ref.set({
      title: "Athena Knowledge Storage Test",
      body: "Firestore knowledge storage diagnostic.",
      diagnostic: true,
      createdAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new Error("Knowledge read-back failed");
    }

    console.log(
      "[Knowledge Test] Firestore write/read successful"
    );

    await ref.delete();

    await rtdb.ref(
      "athena/system/learning"
    ).update({
      storageOperational: true,
      lastTest:
        admin.database.ServerValue.TIMESTAMP
    });

    console.log(
      "[Knowledge Test] Realtime status updated"
    );

  } catch (error) {
    console.error(
      "[Knowledge Test] Failed:",
      error.message
    );

    process.exitCode = 1;
  }
}

await testKnowledgeStorage();

await admin.app().delete();
