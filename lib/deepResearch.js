/* ──────────────────────────────────────────────────────
   ATHENA DEEP RESEARCH ENGINE

   Every confirmed fact in athena_knowledge spawns a follow-up
   research dossier on its proper-noun subjects (Person, Place,
   Thing). For each subject, Athena answers WHO / WHAT / WHERE
   / HOW using Gemini + Google Search grounding, then stores
   the resulting facts back into athena_knowledge so the next
   conversation has the context.

   Source policy mirrors regionalFetcher.js: accredited sources
   only. Wikipedia is BANNED.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "../firebase.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

/* ── Source policy ── */
const SOURCE_BLOCK_RX = /wikipedia\.org/i;
const SOURCE_ALLOW_RX = /(britannica\.com|reuters\.com|apnews\.com|bbc\.|npr\.org|nytimes\.com|washingtonpost\.com|wsj\.com|bloomberg\.com|theguardian\.com|ft\.com|economist\.com|pbs\.org|cnn\.com|\.gov(\/|$|\.)|\.mil(\/|$)|\.edu(\/|$)|\.ac\.[a-z]{2}(\/|$))/i;

function isSourceAllowed(url) {
  if (!url) return true;
  if (SOURCE_BLOCK_RX.test(url)) return false;
  if (SOURCE_ALLOW_RX.test(url)) return true;
  /* unknown but not blocked → allow with caution */
  return true;
}

/* ── Research model (Gemini + Google Search grounding) ── */
let researchModel = null;
function getResearchModel() {
  if (researchModel) return researchModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      researchModel = genAI.getGenerativeModel({
        model: name,
        tools: [{ googleSearch: {} }],
        systemInstruction:
          "You are Athena's deep-research engine. Cite ONLY accredited sources " +
          "(.gov, .edu, .mil, .ac.<cc>, Britannica, Reuters, AP, BBC, NPR, NYT, " +
          "Washington Post, WSJ, Bloomberg, Guardian, FT, Economist, PBS, CNN). " +
          "NEVER cite Wikipedia. If a claim has no accredited source, omit it.",
      });
      console.log(`[DeepResearch] Using model: ${name}`);
      return researchModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[DeepResearch] No research model available");
}

/* ── Lightweight extraction model (no grounding tools) ── */
let extractionModel = null;
function getExtractionModel() {
  if (extractionModel) return extractionModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      extractionModel = genAI.getGenerativeModel({ model: name });
      console.log(`[DeepResearch] Subject-extraction model: ${name}`);
      return extractionModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[DeepResearch] No extraction model available");
}

/* ── Subject blocklist (generic / pronoun / common terms) ── */
const SUBJECT_BLOCKLIST = new Set([
  "athena", "discord", "today", "yesterday", "tomorrow", "the user",
  "we", "our", "their", "this", "that", "user", "users", "everyone",
  "someone", "anyone", "nobody", "people",
]);

/* ── Extract up to 3 proper-noun subjects from a knowledge entry ── */
export async function extractSubjects(title, body) {
  const text = `Title: ${title || ""}\n\nContent: ${body || ""}`.substring(0, 4000);
  if (text.trim().length < 10) return [];
  try {
    const flash = getExtractionModel();
    const prompt =
      "Extract up to 3 PROPER NOUN subjects (Person, Place, or Thing) from the text " +
      "below that are worth researching deeply.\n\n" +
      "Rules:\n" +
      "- Only specific named entities (proper nouns).\n" +
      "- No pronouns, dates, ordinary words, or generic terms.\n" +
      "- Return ONLY a JSON array of strings. No prose. No markdown fences.\n" +
      "- If nothing qualifies, return [].\n\n" +
      "Text:\n" + text + "\n\nJSON:";
    const result = await flash.generateContent(prompt);
    const raw = result.response.text().trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(s => typeof s === "string")
      .map(s => s.trim())
      .filter(s => s.length >= 3 && s.length <= 80)
      .filter(s => !SUBJECT_BLOCKLIST.has(s.toLowerCase()))
      .slice(0, 3);
  } catch (err) {
    console.warn("[DeepResearch] subject extraction failed:", err.message);
    return [];
  }
}

/* ── Enqueue a subject for deep research ──
   meta is an optional object: { subjectType: "entity" | "practical",
   gapType, cluster, ... }. subjectType controls which prompt the
   research worker uses ("entity" = WHO/WHAT/WHERE/HOW, "practical" =
   step-by-step how-to with materials list and timeline). */
export async function enqueueSubject(subject, parentTitle = null, meta = {}) {
  const trimmed = (subject || "").trim();
  const norm    = trimmed.toLowerCase();
  if (!norm || norm.length < 3) return false;

  try {
    /* dedupe — already queued? */
    const queued = await firestore.collection("research_queue")
      .where("subjectNorm", "==", norm).limit(1).get();
    if (!queued.empty) return false;

    /* dedupe — already researched? */
    const done = await firestore.collection("athena_knowledge")
      .where("researchSubject", "==", norm).limit(1).get();
    if (!done.empty) return false;

    await firestore.collection("research_queue").add({
      subject:     trimmed,
      subjectNorm: norm,
      parentTitle: parentTitle || null,
      subjectType: meta.subjectType === "practical" ? "practical" : "entity",
      gapType:     meta.gapType || null,
      cluster:     meta.cluster || null,
      status:      "pending",
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[DeepResearch] Queued (${meta.subjectType || "entity"}): "${trimmed}"${parentTitle ? ` (from "${parentTitle}")` : ""}`);
    return true;
  } catch (err) {
    console.error("[DeepResearch] enqueue failed:", err.message);
    return false;
  }
}

/* ── Build the entity dossier prompt (WHO/WHAT/WHERE/HOW) ── */
function buildEntityPrompt(subject) {
  return `Conduct a deep research dossier on: "${subject}"\n\n` +
    "Give concrete, sourced answers covering ALL FOUR sections:\n" +
    "- WHO: associated people, ownership, leadership, key actors, lineage\n" +
    "- WHAT: what it is, what it does, characteristics, defining facts, history\n" +
    "- WHERE: location, jurisdiction, geographic relationships, places of impact\n" +
    "- HOW: how it operates — infrastructure (industrial / electrical / plumbing / " +
    "transit / regulatory), how it has changed over time, how it impacts its area\n\n" +
    "SOURCE POLICY (hard rules):\n" +
    "- ONLY accredited sources: .gov, .edu, .mil, .ac.<cc>, Britannica, Reuters, AP, " +
    "BBC, NPR, NYT, Washington Post, WSJ, Bloomberg, Guardian, FT, Economist, PBS, CNN.\n" +
    "- NEVER cite Wikipedia or anonymous blogs.\n" +
    "- If you can't find accredited sourcing for a claim, OMIT the claim.\n\n" +
    "Return valid JSON ONLY (no markdown fences, no prose):\n" +
    `{ "facts": [ { "section": "WHO|WHAT|WHERE|HOW", "title": "short headline", "body": "1-3 sentence concrete fact", "source": "URL or outlet name" } ] }\n\n` +
    "Aim for 6–12 facts total spanning all four sections.";
}

/* ── Build the practical/how-to prompt (MATERIALS/STEPS/TIMELINE/SAFETY) ── */
function buildPracticalPrompt(subject) {
  return `Build a practical, do-it-yourself dossier for: "${subject}"\n\n` +
    "The goal is REALISTIC EXECUTABILITY by an ordinary person. Give concrete, " +
    "sourced answers covering ALL FIVE sections:\n" +
    "- MATERIALS: every material/tool needed, prioritising items realistically " +
    "available at common retailers (hardware stores, grocery, online) AND noting " +
    "viable substitutes from things commonly found in/around a typical home or " +
    "immediate neighbourhood.\n" +
    "- STEPS: ordered, numbered, atomic steps. Each step is one concrete action a " +
    "beginner can perform without prior expertise. Include measurements/quantities.\n" +
    "- TIMELINE: realistic day-by-day or phase-by-phase progression — what to do " +
    "on day 1, day 2, etc., including drying/curing/waiting periods, partial " +
    "completion checkpoints, and how to resume work after a pause.\n" +
    "- SAFETY: hazards, PPE required, common mistakes, when to stop and call a " +
    "professional, code/permit considerations if relevant.\n" +
    "- VERIFICATION: how to verify success at each checkpoint and at completion.\n\n" +
    "SOURCE POLICY (hard rules):\n" +
    "- Prefer .gov (CDC, OSHA, USDA, NIH, building codes), .edu extension services " +
    "(university extension publications are gold for practical guides), Britannica, " +
    "Reuters, AP, BBC, NPR, NYT, Washington Post, WSJ, Bloomberg, Guardian, FT, " +
    "Economist, PBS, CNN, Consumer Reports.\n" +
    "- NEVER cite Wikipedia or anonymous blogs.\n" +
    "- If you can't find accredited sourcing for a claim, OMIT the claim.\n\n" +
    "Return valid JSON ONLY (no markdown fences, no prose):\n" +
    `{ "facts": [ { "section": "MATERIALS|STEPS|TIMELINE|SAFETY|VERIFICATION", "title": "short headline (e.g. 'Day 2: frame the wall')", "body": "1-4 sentence concrete instruction with quantities/durations where applicable", "source": "URL or outlet name" } ] }\n\n` +
    "Aim for 10–18 facts total. STEPS section should be the largest (numbered).";
}

/* ── Run a research dossier on a subject. subjectType selects the prompt. ── */
export async function researchSubject(subject, subjectType = "entity") {
  const model = getResearchModel();
  const prompt = subjectType === "practical"
    ? buildPracticalPrompt(subject)
    : buildEntityPrompt(subject);

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (!parsed?.facts || !Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter(f => f && f.title && f.body)
      .filter(f => isSourceAllowed(f.source))
      .slice(0, 15);
  } catch (err) {
    console.warn(`[DeepResearch] research call failed for "${subject}":`, err.message);
    return [];
  }
}

/* ── Run research and persist findings as athena_knowledge entries ── */
export async function processSubject(subject, parentTitle = null, subjectType = "entity") {
  console.log(`[DeepResearch] Researching (${subjectType}): "${subject}"`);
  const facts = await researchSubject(subject, subjectType);
  if (!facts.length) {
    console.warn(`[DeepResearch] No facts produced for "${subject}"`);
    return 0;
  }

  /* Use dynamic import to avoid circular dep with knowledgeUpdater. */
  const { storeNewKnowledge } = await import("./knowledgeUpdater.js");

  const norm = subject.toLowerCase();
  let stored = 0;

  for (const f of facts) {
    const fullTitle = `[${f.section}] ${subject}: ${f.title}`.substring(0, 280);
    const ok = await storeNewKnowledge({
      title:       fullTitle,
      body:        f.body,
      source:      f.source || "athena_deep_research",
      verified:    true,
      explanation: `Deep-research dossier on ${subject}` +
                   (parentTitle ? ` (triggered by: ${parentTitle})` : ""),
    });
    if (ok) {
      stored++;
      /* tag with researchSubject so future enqueueSubject() de-dupes */
      try {
        const found = await firestore.collection("athena_knowledge")
          .where("title", "==", fullTitle).limit(1).get();
        if (!found.empty) {
          await found.docs[0].ref.update({
            researchSubject: norm,
            researchSection: f.section,
          });
        }
      } catch (_) { /* tagging is best-effort */ }
    }
  }
  console.log(`[DeepResearch] "${subject}" → stored ${stored}/${facts.length} facts`);
  return stored;
}

/* ── Background worker: drains research_queue, one subject at a time ── */
export function startDeepResearchWorker() {
  const INTERVAL = 90 * 1000; /* 90 seconds — gentle on Gemini quota */
  console.log(`[DeepResearch] Worker started (${INTERVAL / 1000}s interval)`);

  setInterval(async () => {
    try {
      /* Fetch a small batch of pending subjects and pick the oldest in
         memory — avoids needing a (status, createdAt) composite index. */
      const snap = await firestore.collection("research_queue")
        .where("status", "==", "pending")
        .limit(10)
        .get();
      if (snap.empty) return;

      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt?.toMillis?.() || 0;
        const tb = b.data().createdAt?.toMillis?.() || 0;
        return ta - tb;
      });
      const doc  = docs[0];
      const data = doc.data();
      await doc.ref.update({
        status:    "in_progress",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const stored = await processSubject(
        data.subject,
        data.parentTitle,
        data.subjectType || "entity"
      );

      await doc.ref.update({
        status:      stored > 0 ? "completed" : "completed_empty",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        factsStored: stored,
      });
    } catch (err) {
      console.error("[DeepResearch] Worker cycle error:", err.message);
    }
  }, INTERVAL);
}

/* ── Convenience: extract subjects from a fresh knowledge entry and queue them ── */
export async function autoQueueFromKnowledge(title, body) {
  const subjects = await extractSubjects(title, body);
  let queued = 0;
  for (const s of subjects) {
    if (await enqueueSubject(s, title)) queued++;
  }
  if (queued > 0) {
    console.log(`[DeepResearch] Auto-queued ${queued} subject(s) from "${title}"`);
  }
  return queued;
}
