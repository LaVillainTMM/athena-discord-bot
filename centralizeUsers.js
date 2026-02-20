// centralizeUsers.js
import "dotenv/config";
import { firestore, admin } from "./firebase.js";

async function centralizeUsers() {
  console.log("[Centralize] Starting Athena AI user centralization...");

  const athenaCollection = firestore.collection("athena_ai");
  const discordUsersCol = firestore.collection("discord_users");

  // iterate over Discord users
  const snapshot = await discordUsersCol.get();

  for (const doc of snapshot.docs) {
    const discordData = doc.data();

    // try to find existing user in athena_ai by discord ID
    const existing = await athenaCollection
      .where("platforms.discord.id", "==", discordData.id)
      .limit(1)
      .get();

    let userDocRef;
    if (existing.empty) {
      // create new user
      userDocRef = athenaCollection.doc();
      await userDocRef.set({
        display_name: discordData.username,
        platforms: {
          discord: {
            id: discordData.id,
            username: discordData.username,
            guilds: discordData.guilds || [],
            roles: discordData.roles || [],
            last_active: discordData.last_active || new Date(),
          },
        },
        timezone: discordData.timezone || "UTC",
        utc_offset_minutes: discordData.utc_offset_minutes || 0,
        created_at: new Date(),
        updated_at: new Date(),
        message_stats: {
          total_messages: 0,
          last_message: null,
        },
      });
      console.log(`[Centralize] Created new user: ${discordData.username}`);
    } else {
      userDocRef = existing.docs[0].ref;
      await userDocRef.update({
        "platforms.discord": {
          id: discordData.id,
          username: discordData.username,
          guilds: discordData.guilds || [],
          roles: discordData.roles || [],
          last_active: discordData.last_active || new Date(),
        },
        updated_at: new Date(),
      });
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
