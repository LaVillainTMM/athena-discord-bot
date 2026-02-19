import admin from "firebase-admin";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("[Firebase] FIREBASE_SERVICE_ACCOUNT env var is missing!");
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw.replace(/\\n/g, "\n"));
  } catch (e) {
    console.error("[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT:", e.message);
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com",
  });
}

const db = admin.firestore();
const rtdb = admin.database();

export { admin, db, rtdb };
export const firestore = db;
