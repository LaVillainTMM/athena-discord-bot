import admin from "firebase-admin";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("[Firebase] FIREBASE_SERVICE_ACCOUNT env var is missing!");
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_e1) {
    try {
      serviceAccount = JSON.parse(raw.replace(/\\n/g, "\n"));
    } catch (_e2) {
      try {
        const decoded = Buffer.from(raw, "base64").toString("utf-8");
        serviceAccount = JSON.parse(decoded);
      } catch (_e3) {
        console.error("[Firebase] Cannot parse FIREBASE_SERVICE_ACCOUNT.");
        console.error("[Firebase] Make sure the value is valid JSON.");
        console.error("[Firebase] First 40 chars:", raw.substring(0, 40));
        process.exit(1);
      }
    }
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
