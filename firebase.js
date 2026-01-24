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
  });
}

/**
 * Export initialized services
 */
const firestore = admin.firestore();

export { admin, firestore };
