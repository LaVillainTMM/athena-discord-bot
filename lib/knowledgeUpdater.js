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



let knowledgeAPIRef = null;

export async function initKnowledgeUpdater(firestore, config) {
  knowledgeAPIRef = {
    firestore,
    collection: config.collection,
    async storeNewKnowledge(entry) {
      await firestore.collection(config.collection).add({
        content: entry.body,
        topic: entry.title || "autonomous",
        verified: true,
        createdAt: new Date(),
        source: entry.platform || "autonomous"
      });
    }
  };

  return knowledgeAPIRef;
}

/*
=====================================
AUTONOMOUS LEARNING ENGINE
=====================================
Adds knowledge continuously
Target: 360+ entries/day
*/
export function startAutonomousLearning(fetchFact) {

  if (typeof fetchFact !== "function") {
    throw new Error("fetchFact must be a function");
  }

  console.log("🧠 Athena autonomous learning started");

  // Every 4 minutes ≈ 360/day
  const INTERVAL = 240000;

  setInterval(async () => {
    try {
      const fact = await fetchFact();

      if (!fact || !knowledgeAPIRef) return;

      await knowledgeAPIRef.storeNewKnowledge({
        title: fact.topic || "autonomous learning",
        body: fact.content || fact,
        platform: "athena_autonomous"
      });

      console.log("📘 New knowledge stored");

    } catch (err) {
      console.error("Learning cycle error:", err);
    }
  }, INTERVAL);
}




/**
 * Alias for bot.js compatibility
 */
export const initKnowledgeUpdater = startAutonomousLearning;
