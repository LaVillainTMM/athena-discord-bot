import { verifyKnowledge } from "./verifyKnowledge.js";
import { admin, firestore } from "../firebase.js";

export async function storeNewKnowledge({
  title,
  body,
  source = "autonomous",
  verified = true,
  explanation = null
}) {
  if (!title || !body) return;

  try {
    /* Deduplicate — skip if an entry with this exact title already exists */
    const existing = await firestore.collection("athena_knowledge")
      .where("title", "==", title)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log("⏭️  Knowledge already stored, skipping:", title);
      return;
    }

    /* Also deduplicate by source URL if one is provided */
    if (source && source.startsWith("http")) {
      const bySource = await firestore.collection("athena_knowledge")
        .where("source", "==", source)
        .limit(1)
        .get();

      if (!bySource.empty) {
        console.log("⏭️  Source already indexed, skipping:", source);
        return;
      }
    }

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

  /* Track recently seen titles in-memory to avoid redundant Firestore queries */
  const recentlySeen = new Set();
  const MAX_SEEN = 200;

  const INTERVAL = 60 * 1000; /* 60 seconds */

  setInterval(async () => {
    try {
      const fact = await fetchFact();
      if (!fact) return;

      const title = fact.title || "Autonomous Learning";

      /* In-memory dedupe before hitting Firestore */
      if (recentlySeen.has(title)) {
        console.log("⏭️  Skipping recently seen fact:", title);
        return;
      }

      await storeNewKnowledge({
        title,
        body: fact.content || fact,
        source: fact.source || "athena_autonomous"
      });

      recentlySeen.add(title);
      if (recentlySeen.size > MAX_SEEN) {
        const first = recentlySeen.values().next().value;
        recentlySeen.delete(first);
      }

      console.log("📘 New knowledge stored");
    } catch (err) {
      console.error("Learning cycle error:", err);
    }
  }, INTERVAL);
}
