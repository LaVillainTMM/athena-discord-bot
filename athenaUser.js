import { v4 as uuidv4 } from "uuid";
import admin from "firebase-admin";

const firestore = admin.firestore();

/**
 * Get or create an Athena User (canonical human identity)
 */
export async function getOrCreateAthenaUser(discordUser) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection("discord");

  // Fast path
  const existing = await accountsRef.doc(discordUser.id).get();
  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  // Transaction prevents race conditions
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
