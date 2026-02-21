// athenaUser.js
import { v4 as uuidv4 } from "uuid";
import { admin, firestore } from "./firebase.js";

/* =====================================================
   GET OR CREATE CANONICAL ATHENA USER
===================================================== */
export async function getOrCreateAthenaUser(
  platform,
  platformId,
  displayName = null
) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection(platform);

  const existing = await accountsRef.doc(platformId).get();
  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  return firestore.runTransaction(async tx => {
    const recheck = await tx.get(accountsRef.doc(platformId));
    if (recheck.exists) {
      return recheck.data().athenaUserId;
    }

    const athenaUserId = uuidv4();

    const userRef = firestore
      .collection("athena_ai")
      .doc("users")
      .collection("humans")
      .doc(athenaUserId);

    const coreProfileRef = userRef
      .collection("profile")
      .doc("core");

    tx.set(coreProfileRef, {
      displayName: displayName || platformId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      role: null,
      quizCompleted: false,
      platforms: {
        [platform]: {
          id: platformId,
          last_active:
            admin.firestore.FieldValue.serverTimestamp()
        }
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

/* =====================================================
   LINK PLATFORM
===================================================== */
export async function linkPlatformId(
  athenaUserId,
  platform,
  platformId
) {
  const coreRef = firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("profile")
    .doc("core");

  await coreRef.set(
    {
      platforms: {
        [platform]: {
          id: platformId,
          last_active:
            admin.firestore.FieldValue.serverTimestamp()
        }
      }
    },
    { merge: true }
  );
}

/* =====================================================
   LOOKUP ATHENA ID FROM PLATFORM USER
===================================================== */
export async function getAthenaIdFromPlatform(
  platform,
  platformId
) {
  const doc = await firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection(platform)
    .doc(platformId)
    .get();

  if (!doc.exists) return null;

  return doc.data().athenaUserId;
}
