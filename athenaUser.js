import { v4 as uuidv4 } from "uuid";
import { admin, firestore } from "./firebase.js";

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
   GET OR CREATE — full contact card on first visit
──────────────────────────────────────────── */
export async function getOrCreateAthenaUser(discordUser) {
  const discordAccountRef = accountsCol("discord").doc(discordUser.id);
  const existing = await discordAccountRef.get();

  if (existing.exists) {
    /* update avatar / globalName each visit without a full transaction */
    const athenaUserId = existing.data().athenaUserId;
    await profileRef(athenaUserId).update({
      "discord.globalName": discordUser.globalName || discordUser.username,
      "discord.avatarURL": discordUser.displayAvatarURL?.({ size: 256 }) ?? null,
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return athenaUserId;
  }

  return await firestore.runTransaction(async tx => {
    const recheck = await tx.get(discordAccountRef);
    if (recheck.exists) return recheck.data().athenaUserId;

    const athenaUserId = uuidv4();
    const avatarURL = discordUser.displayAvatarURL?.({ size: 256 }) ?? null;
    const now = admin.firestore.FieldValue.serverTimestamp();

    /* ── contact card ── */
    tx.set(profileRef(athenaUserId), {
      athenaUserId,
      displayName: discordUser.globalName || discordUser.username,

      discord: {
        id: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.globalName || discordUser.username,
        avatarURL,
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
      },
      linkedDevices: [],

      messageCount: 0,
      lastSeen: now,
      createdAt: now,
    });

    /* ── reverse-lookup index ── */
    tx.set(discordAccountRef, {
      athenaUserId,
      username: discordUser.username,
      globalName: discordUser.globalName || discordUser.username,
      linkedAt: now,
    });

    return athenaUserId;
  });
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
   RECORD LAST SEEN + INCREMENT MESSAGE COUNT
──────────────────────────────────────────── */
export async function recordActivity(athenaUserId) {
  await profileRef(athenaUserId).set({
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    messageCount: admin.firestore.FieldValue.increment(1),
  }, { merge: true }).catch(() => {});
}

/* ────────────────────────────────────────────
   LINK ADDITIONAL DISCORD ID (alts / bots)
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
