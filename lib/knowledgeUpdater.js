import { verifyKnowledge } from "./verifyKnowledge.js";
import { db } from "../firebase.js";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";

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

export function startAutonomousLearning(fetchFact) {
  if (typeof fetchFact !== "function") {
    throw new Error("fetchFact must be a function");
  }

  console.log("🧠 Athena autonomous learning started");

  const INTERVAL = 240000;

  setInterval(async () => {
    try {
      const fact = await fetchFact();
      if (!fact) return;

      await storeNewKnowledge({
        title: fact.title || "Autonomous Learning",
        body: fact.content || fact,
        source: fact.source || "athena_autonomous"
      });

      console.log("📘 New knowledge stored");
    } catch (err) {
      console.error("Learning cycle error:", err);
    }
  }, INTERVAL);
}
