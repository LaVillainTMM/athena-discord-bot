// centralizeUsers.js — unify Discord, mobile, desktop users
import { firestore } from "./firebase.js";
import { getOrCreateAthenaUser, linkPlatformId, backfillMessages } from "./athenaUser.js";

/**
 * Centralize all users and link platforms
 * This ensures all Discord, Mobile, Desktop accounts share one canonical Athena ID.
 */
export async function centralizeAllUsers() {
  console.log("[Centralize] Starting user centralization...");

  const platforms = ["discord", "mobile", "desktop"];

  for (const platform of platforms) {
    const colRef = firestore.collection("athena_ai").doc("accounts").collection(platform);
    const snapshot = await colRef.get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const displayName = data.username || data.displayName || doc.id;

      // Ensure canonical Athena ID exists for this platform account
      const athenaUserId = await getOrCreateAthenaUser(platform, doc.id, displayName);

      // Update last_active and platform mapping
      await linkPlatformId(athenaUserId, platform, doc.id);

      console.log(`[Centralize] ${platform} ID ${doc.id} → AthenaUser ${athenaUserId}`);
    }
  }

  // Update all historical messages to reference canonical Athena IDs
  await backfillMessages();
  console.log("[Centralize] User centralization complete.");
}

/**
 * Optional standalone run
 * Uncomment if you want this file to execute immediately
 */
// centralizeAllUsers().catch(err => {
//   console.error("[Centralize] Error:", err);
//   process.exit(1);
// });
