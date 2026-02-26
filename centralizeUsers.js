// centralizeUsers.js — One-time migration: legacy discord_users → full contact cards
// Run with: node centralizeUsers.js

import { firestore } from "./firebase.js";
import { getOrCreateAthenaUser, linkDiscordId, updateUserNation } from "./athenaUser.js";

export async function centralizeAllUsers() {
  console.log("[Centralize] Starting migration of discord_users → athena contact cards...");

  const snapshot = await firestore.collection("discord_users").get();
  let migrated = 0, skipped = 0, failed = 0;

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const discordId = data.discordId || docSnap.id;
    const username = data.username || data.displayName || docSnap.id;
    const nation = data.nation || null;

    try {
      const fakeUser = {
        id: discordId,
        username,
        globalName: username,
        displayAvatarURL: () => null,
      };

      const athenaUserId = await getOrCreateAthenaUser(fakeUser);
      await linkDiscordId(athenaUserId, discordId);

      if (nation) {
        await updateUserNation(athenaUserId, nation, { version: "migrated" });
      }

      console.log(`[Centralize] discord:${discordId} (${username}) → athena:${athenaUserId}${nation ? ` [${nation}]` : ""}`);
      migrated++;
    } catch (err) {
      console.error(`[Centralize] Failed for ${discordId}:`, err.message);
      failed++;
    }
  }

  console.log(`[Centralize] Done. Migrated: ${migrated}, Failed: ${failed}, Skipped: ${skipped}`);
}

centralizeAllUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
