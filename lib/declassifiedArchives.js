/* ──────────────────────────────────────────────────────
   DECLASSIFIED ARCHIVES LEARNER

   Daily pull from official declassification reading rooms — the
   legitimate version of "things that may or may not have been
   disclosed to the public": records that WERE classified and have
   since been released through FOIA, the Mandatory Declassification
   Review program, or routine 25/50-year automatic declassification.

   Sources used (all official, all accredited):
     - CIA CREST (CIA Records Search Tool, cia.gov/readingroom)
     - FBI Vault                          (vault.fbi.gov)
     - National Archives NARA             (archives.gov)
     - Foreign Relations of the U.S.      (history.state.gov/historicaldocuments)
     - Department of Defense Reading Room (open.defense.gov / dod.mil)
     - National Security Archive (GWU)    (nsarchive.gwu.edu)
     - Presidential Libraries             (LBJ, Nixon, Reagan, Bush, etc.)
     - UK National Archives               (nationalarchives.gov.uk)

   We cycle a curated list of declassified episodes/programs each
   day, pulling structured dossiers via Gemini grounded search and
   storing them in athena_knowledge tagged with declassifiedTopic.

   IMPORTANT: This module deals only with RELEASED material. It does
   not — and cannot — fetch currently-classified information. Athena's
   policy is accredited sources only; leaks and unverified intel are
   excluded.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "../firebase.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

/* Curated list of declassified programs / episodes worth structured coverage. */
const DECLASSIFIED_TOPICS = [
  /* CIA / NSA programs (released through CREST + FOIA) */
  "MKULTRA program",
  "Project ARTICHOKE",
  "Operation Mockingbird",
  "Operation Northwoods",
  "Project AZORIAN (Glomar Explorer)",
  "Project STARGATE (remote viewing)",
  "Operation CHAOS",
  "Family Jewels (CIA)",
  "Iran-Contra Affair declassified records",
  "Bay of Pigs invasion declassified after-action reports",
  "U-2 program",
  "OXCART / A-12 program",
  "CORONA satellite reconnaissance program",
  "VENONA Project",
  "ECHELON signals intelligence",
  "PRISM (post-Snowden disclosures)",
  /* FBI Vault */
  "COINTELPRO",
  "FBI surveillance of Martin Luther King Jr.",
  "FBI surveillance of John Lennon",
  "Roswell incident FBI memo",
  "Hoover-era FBI domestic surveillance",
  /* Foreign Relations of the U.S. */
  "Cuban Missile Crisis declassified cables",
  "Vietnam War — Pentagon Papers",
  "1953 Iranian coup d'état (Operation AJAX)",
  "1954 Guatemalan coup (Operation PBSUCCESS)",
  "1973 Chilean coup (declassified U.S. records)",
  "Berlin Crisis 1961 declassified records",
  "Yalta Conference records",
  "Nixon White House tapes",
  /* DOD / military */
  "Project BLUE BOOK (UFO investigation)",
  "Manhattan Project declassified records",
  "Operation PAPERCLIP",
  "Tuskegee syphilis study records",
  "Atomic Energy Commission human radiation experiments",
  "Operation IVY Mike",
  "Castle Bravo nuclear test",
  "Project Sunshine",
  /* Modern transparency releases */
  "Snowden NSA disclosures (verified court / oversight records)",
  "JFK assassination records release (2017–2023)",
  "Pentagon UAP task force reports (ODNI)",
  "Senate Torture Report (SSCI 2014)",
  "9/11 Commission Report",
  /* International */
  "UK National Archives — D-Day planning documents",
  "Stasi files release after German reunification",
  "Soviet Politburo meeting transcripts (post-1991 release)",
  "Mitrokhin Archive",
];

const COVERAGE_COLL = "declassified_coverage";

let archiveModel = null;
function getArchiveModel() {
  if (archiveModel) return archiveModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      archiveModel = genAI.getGenerativeModel({
        model: name,
        tools: [{ googleSearch: {} }],
        systemInstruction:
          "You are Athena's declassified-records scholar. Use Google Search to pull " +
          "DOCUMENTED, RELEASED records only from official declassification reading " +
          "rooms: cia.gov/readingroom (CREST), vault.fbi.gov, archives.gov (NARA), " +
          "history.state.gov (FRUS), dod.mil and open.defense.gov, nsarchive.gwu.edu " +
          "(National Security Archive at GWU), presidential library archives " +
          "(LBJ/Nixon/Reagan/Bush/Obama), and nationalarchives.gov.uk. Secondary " +
          "accredited reporting (Reuters, AP, NYT, WaPo, WSJ, BBC, Guardian, PBS, " +
          "ProPublica, NPR) is allowed for context. " +
          "NEVER cite Wikipedia. NEVER cite leaks, conspiracy sites, or unverified " +
          "intelligence. If you cannot find an accredited release for a claim, omit it. " +
          "Return ONLY the JSON the caller requests."
      });
      console.log(`[Declassified] Using model: ${name}`);
      return archiveModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[Declassified] No model available");
}

function topicId(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 200);
}

async function isCovered(topic) {
  try {
    const doc = await firestore.collection(COVERAGE_COLL).doc(topicId(topic)).get();
    return doc.exists;
  } catch { return false; }
}

async function markCovered(topic, sectionsStored) {
  try {
    await firestore.collection(COVERAGE_COLL).doc(topicId(topic)).set({
      topic,
      coveredAt: admin.firestore.FieldValue.serverTimestamp(),
      sectionsStored,
    }, { merge: true });
  } catch (err) {
    console.warn(`[Declassified] markCovered failed for "${topic}": ${err.message}`);
  }
}

async function pickNextTopics(count) {
  const out = [];
  const shuffled = [...DECLASSIFIED_TOPICS].sort(() => Math.random() - 0.5);
  for (const t of shuffled) {
    if (out.length >= count) break;
    if (await isCovered(t)) continue;
    out.push(t);
  }
  return out;
}

function buildPrompt(topic) {
  return (
    `Build a structured declassified-records dossier on: "${topic}"\n\n` +
    `Use only documented, released material from official declassification reading ` +
    `rooms (CIA CREST, FBI Vault, NARA, FRUS, DOD reading room, National Security ` +
    `Archive at GWU, presidential libraries, UK National Archives) and accredited press.\n\n` +
    `Return ONE JSON object (no markdown, no prose):\n` +
    `{\n` +
    `  "summary":        "2-3 sentences explaining what was classified and what was later released",\n` +
    `  "what_happened":  "Operational facts as documented in released records",\n` +
    `  "key_documents":  ["3-6 specific released documents/reports/memos with dates"],\n` +
    `  "key_figures":    ["3-6 named officials/operators with one-line role"],\n` +
    `  "release_history": "When, how, and why the records were released (FOIA, MDR, automatic 25/50-yr, congressional disclosure)",\n` +
    `  "what_remains_redacted": "What is still withheld or partially redacted, per the released records themselves",\n` +
    `  "consequences":   "Documented impact on policy, oversight, public knowledge",\n` +
    `  "sources":        ["3-6 URLs to the actual reading-room pages or accredited reporting — NEVER Wikipedia, NEVER leak sites"]\n` +
    `}\n\n` +
    `If a field cannot be sourced, set it to "unknown" — do not invent.`
  );
}

async function fetchDossier(topic) {
  const model = getArchiveModel();
  try {
    const res = await model.generateContent(buildPrompt(topic));
    const raw = res.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[Declassified] dossier fetch failed for "${topic}": ${err.message}`);
    return null;
  }
}

const SECTIONS = [
  ["summary",               "Summary"],
  ["what_happened",         "What Happened"],
  ["key_documents",         "Key Released Documents"],
  ["key_figures",           "Key Figures"],
  ["release_history",       "Release History"],
  ["what_remains_redacted", "Still Redacted / Withheld"],
  ["consequences",          "Documented Consequences"],
];

function fmt(value) {
  if (!value || value === "unknown") return "";
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${v}`).join("\n");
  return String(value);
}

async function tagEntry(title, topic, section) {
  try {
    const found = await firestore.collection("athena_knowledge")
      .where("title", "==", title).limit(1).get();
    if (!found.empty) {
      await found.docs[0].ref.update({
        declassifiedTopic:   topic,
        declassifiedSection: section,
      });
    }
  } catch (_) { /* best-effort */ }
}

export async function learnDeclassifiedTopic(topic) {
  const { storeNewKnowledge } = await import("./knowledgeUpdater.js");
  console.log(`[Declassified] Learning: ${topic}`);
  const dossier = await fetchDossier(topic);
  if (!dossier) {
    await markCovered(topic, 0);
    return 0;
  }
  const sourcesLine = Array.isArray(dossier.sources) && dossier.sources.length
    ? `\n\nSources:\n- ${dossier.sources.join("\n- ")}`
    : "";
  let stored = 0;
  for (const [key, label] of SECTIONS) {
    const body = fmt(dossier[key]);
    if (!body) continue;
    const title = `[DECLASSIFIED] ${topic} — ${label}`;
    const ok = await storeNewKnowledge({
      title,
      body:        `${body}${sourcesLine}`,
      source:      Array.isArray(dossier.sources) && dossier.sources[0] ? dossier.sources[0] : "athena_declassified",
      verified:    true,
      explanation: `Declassified-records dossier (${label}) for ${topic}`,
    });
    if (ok) {
      stored++;
      await tagEntry(title, topic, key);
    }
  }
  await markCovered(topic, stored);
  console.log(`[Declassified] ${topic}: stored ${stored} sections`);
  return stored;
}

export async function runDailyDeclassifiedSweep(batchSize = 3) {
  const start = Date.now();
  const topics = await pickNextTopics(batchSize);
  if (!topics.length) {
    console.log(`[Declassified] All curated topics covered. Sweep idle.`);
    return 0;
  }
  console.log(`[Declassified] Daily sweep: ${topics.join(" | ")}`);
  let totalStored = 0;
  for (const t of topics) {
    try {
      totalStored += await learnDeclassifiedTopic(t);
    } catch (err) {
      console.warn(`[Declassified] ${t}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 8000));
  }
  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(`[Declassified] Daily sweep complete in ${seconds}s — stored ${totalStored} entries.`);
  return totalStored;
}

export async function declassifiedCoverageStats() {
  try {
    const snap = await firestore.collection(COVERAGE_COLL).get();
    return { covered: snap.size, curriculum: DECLASSIFIED_TOPICS.length };
  } catch {
    return { covered: 0, curriculum: DECLASSIFIED_TOPICS.length };
  }
}
