// centralizeUsers.js — One-time migration utility
// Run with: node centralizeUsers.js

import { firestore } from "./firebase.js";
import { getOrCreateAthenaUser, linkDiscordId } from "./athenaUser.js";

export async function centralizeAllUsers() {
  console.log("[Centralize] Starting...");

  const snapshot = await firestore.collection("discord_users").get();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const discordId = data.discordId || docSnap.id;
    const displayName = data.username || data.displayName || docSnap.id;

    try {
      const fakeUser = {
        id: discordId,
        username: displayName,
      };

      const athenaUserId = await getOrCreateAthenaUser(fakeUser);

      await linkDiscordId(athenaUserId, discordId);

      console.log(`[Centralize] discord:${discordId} → athena:${athenaUserId}`);
    } catch (err) {
      console.error(`[Centralize] Failed for ${discordId}:`, err.message);
    }
  }

  console.log("[Centralize] Complete.");
}

centralizeAllUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
