/* ──────────────────────────────────────────────────────
   ATHENA KNOWLEDGE GAP ANALYZER

   Periodically self-reviews athena_knowledge, clusters
   what she knows by topic, and detects GAPS within each
   cluster — e.g. "lots of construction theory, no
   step-by-step builds from locally-available materials."

   For every detected gap, a research subject is queued
   into research_queue with subjectType="practical" so the
   deep-research worker turns it into a step-by-step,
   materials-aware, multi-day-progress dossier instead of
   the default WHO/WHAT/WHERE/HOW entity dossier.

   Cycle: every 30 min, sample 200 random entries, ask
   Gemini for top clusters + 1-3 gaps per cluster + 1
   research topic per gap. All cycles logged to
   knowledge_gap_reports for audit.

   Source policy mirrors deepResearch.js — accredited
   sources only, Wikipedia banned.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "../firebase.js";
import { enqueueSubject } from "./deepResearch.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

let analyzerModel = null;
function getAnalyzerModel() {
  if (analyzerModel) return analyzerModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      analyzerModel = genAI.getGenerativeModel({
        model: name,
        systemInstruction:
          "You are Athena's self-review engine. You analyze a sample of " +
          "what she already knows, identify topical clusters, and find GAPS — " +
          "areas where the knowledge is theoretical but lacks practical / " +
          "step-by-step / locally-sourced / beginner-actionable depth. Respond " +
          "with strict JSON only, no prose, no markdown fences.",
      });
      console.log(`[GapAnalyzer] Using model: ${name}`);
      return analyzerModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[GapAnalyzer] No analyzer model available");
}

/* ── Sample N random verified entries from athena_knowledge ──
   Firestore has no native random sampling; we offset-sample by
   pulling a window from a randomized starting docId boundary. To
   keep cost bounded we pull `windowSize` then random-shuffle and
   take `n`. */
async function sampleKnowledge(n = 200, windowSize = 600) {
  const snap = await firestore.collection("athena_knowledge")
    .where("verified", "==", true)
    .limit(windowSize)
    .get();

  if (snap.empty) return [];

  const docs = snap.docs.slice();
  /* Fisher-Yates shuffle, then take first n. */
  for (let i = docs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [docs[i], docs[j]] = [docs[j], docs[i]];
  }
  return docs.slice(0, n).map(d => {
    const data = d.data();
    return {
      title: (data.title || data.topic || "").substring(0, 180),
      body:  (data.content || data.body || "").substring(0, 280),
    };
  });
}

/* ── Build the rubric prompt and call Gemini ── */
async function analyzeGaps(sample) {
  if (!sample.length) return { clusters: [] };

  /* Compact the sample — just titles + a 1-line snippet keeps the prompt
     well under the model's context window even at 200 entries. */
  const lines = sample
    .map((s, i) => `${i + 1}. ${s.title} — ${s.body}`)
    .join("\n");

  const model = getAnalyzerModel();
  const prompt =
    "Below is a random sample of what Athena currently knows. Review it as a " +
    "knowledge librarian would.\n\n" +
    "Step 1 — identify the top 3-6 topical CLUSTERS present in this sample.\n" +
    "Step 2 — for EACH cluster, find 1-3 GAPS using this rubric:\n" +
    "  • theoretical-vs-practical (knows the concept but not how to DO it)\n" +
    "  • abstract-vs-stepwise (no day-by-day / phase-by-phase progression)\n" +
    "  • global-vs-local-materials (no guidance on what's reachable in a given area)\n" +
    "  • expert-vs-beginner (assumes prior expertise, no entry-point)\n" +
    "  • historical-vs-current (only old facts, no recent developments)\n" +
    "  • single-source-vs-cross-referenced (one outlet only)\n" +
    "Step 3 — for EACH gap, propose ONE concrete research topic phrased as a " +
    "question or how-to that, when answered, would close the gap. The topic " +
    "must be specific enough to research deeply (avoid vague topics like " +
    "'learn more about X'). Topics that close practical/stepwise/local-materials " +
    "gaps should be phrased as 'How to <do specific thing> step by step using " +
    "<commonly available materials/tools> over <realistic timeline>'.\n\n" +
    "SAMPLE:\n" + lines + "\n\n" +
    "Return STRICT JSON only:\n" +
    "{\n" +
    '  "clusters": [\n' +
    "    {\n" +
    '      "cluster": "<short cluster name>",\n' +
    '      "summary": "<1-sentence what she knows in this cluster>",\n' +
    '      "gaps": [\n' +
    "        {\n" +
    '          "gapType": "theoretical-vs-practical | abstract-vs-stepwise | global-vs-local-materials | expert-vs-beginner | historical-vs-current | single-source-vs-cross-referenced",\n' +
    '          "description": "<1-sentence gap>",\n' +
    '          "researchTopic": "<concrete research topic / how-to question>",\n' +
    '          "subjectType": "practical | entity"\n' +
    "        }\n" +
    "      ]\n" +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "subjectType=\"practical\" for any how-to / step-by-step / materials-list / " +
    "timeline-based topic. subjectType=\"entity\" for who/what/where/how-it-works " +
    "questions about a named person, place, or thing.";

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (!parsed?.clusters || !Array.isArray(parsed.clusters)) return { clusters: [] };
    return parsed;
  } catch (err) {
    console.warn("[GapAnalyzer] analysis call failed:", err.message);
    return { clusters: [] };
  }
}

/* ── One review cycle ── */
export async function runGapCycle() {
  const sample = await sampleKnowledge(200, 600);
  if (!sample.length) {
    console.log("[GapAnalyzer] No knowledge to sample yet — skipping cycle.");
    return { sampled: 0, clusters: 0, queued: 0 };
  }

  console.log(`[GapAnalyzer] Reviewing ${sample.length} entries...`);
  const report = await analyzeGaps(sample);

  let queued = 0;
  let totalGaps = 0;
  for (const c of report.clusters) {
    if (!Array.isArray(c.gaps)) continue;
    for (const g of c.gaps) {
      totalGaps++;
      const topic = (g.researchTopic || "").trim();
      if (!topic || topic.length < 8) continue;
      const ok = await enqueueSubject(topic, `gap:${c.cluster}/${g.gapType}`, {
        subjectType: g.subjectType === "entity" ? "entity" : "practical",
        gapType:     g.gapType || null,
        cluster:     c.cluster || null,
      });
      if (ok) queued++;
    }
  }

  /* Audit log — keep a paper trail of every review. */
  try {
    await firestore.collection("knowledge_gap_reports").add({
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      sampledCount: sample.length,
      clusterCount: report.clusters.length,
      gapCount:     totalGaps,
      queuedCount:  queued,
      clusters:     report.clusters.map(c => ({
        cluster: c.cluster || null,
        summary: c.summary || null,
        gaps:    (c.gaps || []).map(g => ({
          gapType:       g.gapType || null,
          description:   g.description || null,
          researchTopic: g.researchTopic || null,
          subjectType:   g.subjectType || null,
        })),
      })),
    });
  } catch (err) {
    console.warn("[GapAnalyzer] report write failed:", err.message);
  }

  console.log(
    `[GapAnalyzer] Reviewed ${sample.length} entries → ${report.clusters.length} clusters, ` +
    `${totalGaps} gaps identified, ${queued} new research topics queued.`
  );
  return { sampled: sample.length, clusters: report.clusters.length, queued };
}

/* ── Background loop ── */
export function startGapAnalyzer() {
  const INTERVAL = 30 * 60 * 1000; /* 30 minutes */
  console.log(`[GapAnalyzer] Self-review loop started (${INTERVAL / 60000} min interval)`);

  /* First cycle delayed 5 min so startup probes / backfill / first
     learning cycles can populate the knowledge base. */
  setTimeout(() => {
    runGapCycle().catch(err =>
      console.error("[GapAnalyzer] First cycle error:", err.message)
    );
    setInterval(() => {
      runGapCycle().catch(err =>
        console.error("[GapAnalyzer] Cycle error:", err.message)
      );
    }, INTERVAL);
  }, 5 * 60 * 1000);
}
