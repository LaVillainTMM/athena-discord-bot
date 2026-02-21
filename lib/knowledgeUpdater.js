import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { db } from "../firebase.js";
import {
  collection,
  addDoc,
  serverTimestamp
} from "firebase/firestore";

/**
 * Stores verified knowledge into Firebase
 */
export async function storeNewKnowledge({
  title,
  body,
  source,
  verified = true,
  explanation = null
}) {
  try {
    await addDoc(collection(db, "athena_knowledge"), {
      title,
      body,
      source,
      verified,
      explanation,
      createdAt: serverTimestamp(),
      platform: "autonomous",
      user_id: null
    });

    console.log("✅ Knowledge stored:", title);

  } catch (error) {
    console.error("❌ Knowledge store failed:", error);
  }
}

/**
 * Autonomous learning loop
 */
export function startAutonomousLearning(fetchFact) {
  console.log("🧠 Athena autonomous learning started");

  setInterval(async () => {
    try {
      const fact = await fetchFact();

      if (!fact) return;

      await storeNewKnowledge(fact);

    } catch (err) {
      console.error("Learning cycle error:", err);
    }
  }, 180000); // every 3 minutes
}
