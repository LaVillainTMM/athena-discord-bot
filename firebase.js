import admin from "firebase-admin";

function parseServiceAccount(raw) {
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/\\n/g, "\n")); } catch {}
  try { return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")); } catch {}

  try {
    const fixed = raw
      .replace(/(\s*)(\w+)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    return JSON.parse(fixed);
  } catch {}

  try {
    return new Function("return (" + raw + ")")();
  } catch {}

  return null;
}

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("[Firebase] FIREBASE_SERVICE_ACCOUNT env var is missing!");
    process.exit(1);
  }

  const serviceAccount = parseServiceAccount(raw);
  if (!serviceAccount || !serviceAccount.project_id) {
    console.error("[Firebase] Cannot parse FIREBASE_SERVICE_ACCOUNT.");
    console.error("[Firebase] The value must be valid JSON from your Firebase service account key file.");
    console.error("[Firebase] Expected format: {\"type\":\"service_account\",\"project_id\":\"...\", ...}");
    console.error("[Firebase] First 80 chars received:", raw.substring(0, 80));
    process.exit(1);
  }

  console.log("[Firebase] Parsed service account for project:", serviceAccount.project_id);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com",
  });
}

const db = admin.firestore();
const rtdb = admin.database();

export { admin, db, rtdb };
export const firestore = db;
