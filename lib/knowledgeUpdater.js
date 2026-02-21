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

export function storeNewKnowledge({ title, body, source, verified = true, explanation = null }) {
  // ...existing code
}

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
  }, 180000);
}

// make startAutonomousLearning available as initKnowledgeUpdater
export const initKnowledgeUpdater = startAutonomousLearning;
