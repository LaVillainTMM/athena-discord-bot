// centralizeAllUsers.js
import "dotenv/config";
import { firestore, admin } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";
import { Timestamp } from "firebase-admin/firestore";

async function centralizeUsers() {
  console.log("[Centralize] Starting Athena AI cross-platform centralization...");

  const athenaCollection = firestore.collection("athena_ai");

  // --------------------- Helper function ---------------------
  async function processPlatform(platformName, collectionName, idField) {
    const snap = await firestore.collection(collectionName).get();
    for (const doc of snap.docs) {
      const data = doc.data();

      // Find existing user by platform ID
      const existingSnap = await athenaCollection
        .where(`platforms.${platformName}.${idField}`, "==", data[idField])
        .limit(1)
        .get();

      let userDocRef;
      if (existingSnap.empty) {
        // New user
        const newUserUid = uuidv4();
        userDocRef = athenaCollection.doc();
        await userDocRef.set({
          user_uid: newUserUid,
          display_name: data.display_name || data.username || `${platformName}User`,
          platforms: {
            [platformName]: {
              ...data,
              last_active: data.last_active
                ? Timestamp.fromDate(new Date(data.last_active))
                : Timestamp.now(),
            },
          },
          timezone: data.timezone || "UTC",
          utc_offset_minutes: data.utc_offset_minutes || 0,
          created_at: Timestamp.now(),
          updated_at: Timestamp.now(),
          message_stats: {
            total_messages: 0,
            last_message: null,
          },
        });
        console.log(`[Centralize] Created new user (${platformName}): ${data.display_name || data.username}`);
      } else {
        // Existing user — merge platform data
        userDocRef = existingSnap.docs[0].ref;
        const existingData = existingSnap.docs[0].data();

        await userDocRef.set(
          {
            platforms: {
              ...existingData.platforms,
              [platformName]: {
                ...data,
                last_active: data.last_active
                  ? Timestamp.fromDate(new Date(data.last_active))
                  : Timestamp.now(),
              },
            },
            updated_at: Timestamp.now(),
          },
          { merge: true }
        );
        console.log(`[Centralize] Updated user (${platformName}): ${data.display_name || data.username}`);
      }
    }
  }

  // --------------------- Discord ---------------------
  await processPlatform("discord", "discord_users", "id");

  // --------------------- Mobile ---------------------
  await processPlatform("mobile", "mobile_users", "device_id");

  // --------------------- Desktop ---------------------
  await processPlatform("desktop", "desktop_users", "device_id");

  console.log("[Centralize] Athena AI cross-platform centralization complete.");
  process.exit(0);
}

centralizeUsers().catch(err => {
  console.error("[Centralize] Error:", err);
  process.exit(1);
});
