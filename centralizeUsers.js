// centralizeUsers.js
import "dotenv/config";
import { firestore, admin } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";
import { Timestamp } from "firebase-admin/firestore";

async function centralizeUsers() {
  console.log("[Centralize] Starting Athena AI user centralization...");

  const athenaCollection = firestore.collection("athena_ai");
  const discordUsersCol = firestore.collection("discord_users");

  const snapshot = await discordUsersCol.get();

  for (const doc of snapshot.docs) {
    const discordData = doc.data();

    // search existing user by Discord ID
    const existingSnap = await athenaCollection
      .where("platforms.discord.id", "==", discordData.id)
      .limit(1)
      .get();

    let userDocRef;
    if (existingSnap.empty) {
      const newUserUid = uuidv4();
      userDocRef = athenaCollection.doc();
      await userDocRef.set({
        user_uid: newUserUid,
        display_name: discordData.username,
        platforms: {
          discord: {
            id: discordData.id,
            username: discordData.username,
            guilds: discordData.guilds || [],
            roles: discordData.roles || [],
            last_active: discordData.last_active
              ? Timestamp.fromDate(new Date(discordData.last_active))
              : Timestamp.now(),
          },
        },
        timezone: discordData.timezone || "UTC",
        utc_offset_minutes: discordData.utc_offset_minutes || 0,
        created_at: Timestamp.now(),
        updated_at: Timestamp.now(),
        message_stats: {
          total_messages: 0,
          last_message: null,
        },
      });
      console.log(`[Centralize] Created new user: ${discordData.username}`);
    } else {
      userDocRef = existingSnap.docs[0].ref;
      const existingData = existingSnap.docs[0].data();
      await userDocRef.set(
        {
          platforms: {
            ...existingData.platforms, // preserve other platforms
            discord: {
              id: discordData.id,
              username: discordData.username,
              guilds: discordData.guilds || [],
              roles: discordData.roles || [],
              last_active: discordData.last_active
                ? Timestamp.fromDate(new Date(discordData.last_active))
                : Timestamp.now(),
            },
          },
          updated_at: Timestamp.now(),
        },
        { merge: true }
      );
      console.log(`[Centralize] Updated user: ${discordData.username}`);
    }
  }

  console.log("[Centralize] Athena AI centralization complete.");
  process.exit(0);
}

centralizeUsers().catch(err => {
  console.error("[Centralize] Error:", err);
  process.exit(1);
});
