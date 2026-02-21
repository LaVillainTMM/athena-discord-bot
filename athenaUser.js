// athenaUser.js — canonical Athena users with multi-platform support
import { v4 as uuidv4 } from "uuid";
import { admin, firestore } from "./firebase.js";

/**
 * Get or create canonical Athena user for any platform
 * @param {string} platform - "discord" | "mobile" | "desktop"
 * @param {string} platformId - user ID on that platform
 * @param {string} displayName - optional display name
 * @returns {Promise<string>} Athena canonical ID
 */
export async function getOrCreateAthenaUser(platform, platformId, displayName = null) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection(platform);

  const existing = await accountsRef.doc(platformId).get();
  if (existing.exists) return existing.data().athenaUserId;

  // Transaction ensures uniqueness
  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(accountsRef.doc(platformId));
    if (recheck.exists) return recheck.data().athenaUserId;

    const athenaUserId = uuidv4();

    const userRoot = firestore
      .collection("athena_ai")
      .doc("users")
      .collection("humans")
      .doc(athenaUserId);

    tx.set(userRoot.collection("profile").doc("core"), {
      displayName: displayName || platformId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      role: null,
      quizCompleted: false,
      linkedDiscordIds: platform === "discord" ? [platformId] : [],
      platforms: {
        [platform]: { id: platformId, last_active: admin.firestore.FieldValue.serverTimestamp() }
      }
    });

    tx.set(accountsRef.doc(platformId), {
      athenaUserId,
      username: displayName || platformId,
      linkedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return athenaUserId;
  });
}

/**
 * Link an additional platform ID to an existing Athena user
 */
export async function linkPlatformId(athenaUserId, platform, platformId) {
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

    const platforms = doc.data().platforms || {};
    platforms[platform] = {
      id: platformId,
      last_active: admin.firestore.FieldValue.serverTimestamp()
    };

    tx.update(coreRef, { platforms });
  });
}

/**
 * Backfill all historical messages to use canonical Athena IDs
 */
export async function backfillMessages() {
  console.log("[AthenaUser] Backfilling messages to canonical IDs...");
  const messagesSnap = await firestore.collection("messages").get();

  for (const msg of messagesSnap.docs) {
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
  }

  console.log("[AthenaUser] Message backfill complete.");
}
