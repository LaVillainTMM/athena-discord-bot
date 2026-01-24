const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://athenaai-memory-default-rtdb.firebaseio.com"
  });
}

module.exports = admin.database();
