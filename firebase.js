// firebase.js

const admin = require("firebase-admin");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is not set in Railway variables.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

console.log("[Firebase] Initialized for project:", serviceAccount.project_id);

module.exports = { admin, db };    } catch {}
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
    console.error("[Firebase]   Copy your .json file, remove all newlines, paste as one line");
    console.error("[Firebase] Option 2: Set these 3 separate env vars instead:");
    console.error("[Firebase]   FIREBASE_PROJECT_ID=your-project-id");
    console.error("[Firebase]   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@project.iam.gserviceaccount.com");
    console.error("[Firebase]   FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n");
    process.exit(1);
  }

  console.log("[Firebase] Initialized for project:", serviceAccount.project_id);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com",
  });
}

const db = admin.firestore();
const rtdb = admin.database();

export { admin, db, rtdb };
export const firestore = db;
