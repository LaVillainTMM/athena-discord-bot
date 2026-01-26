// firebase.js — ESM, singleton-safe

import admin from "firebase-admin";

/**
 * Initialize Firebase Admin exactly once
 */
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, "\n")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
  });
}

/**
 * Export initialized services
 */
const rtdb = admin.database();
export { admin, firestore, rtdb };
