// AthenaUser.js — ESM, Firestore, Railway-ready

import { v4 as uuidv4 } from "uuid";
import { admin, firestore } from "./firebase.js";

/**
 * Get or create an Athena User (canonical human identity)
 * @param {Object} discordUser Discord.js User object
 * @returns {Promise<string>} athenaUserId
 */
export async function getOrCreateAthenaUser(discordUser) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection("discord");

  const existing = await accountsRef.doc(discordUser.id).get();
  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(accountsRef.doc(discordUser.id));
    if (recheck.exists) return recheck.data().athenaUserId;

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
      quizCompleted: false,
      linkedDiscordIds: [discordUser.id],
    });

    tx.set(accountsRef.doc(discordUser.id), {
      athenaUserId,
      username: discordUser.username,
      linkedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return athenaUserId;
  });
}

/**
 * Link an additional Discord ID to an existing Athena user
 */
export async function linkDiscordId(athenaUserId, discordId) {
  const coreRef = firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("profile")
    .doc("core");

  await firestore.runTransaction(async tx => {
    const doc = await tx.get(coreRef);
    if (!doc.exists) throw new Error("Athena user not found");

    const linkedIds = doc.data().linkedDiscordIds || [];
    if (!linkedIds.includes(discordId)) linkedIds.push(discordId);

    tx.update(coreRef, { linkedDiscordIds: linkedIds });
  });
}
