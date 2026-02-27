// knowledgeAPI.js — Full knowledge management API for Athena Discord Bot

import { storeNewKnowledge, startAutonomousLearning } from "./lib/knowledgeUpdater.js";
import { fetchFact } from "./lib/fetchFact.js";
import { firestore } from "./firebase.js";

let cachedKnowledge = [];
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all verified knowledge entries from Firestore.
 * Returns cached results if within TTL.
 */
export async function getKnowledgeBase() {
  const now = Date.now();
  if (cachedKnowledge.length > 0 && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedKnowledge;
  }

  try {
    const snapshot = await firestore.collection("athena_knowledge").get();
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.verified) {
        const label = data.title || data.topic || "Knowledge";
        const body = data.content || data.body || "";
        const category = data.category || "";
        entries.push(category ? `[${category}] ${label}: ${body}` : `${label}: ${body}`);
      }
    });
    cachedKnowledge = entries;
    lastCacheTime = now;
    return entries;
  } catch (error) {
    console.error("[KnowledgeAPI] Error fetching knowledge base:", error.message);
    return cachedKnowledge;
  }
}

/**
 * Store a new knowledge entry from any source.
 */
export const knowledgeAPI = {
  storeNewKnowledge: async ({
    title,
    body,
    sourceUserId = null,
    platform = "discord",
    verified = true,
    explanation = null,
  }) => {
    try {
      await storeNewKnowledge({
        title,
        body,
        source: sourceUserId ? `user:${sourceUserId}` : "autonomous",
        verified,
        explanation,
      });
      cachedKnowledge = [];
      console.log("[KnowledgeAPI] Stored:", title);
    } catch (err) {
      console.error("[KnowledgeAPI] Failed to store knowledge:", err.message);
    }
  },
};

/**
 * Start the autonomous learning loop.
 * Fetches a new fact every 60 seconds and stores it.
 */
export function startKnowledgeLearning() {
  console.log("[KnowledgeAPI] Starting autonomous learning...");
  startAutonomousLearning(fetchFact);
}
