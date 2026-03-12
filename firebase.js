import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

export { firestore };

function buildFromEnvVars() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    return {
      type: "service_account",
      project_id: projectId,
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: clientEmail,
    };
  }

  return null;
}

function parseServiceAccount(raw) {
  if (!raw) return null;

  const attempts = [
    () => JSON.parse(raw),
    () => JSON.parse(raw.replace(/\\n/g, "\n")),
    () => JSON.parse(Buffer.from(raw, "base64").toString("utf-8")),
    () => {
      const fixed = raw.replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":');
      return JSON.parse(fixed);
    },
    () => new Function("return (" + raw + ")")(),
  ];

  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (result && result.project_id) return result;
    } catch {}
  }

  return null;
}

if (!admin.apps.length) {
  let serviceAccount = buildFromEnvVars();

  if (!serviceAccount) {
    serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  if (!serviceAccount || !serviceAccount.project_id) {
    console.error("[Firebase] Could not load service account credentials.");
    console.error("[Firebase] Option 1: Set FIREBASE_SERVICE_ACCOUNT as a single-line JSON string");
    console.error("[Firebase] Option 2: Set these env vars:");
    console.error("FIREBASE_PROJECT_ID");
    console.error("FIREBASE_CLIENT_EMAIL");
    console.error("FIREBASE_PRIVATE_KEY");
    process.exit(1);
  }

  console.log("[Firebase] Initialized for project:", serviceAccount.project_id);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://athenaai-memory-default-rtdb.firebaseio.com",
  });
}

const realtimeDB = admin.database();

firestore.settings({
  ignoreUndefinedProperties: true,
});

export { admin, firestore, realtimeDB };
