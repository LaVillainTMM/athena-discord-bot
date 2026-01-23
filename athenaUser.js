import { v4 as uuidv4 } from "uuid";
import admin from "firebase-admin";

function getFirestore() {
  if (!admin.apps.length) {
    throw new Error("Firebase not initialized before Firestore access");
  }
  return admin.firestore();
}

/**
 * Get or create an Athena User (canonical human identity)
 */
export async function getOrCreateAthenaUser(discordUser) {
  const firestore = getFirestore();

  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection("discord");

  // Fast path
  const existing = await accountsRef.doc(discordUser.id).get();
  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  // Transaction-safe creation
  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(accountsRef.doc(discordUser.id));
    if (recheck.exists) {
      return recheck.data().athenaUserId;
    }

    const athenaUserId = uuidv4();

    const userRoot = firestore
      .collection("athena_ai")
      .doc("users")
      .collection("humans")
      .doc(athenaUserId);

    tx.set(userRoot.collection("profile").doc("core"), {
      displayName: discordUser.username,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      role: null,
      quizCompleted: false
    });

    tx.set(accountsRef.doc(discordUser.id), {
      athenaUserId,
      username: discordUser.username,
      linkedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return athenaUserId;
  });
}
