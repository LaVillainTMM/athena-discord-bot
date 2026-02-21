// centralizeUsers.js
import { firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  linkPlatformId
} from "./athenaUser.js";

export async function centralizeAllUsers() {
  console.log("[Centralize] Starting...");

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
        data.username ||
        data.displayName ||
        doc.id;

      const athenaUserId =
        await getOrCreateAthenaUser(
          platform,
          doc.id,
          displayName
        );

      await linkPlatformId(
        athenaUserId,
        platform,
        doc.id
      );

      console.log(
        `[Centralize] ${platform}:${doc.id} → ${athenaUserId}`
      );
    }
  }

  console.log("[Centralize] Complete.");
}
