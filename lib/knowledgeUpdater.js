import { verifyKnowledge } from "./verifyKnowledge.js";
import { admin, firestore } from "../firebase.js";

/* Returns true if stored, false if skipped (duplicate) or failed */
export async function storeNewKnowledge({
  title,
  body,
  source = "autonomous",
  verified = true,
  explanation = null
}) {
  if (!title || !body) {
    console.log("[Firestore:athena_knowledge] Skipped — missing title or body");
    return false;
  }

  try {
    /* Deduplicate — skip if an entry with this exact title already exists */
    const existing = await firestore.collection("athena_knowledge")
      .where("title", "==", title)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log(`[Firestore:athena_knowledge] Skipped (title dup): "${title}"`);
      return false;
    }

    /* ── Source dedupe — Firestore caps indexed string fields at ~1500 bytes,
       and Gemini's grounding-redirect URLs routinely exceed 2000 chars, which
       was failing ~30% of stores with INVALID_ARGUMENT. We compute a short
       sourceKey (truncated to 1000 chars) and dedupe on THAT, while keeping
       the full URL in the `source` field for display/citation. */
    const sourceKey = source && source.length > 1000 ? source.substring(0, 1000) : source;
    if (sourceKey && sourceKey.startsWith("http")) {
      const bySource = await firestore.collection("athena_knowledge")
        .where("sourceKey", "==", sourceKey)
        .limit(1)
        .get();

      if (!bySource.empty) {
        console.log(`[Firestore:athena_knowledge] Skipped (source dup): ${sourceKey.substring(0, 80)}...`);
        return false;
      }
    }

    const ref = await firestore.collection("athena_knowledge").add({
      title,
      content: body,
      source,
      sourceKey,
      verified,
      explanation,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      platform: "athena_autonomous",
      user_id: null
    });

    console.log(`[Firestore:athena_knowledge] Stored ${ref.id} — "${title}"`);

    /* ── Spawn a deep-research dossier on the subjects in this fact ──
       Dynamic import avoids the circular dep (deepResearch → storeNewKnowledge).
       Skip when the entry IS itself a deep-research result, otherwise we'd
       infinitely recurse on every Person/Place/Thing forever. */
    const isResearchEntry = /^\[(WHO|WHAT|WHERE|HOW)\]/.test(title);
    if (!isResearchEntry) {
      import("./deepResearch.js")
        .then(({ autoQueueFromKnowledge }) => autoQueueFromKnowledge(title, body))
        .catch(err => console.warn("[DeepResearch] auto-queue failed:", err.message));
    }

    return true;
  } catch (error) {
    console.error(`[Firestore:athena_knowledge] storeNewKnowledge FAILED for "${title}":`, error.message);
    return false;
  }
}

export function startAutonomousLearning(fetchFact) {
  if (typeof fetchFact !== "function") {
    throw new Error("fetchFact must be a function");
  }

  console.log("[Learning] Athena autonomous learning started (60s interval)");

  /* Track recently seen titles in-memory to avoid redundant Firestore queries */
  const recentlySeen = new Set();
  const MAX_SEEN = 200;

  let cycleNum = 0;
  const INTERVAL = 60 * 1000; /* 60 seconds */

  setInterval(async () => {
    cycleNum++;
    try {
      let fact;
      try {
        fact = await fetchFact();
      } catch (fetchErr) {
        console.error(`[Learning] Cycle ${cycleNum}: fetchFact threw —`, fetchErr.message);
        return;
      }

      if (!fact) {
        console.log(`[Learning] Cycle ${cycleNum}: fetchFact returned null (no new fact this cycle)`);
        return;
      }

      const title = fact.title || "Autonomous Learning";

      /* In-memory dedupe before hitting Firestore */
      if (recentlySeen.has(title)) {
        console.log(`[Learning] Cycle ${cycleNum}: in-memory dup, skipping "${title}"`);
        return;
      }

      const stored = await storeNewKnowledge({
        title,
        body: fact.content || fact,
        source: fact.source || "athena_autonomous"
      });

      recentlySeen.add(title);
      if (recentlySeen.size > MAX_SEEN) {
        const first = recentlySeen.values().next().value;
        recentlySeen.delete(first);
      }

      if (stored) {
        console.log(`[Learning] Cycle ${cycleNum}: stored new knowledge "${title}"`);
      } else {
        console.log(`[Learning] Cycle ${cycleNum}: store skipped or failed for "${title}"`);
      }
    } catch (err) {
      console.error(`[Learning] Cycle ${cycleNum} error:`, err.message);
    }
  }, INTERVAL);
}
