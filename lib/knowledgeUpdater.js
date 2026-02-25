import { verifyKnowledge } from "./verifyKnowledge.js";
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
  source = "autonomous",
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
      platform: "athena_autonomous",
      user_id: null
    });

    console.log("✅ Knowledge stored:", title);

  } catch (error) {
    console.error("❌ Knowledge store failed:", error);
  }
}


/*
=====================================
ATHENA AUTONOMOUS LEARNING ENGINE
=====================================
Target: 360+ knowledge entries/day
(1 entry every 4 minutes)
*/
export function startAutonomousLearning(fetchFact) {

  if (typeof fetchFact !== "function") {
    throw new Error("fetchFact must be a function");
  }

  console.log("🧠 Athena autonomous learning started");

  const INTERVAL = 240000; // 4 minutes

  setInterval(async () => {
    try {
      const fact = await fetchFact();

if (!fact || !knowledgeAPIRef) return;

// ---------------- VERIFY KNOWLEDGE ----------------
const verification = await verifyKnowledge(fact);

console.log("🔍 Verification:", verification);

// Reject low confidence knowledge
if (!verification.valid || verification.confidence < 70) {
  console.log("❌ Knowledge rejected");
  return;
}

// ---------------- STORE VERIFIED KNOWLEDGE ----------------
await knowledgeAPIRef.storeNewKnowledge({
  title: fact.topic || "autonomous learning",
  body: fact.content || fact,
  platform: "athena_verified",
  confidence: verification.confidence,
  explanation: verification.reason
});

console.log("✅ Verified knowledge stored");
