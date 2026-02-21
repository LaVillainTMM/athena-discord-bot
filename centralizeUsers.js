// centralizeUsers.js — unify Discord, mobile, desktop users

import { firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  linkPlatformId,
  backfillMessages
} from "./athenaUser.js";

/**
 * Centralize all users and link platforms
 * Ensures all platform accounts share one canonical Athena ID
 */
export async function centralizeAllUsers() {
  console.log("[Centralize] Starting user centralization...");

  const platforms = ["discord", "mobile", "desktop"];

  for (const platform of platforms) {
    const colRef = firestore
      .collection("athena_ai")
      .doc("accounts")
      .collection(platform);

    const snapshot = await colRef.get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const displayName =
        data.username || data.displayName || doc.id;

      // Ensure canonical Athena ID exists
      const athenaUserId = await getOrCreateAthenaUser(
        platform,
        doc.id,
        displayName
      );

      // Link platform mapping
      await linkPlatformId(
        athenaUserId,
        platform,
        doc.id
      );

      console.log(
        `[Centralize] ${platform} ID ${doc.id} → AthenaUser ${athenaUserId}`
      );
    }
  }

  // Backfill historical messages
  await backfillMessages();

  console.log("[Centralize] User centralization complete.");
}
