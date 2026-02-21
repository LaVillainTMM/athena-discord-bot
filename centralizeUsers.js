// centralizeUsers.js — unify Discord, mobile, desktop users
import "dotenv/config";
import { firestore, admin } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Utility to create or get Athena user canonical ID
 */
async function getOrCreateAthenaUser(platform, platformId, displayName = null) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection(platform);

  const existing = await accountsRef.doc(platformId).get();
  if (existing.exists) return existing.data().athenaUserId;

  // Run transaction to ensure uniqueness
  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(accountsRef.doc(platformId));
    if (recheck.exists) return recheck.data().athenaUserId;

    const athenaUserId = uuidv4();

    const userRoot = firestore
      .collection("athena_ai")
      .doc("users")
      .collection("humans")
      .doc(athenaUserId);

    // Create core profile
    tx.set(userRoot.collection("profile").doc("core"), {
      displayName: displayName || platformId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      role: null,
      quizCompleted: false,
      linkedDiscordIds: platform === "discord" ? [platformId] : [],
      platforms: {
        [platform]: { id: platformId, last_active: admin.firestore.FieldValue.serverTimestamp() }
      },
    });

    // Link account
    tx.set(accountsRef.doc(platformId), {
      athenaUserId,
      username: displayName || platformId,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return athenaUserId;
  });
}

/**
 * Link a new platform ID to an existing Athena user
 */
async function linkPlatformId(athenaUserId, platform, platformId) {
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
    if (!platforms[platform]) platforms[platform] = {};
    platforms[platform].id = platformId;
    platforms[platform].last_active = admin.firestore.FieldValue.serverTimestamp();

    tx.update(coreRef, { platforms });
  });
}

/**
 * Update all historical messages to reference correct Athena IDs
 */
async function backfillMessages() {
  console.log("[Centralize] Updating messages to use canonical Athena IDs...");
  const messagesSnap = await firestore.collection("messages").get();

  for (const msg of messagesSnap.docs) {
    const data = msg.data();
    const platform = data.platform || "discord";
    const platformId = data.user_id;

    const accountsRef = firestore
      .collection("athena_ai")
      .doc("accounts")
      .collection(platform);

    const accountDoc = await accountsRef.doc(platformId).get();
    if (!accountDoc.exists) continue;

    const athenaUserId = accountDoc.data().athenaUserId;
    await msg.ref.update({ user_id: athenaUserId });
  }

  console.log("[Centralize] Message backfill complete.");
}

/**
 * Main script to centralize users
 */
async function centralizeAll() {
  console.log("[Centralize] Starting Athena AI user centralization...");

  const platforms = ["discord", "mobile", "desktop"];
  for (const platform of platforms) {
    const colRef = firestore.collection("athena_ai").doc("accounts").collection(platform);
    const snapshot = await colRef.get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const displayName = data.username || data.displayName || doc.id;
      const athenaUserId = await getOrCreateAthenaUser(platform, doc.id, displayName);
      await linkPlatformId(athenaUserId, platform, doc.id);
      console.log(`[Centralize] ${platform} ID ${doc.id} → AthenaUser ${athenaUserId}`);
    }
  }

  await backfillMessages();
  console.log("[Centralize] Athena AI centralization complete.");
  process.exit(0);
}

centralizeAll().catch(err => {
  console.error("[Centralize] Error:", err);
  process.exit(1);
});
