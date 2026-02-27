import { verifyKnowledge } from "./verifyKnowledge.js";
import { admin, firestore } from "../firebase.js";

export async function storeNewKnowledge({
  title,
  body,
  source = "autonomous",
  verified = true,
  explanation = null
}) {
  try {
    await firestore.collection("athena_knowledge").add({
      title,
      content: body,
      source,
      verified,
      explanation,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
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

  const INTERVAL = 60000;

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
