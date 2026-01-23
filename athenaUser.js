import { v4 as uuidv4 } from "uuid";
import admin from "firebase-admin";

const firestore = admin.firestore();

  const existing = await accountsRef.doc(discordUser.id).get();
  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  // 🔒 Transaction prevents double-creation
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






/**
 * Get or create an Athena User (human identity)
 */
export async function getOrCreateAthenaUser(discordUser) {
  const accountsRef = firestore
    .collection("athena_ai")
    .doc("accounts")
    .collection("discord");

  // 1️⃣ Check if this Discord ID is already linked
  const existing = await accountsRef.doc(discordUser.id).get();

  if (existing.exists) {
    return existing.data().athenaUserId;
  }

  // 2️⃣ Create new Athena User
  const athenaUserId = uuidv4();
  const userRoot = firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId);

  // 3️⃣ Create contact-card profile
  await userRoot.collection("profile").doc("core").set({
    displayName: discordUser.username,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    role: null,
    quizCompleted: false
  });

  // 4️⃣ Link Discord account
  await accountsRef.doc(discordUser.id).set({
    athenaUserId,
    username: discordUser.username,
    linkedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // 5️⃣ Initialize empty collections
  await userRoot.collection("messages").doc("_init").set({});
  await userRoot.collection("sessions").doc("_init").set({});
  await userRoot.collection("assessment").doc("_init").set({});

  return athenaUserId;
}
