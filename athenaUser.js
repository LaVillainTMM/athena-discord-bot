import { v4 as uuidv4 } from "uuid";
import { admin, firestore } from "./firebase.js";
import { getOrCreateVoiceProfile } from "./voiceRecognition.js";

/* ── helpers ── */
function usersCol() {
  return firestore.collection("athena_ai").doc("users").collection("humans");
}
function accountsCol(platform = "discord") {
  return firestore.collection("athena_ai").doc("accounts").collection(platform);
}
function profileRef(athenaUserId) {
  return usersCol().doc(athenaUserId).collection("profile").doc("core");
}

/* ────────────────────────────────────────────
   FAST LOOKUP — discordId → athenaUserId
──────────────────────────────────────────── */
export async function getAthenaUserIdForDiscordId(discordId) {
  const doc = await accountsCol("discord").doc(discordId).get();
  return doc.exists ? doc.data().athenaUserId : null;
}

/* ────────────────────────────────────────────
   GET OR CREATE — full contact card on first visit
──────────────────────────────────────────── */
export async function getOrCreateAthenaUser(discordUser) {
  const discordAccountRef = accountsCol("discord").doc(discordUser.id);
  const existing = await discordAccountRef.get();

  if (existing.exists) {
    const athenaUserId = existing.data().athenaUserId;
    profileRef(athenaUserId).set({
      "discord.globalName": discordUser.globalName || discordUser.username,
      "discord.avatarURL": discordUser.displayAvatarURL?.({ size: 256 }) ?? null,
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    return athenaUserId;
  }

  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(discordAccountRef);
    if (recheck.exists) return recheck.data().athenaUserId;

    const athenaUserId = uuidv4();
    const avatarURL = discordUser.displayAvatarURL?.({ size: 256 }) ?? null;
    const now = admin.firestore.FieldValue.serverTimestamp();

    tx.set(profileRef(athenaUserId), {
      athenaUserId,
      displayName: discordUser.globalName || discordUser.username,

      discord: {
        id: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.globalName || discordUser.username,
        avatarURL,
        linkedIds: [discordUser.id],
        linkedAt: now,
      },

      nation: null,
      quizCompleted: false,
      quizCompletedAt: null,
      quizVersion: null,
      quizSessionSize: null,
      quizScore: null,

      linkedPlatforms: {
        discord: discordUser.id,
        mobile: null,
        web: null,
        voice: athenaUserId,
      },

      voiceProfile: {
        profileId: athenaUserId,
        totalVoiceSeconds: 0,
        totalSessions: 0,
        lastVoiceActivity: null,
      },
      linkedDevices: [],

      messageCounts: {
        total: 0,
        discord: 0,
        mobile: 0,
        web: 0,
      },
      lastSeen: now,
      createdAt: now,
    });

    tx.set(discordAccountRef, {
      athenaUserId,
      username: discordUser.username,
      globalName: discordUser.globalName || discordUser.username,
      linkedAt: now,
    });

    return athenaUserId;
  }).then(newAthenaUserId => {
    /* Bootstrap the voice recognition profile outside the transaction */
    getOrCreateVoiceProfile(newAthenaUserId, discordUser).catch(() => {});
    return newAthenaUserId;
  });
}

/* ────────────────────────────────────────────
   MERGE DISCORD ACCOUNTS
   Links a secondary Discord ID into the primary user's profile.
   All messages from the secondary account are migrated.
──────────────────────────────────────────── */
export async function mergeDiscordAccounts(primaryDiscordId, secondaryDiscordId) {
  if (primaryDiscordId === secondaryDiscordId) throw new Error("Cannot merge an account with itself");

  const primaryDoc = await accountsCol("discord").doc(primaryDiscordId).get();
  if (!primaryDoc.exists) throw new Error(`Primary Discord ID ${primaryDiscordId} has no Athena profile. They must message Athena first.`);
  const primaryAthenaUserId = primaryDoc.data().athenaUserId;

  const secondaryDoc = await accountsCol("discord").doc(secondaryDiscordId).get();
  const secondaryAthenaUserId = secondaryDoc.exists ? secondaryDoc.data().athenaUserId : null;

  if (secondaryAthenaUserId === primaryAthenaUserId) {
    return { primaryAthenaUserId, alreadyMerged: true };
  }

  /* point secondary discord ID → primary athenaUserId */
  await accountsCol("discord").doc(secondaryDiscordId).set({
    athenaUserId: primaryAthenaUserId,
    mergedInto: primaryAthenaUserId,
    mergedFrom: secondaryAthenaUserId,
    mergedAt: admin.firestore.FieldValue.serverTimestamp(),
    username: secondaryDoc.data()?.username || secondaryDiscordId,
  }, { merge: true });

  /* add secondaryDiscordId to primary profile's linkedIds */
  await profileRef(primaryAthenaUserId).set({
    "discord.linkedIds": admin.firestore.FieldValue.arrayUnion(secondaryDiscordId),
    "linkedPlatforms.discordAlts": admin.firestore.FieldValue.arrayUnion(secondaryDiscordId),
  }, { merge: true });

  /* if secondary had its own separate profile, mark it merged and migrate messages */
  if (secondaryAthenaUserId && secondaryAthenaUserId !== primaryAthenaUserId) {
    await profileRef(secondaryAthenaUserId).set({
      mergedInto: primaryAthenaUserId,
      mergedAt: admin.firestore.FieldValue.serverTimestamp(),
      active: false,
    }, { merge: true });

    /* migrate messages in batches of 500 */
    let migrated = 0;
    let lastDoc = null;
    while (true) {
      let q = firestore.collection("messages")
        .where("athena_user_id", "==", secondaryAthenaUserId)
        .limit(500);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = firestore.batch();
      snap.docs.forEach(doc => {
        batch.update(doc.ref, {
          athena_user_id: primaryAthenaUserId,
          merged_from_athena_id: secondaryAthenaUserId,
        });
      });
      await batch.commit();
      migrated += snap.docs.length;
      lastDoc = snap.docs[snap.docs.length - 1];
    }

    console.log(`[Merge] Migrated ${migrated} messages from ${secondaryAthenaUserId} → ${primaryAthenaUserId}`);
  }

  return { primaryAthenaUserId, secondaryAthenaUserId, alreadyMerged: false };
}

/* ────────────────────────────────────────────
   UPDATE NATION + QUIZ COMPLETION
──────────────────────────────────────────── */
export async function updateUserNation(athenaUserId, nation, quizMeta = {}) {
  await profileRef(athenaUserId).set({
    nation,
    quizCompleted: true,
    quizCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    quizVersion: quizMeta.version ?? "2.0",
    quizSessionSize: quizMeta.sessionSize ?? null,
    quizScore: quizMeta.score ?? null,
  }, { merge: true });
}

/* ────────────────────────────────────────────
   RECORD ACTIVITY — last seen + message count per platform
──────────────────────────────────────────── */
export async function recordActivity(athenaUserId, platform = "discord") {
  const update = {
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    "messageCounts.total": admin.firestore.FieldValue.increment(1),
  };
  update[`messageCounts.${platform}`] = admin.firestore.FieldValue.increment(1);

  await profileRef(athenaUserId).set(update, { merge: true }).catch(() => {});
}

/* ────────────────────────────────────────────
   LINK MOBILE DEVICE
──────────────────────────────────────────── */
export async function linkMobileDevice(athenaUserId, deviceInfo) {
  await profileRef(athenaUserId).set({
    "linkedPlatforms.mobile": deviceInfo.deviceId || null,
    linkedDevices: admin.firestore.FieldValue.arrayUnion({
      platform: "mobile",
      deviceId: deviceInfo.deviceId || null,
      os: deviceInfo.os || null,
      appVersion: deviceInfo.appVersion || null,
      linkedAt: new Date().toISOString(),
    }),
  }, { merge: true });
}

/* ────────────────────────────────────────────
   GET FULL PROFILE BY DISCORD ID
──────────────────────────────────────────── */
export async function getUserProfileByDiscordId(discordId) {
  const accountDoc = await accountsCol("discord").doc(discordId).get();
  if (!accountDoc.exists) return null;
  const { athenaUserId } = accountDoc.data();
  const coreDoc = await profileRef(athenaUserId).get();
  return coreDoc.exists ? { athenaUserId, ...coreDoc.data() } : null;
}

/* ────────────────────────────────────────────
   LINK ADDITIONAL DISCORD ID (legacy helper)
──────────────────────────────────────────── */
export async function linkDiscordId(athenaUserId, discordId) {
  await firestore.runTransaction(async tx => {
    const ref = profileRef(athenaUserId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error("Athena user not found");
    const ids = doc.data()?.discord?.linkedIds || [];
    if (!ids.includes(discordId)) ids.push(discordId);
    tx.update(ref, { "discord.linkedIds": ids });
  });
}

/* ────────────────────────────────────────────
   FORCE CREATE & LINK DISCORD IDS
   Admin-only. Creates a unified Athena profile for a person
   who controls multiple Discord accounts, even if those
   accounts have never messaged Athena before.

   discordIds[0] = primary (canonical) identity
   discordIds[1..] = alt accounts to merge in

   If the primary has no profile, one is created from scratch.
   The Discord client is used to resolve usernames where possible.
──────────────────────────────────────────── */
export async function forceCreateAndLinkDiscordIds(discordIds, discordClient = null) {
  if (!discordIds || discordIds.length < 1) throw new Error("At least one Discord ID is required");

  const [primaryId, ...altIds] = discordIds;

  async function fetchUsername(id) {
    if (!discordClient) return id;
    try {
      const user = await discordClient.users.fetch(id);
      return user.globalName || user.username || id;
    } catch {
      return id;
    }
  }

  const primaryAccountRef = accountsCol("discord").doc(primaryId);
  const primaryDoc = await primaryAccountRef.get();
  let primaryAthenaUserId;

  if (primaryDoc.exists) {
    primaryAthenaUserId = primaryDoc.data().athenaUserId;
    console.log(`[ForceLink] Primary ${primaryId} already has profile ${primaryAthenaUserId}`);
  } else {
    const username = await fetchUsername(primaryId);
    primaryAthenaUserId = uuidv4();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await firestore.runTransaction(async tx => {
      tx.set(profileRef(primaryAthenaUserId), {
        athenaUserId: primaryAthenaUserId,
        displayName: username,
        discord: {
          id: primaryId,
          username,
          globalName: username,
          avatarURL: null,
          linkedIds: [primaryId],
          linkedAt: now,
        },
        nation: null,
        quizCompleted: false,
        quizCompletedAt: null,
        quizVersion: null,
        quizSessionSize: null,
        quizScore: null,
        linkedPlatforms: { discord: primaryId, mobile: null, web: null },
        linkedDevices: [],
        messageCounts: { total: 0, discord: 0, mobile: 0, web: 0 },
        lastSeen: now,
        createdAt: now,
        adminLinked: true,
      });
      tx.set(primaryAccountRef, {
        athenaUserId: primaryAthenaUserId,
        username,
        globalName: username,
        linkedAt: now,
        adminLinked: true,
      });
    });

    console.log(`[ForceLink] Created new profile ${primaryAthenaUserId} for Discord ID ${primaryId} (${username})`);
  }

  const results = [];
  for (const altId of altIds) {
    try {
      const result = await mergeDiscordAccounts(primaryId, altId);
      results.push({ id: altId, status: result.alreadyMerged ? "already_linked" : "linked" });
    } catch (err) {
      results.push({ id: altId, status: "failed", error: err.message });
    }
  }

  return { primaryAthenaUserId, primaryDiscordId: primaryId, altCount: altIds.length, results };
}
