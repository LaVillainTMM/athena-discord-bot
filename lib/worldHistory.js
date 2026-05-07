/* ──────────────────────────────────────────────────────
   WORLD HISTORY LEARNER

   Daily, curriculum-driven sweep that progressively teaches
   Athena the complete history of the world — every era, every
   region, every major event, person, movement, technology, war,
   treaty, religion, art form, scientific breakthrough, and
   civilization.

   Strategy:
     1. Track coverage in Firestore collection `history_coverage`
        (one doc per topic, keyed by lowercase topic name).
     2. Each day, pick N topics that have NOT been covered yet,
        rotated across eras + regions for breadth-first coverage.
     3. For each topic, pull a structured dossier via Gemini's
        grounded Google Search (accredited sources only — same
        allow-list as deepResearch.js, no Wikipedia).
     4. Store dossier sections (Origin, Key Events, Key Figures,
        Causes, Consequences, Legacy) as separate athena_knowledge
        entries tagged with historyEra + historyTopic for dedupe.
     5. Mark the topic covered in `history_coverage` so we never
        repeat the same scholarly pass — but the deep-research
        worker can still update individual subjects later.
     6. When the curated curriculum is exhausted, the model is
        asked to suggest fresh under-covered topics so the sweep
        keeps deepening forever.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "../firebase.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

/* ── Curriculum spine — ~500 high-priority topics across all of human history.
      Once these are covered, the model auto-suggests the next batch so the
      curriculum keeps growing. ── */
const ERAS = [
  "Prehistory & Stone Age",
  "Ancient Mesopotamia",
  "Ancient Egypt",
  "Ancient Indus Valley",
  "Ancient China (Shang–Han)",
  "Ancient Greece",
  "Ancient Rome (Republic + Empire)",
  "Ancient Americas (Olmec, Maya, Moche, etc.)",
  "Ancient Africa (Kush, Aksum, Nok)",
  "Late Antiquity (200–600 CE)",
  "Early Middle Ages (Europe, Byzantium, Caliphates)",
  "Islamic Golden Age",
  "Tang & Song China",
  "Medieval Africa (Ghana, Mali, Songhai, Great Zimbabwe)",
  "Medieval India (Gupta, Chola, Delhi Sultanate)",
  "Medieval Japan (Heian–Sengoku)",
  "High & Late Middle Ages (Europe)",
  "Mongol Empire & Successor States",
  "Renaissance",
  "Age of Exploration & Columbian Exchange",
  "Pre-Columbian Empires (Aztec, Inca)",
  "Reformation & Counter-Reformation",
  "Early Modern Africa & Atlantic Slave Trade",
  "Scientific Revolution",
  "Enlightenment",
  "Mughal & Safavid & Ottoman Empires",
  "Edo Japan",
  "Qing China",
  "Atlantic Revolutions (American, French, Haitian, Latin American)",
  "Industrial Revolution",
  "19th-Century Imperialism & Colonization",
  "U.S. Civil War & Reconstruction",
  "Meiji Japan",
  "Late Qing & Republican China",
  "World War I",
  "Interwar Period & Great Depression",
  "Russian Revolution & Soviet Union",
  "World War II",
  "Holocaust & Genocides of the 20th Century",
  "Cold War",
  "Decolonization (Africa, Asia, Caribbean)",
  "U.S. Civil Rights Movement",
  "Vietnam War & Southeast Asia conflicts",
  "Middle Eastern conflicts & oil politics",
  "Fall of the Soviet Union & post-1989 world",
  "Globalization & Information Age",
  "21st-Century conflicts & War on Terror",
  "Climate change & 21st-century crises",
  "History of science & technology",
  "History of religion & philosophy",
  "History of economics & capitalism",
  "History of art, architecture & literature",
  "History of medicine & public health",
  "History of women's rights",
  "History of Indigenous peoples (Americas, Australia, Pacific)",
  "History of the African diaspora",
  "History of LGBT rights",
  "History of labor movements",
];

/* Regions to rotate through — gives breadth across geography. */
const REGIONS = [
  "Mesopotamia", "Egypt", "Greece", "Rome", "Persia", "India", "China",
  "Japan", "Korea", "Southeast Asia", "Central Asia", "Russia",
  "Britain", "France", "Germany", "Italy", "Spain", "Iberia",
  "Scandinavia", "Eastern Europe", "Balkans", "Ottoman Empire",
  "West Africa", "East Africa", "North Africa", "Southern Africa",
  "Mesoamerica", "Andes", "North America", "Caribbean", "Brazil",
  "Australia", "Pacific Islands",
];

/* Cross-cutting topics worth specific deep dives. */
const SPECIAL_TOPICS = [
  "Code of Hammurabi", "Pyramids of Giza", "Library of Alexandria",
  "Battle of Thermopylae", "Punic Wars", "Crucifixion of Jesus",
  "Fall of the Western Roman Empire", "Hijra of Muhammad",
  "Tang–Song printing revolution", "Magna Carta", "Black Death",
  "Fall of Constantinople", "Voyage of Columbus", "Gutenberg printing press",
  "95 Theses / Luther", "Spanish conquest of the Aztecs",
  "Spanish conquest of the Inca", "Mughal Empire",
  "Treaty of Westphalia", "Glorious Revolution", "Newton's Principia",
  "American Declaration of Independence", "French Revolution",
  "Haitian Revolution", "Napoleonic Wars", "Bolívar's campaigns",
  "Opium Wars", "Indian Rebellion of 1857", "Meiji Restoration",
  "Suez Canal", "Berlin Conference", "Boer Wars", "Boxer Rebellion",
  "Russo-Japanese War", "Assassination of Archduke Franz Ferdinand",
  "Treaty of Versailles", "Russian Revolution",
  "Chinese Civil War", "Indian Independence & Partition",
  "Marshall Plan", "Korean War", "Suez Crisis",
  "Cuban Missile Crisis", "Tet Offensive", "Iran Revolution",
  "Soviet–Afghan War", "Fall of the Berlin Wall",
  "Tiananmen Square 1989", "Rwandan Genocide", "Yugoslav Wars",
  "9/11 attacks", "Iraq War", "Arab Spring",
  "Apollo 11 moon landing", "Invention of the internet",
  "Discovery of DNA structure", "Penicillin discovery",
  "Theory of evolution", "Theory of general relativity",
  "Industrial Revolution textile inventions", "Steam engine",
];

const FALLBACK_ERA = "World History — Other";

/* ── Build the curated topic queue (era × region + special topics) ── */
function buildCurriculum() {
  const out = [];
  for (const era of ERAS) out.push({ topic: era, era });
  for (const region of REGIONS) {
    out.push({ topic: `Complete history of ${region}`, era: `Regional History — ${region}` });
  }
  for (const t of SPECIAL_TOPICS) out.push({ topic: t, era: FALLBACK_ERA });
  return out;
}

const CURRICULUM = buildCurriculum();

/* ── History model with grounded search ── */
let historyModel = null;
function getHistoryModel() {
  if (historyModel) return historyModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      historyModel = genAI.getGenerativeModel({
        model: name,
        tools: [{ googleSearch: {} }],
        systemInstruction:
          "You are Athena's world-history scholar. Use Google Search to retrieve " +
          "facts from accredited scholarly and primary sources only: Encyclopaedia " +
          "Britannica, Stanford Encyclopedia of Philosophy, .edu university pages, " +
          ".gov archives, .mil historical centers, national archives (NARA, UK National " +
          "Archives, Bibliothèque nationale, etc.), presidential libraries, JSTOR " +
          "summaries, Smithsonian, Library of Congress, museum collections, and " +
          "accredited press (Reuters, AP, BBC, NYT, WaPo, WSJ, Bloomberg, Guardian, " +
          "FT, Economist, PBS, NPR). NEVER cite Wikipedia. NEVER fabricate. If a " +
          "claim cannot be sourced to an accredited outlet, omit it. Return ONLY the " +
          "JSON the caller requests — no markdown fences, no commentary.",
      });
      console.log(`[WorldHistory] Using model: ${name}`);
      return historyModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[WorldHistory] No history model available");
}

/* ── Coverage tracking in Firestore ── */
const COVERAGE_COLL = "history_coverage";

function topicId(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 200);
}

async function isCovered(topic) {
  try {
    const doc = await firestore.collection(COVERAGE_COLL).doc(topicId(topic)).get();
    return doc.exists;
  } catch (_) {
    return false;
  }
}

async function markCovered(topic, era, sectionsStored) {
  try {
    await firestore.collection(COVERAGE_COLL).doc(topicId(topic)).set({
      topic,
      era:        era || FALLBACK_ERA,
      coveredAt:  admin.firestore.FieldValue.serverTimestamp(),
      sectionsStored,
    }, { merge: true });
  } catch (err) {
    console.warn(`[WorldHistory] markCovered failed for "${topic}": ${err.message}`);
  }
}

/* ── Pick next batch of uncovered curriculum topics, rotated across eras ── */
async function pickNextTopics(count) {
  const out = [];
  const seenEras = new Set();
  /* Shuffle the curriculum lightly so we get variety on each run. */
  const shuffled = [...CURRICULUM].sort(() => Math.random() - 0.5);
  for (const item of shuffled) {
    if (out.length >= count) break;
    /* Prefer one topic per era per pass for breadth. */
    if (seenEras.has(item.era)) continue;
    if (await isCovered(item.topic)) continue;
    out.push(item);
    seenEras.add(item.era);
  }
  /* If we couldn't fill the batch with breadth-rotated picks, top up
     with whatever remains uncovered. */
  if (out.length < count) {
    for (const item of shuffled) {
      if (out.length >= count) break;
      if (out.find(o => o.topic === item.topic)) continue;
      if (await isCovered(item.topic)) continue;
      out.push(item);
    }
  }
  return out;
}

/* If the curriculum is fully covered, ask the model to suggest the next
   batch of historically significant topics it hasn't seen yet. */
async function suggestFreshTopics(count) {
  const recent = await firestore.collection(COVERAGE_COLL)
    .orderBy("coveredAt", "desc").limit(50).get().catch(() => null);
  const recentTitles = recent ? recent.docs.map(d => d.data().topic).join(", ") : "";
  const model = getHistoryModel();
  const prompt =
    `Suggest ${count} historically significant topics worth deep scholarly research that ` +
    `are NOT in this recent list: ${recentTitles}.\n\n` +
    `Mix eras, regions, and types (events, people, movements, inventions, treaties, ` +
    `wars, religions, art forms, declassified episodes). Return JSON ONLY:\n` +
    `{"topics": [{"topic": "name", "era": "era label"}]}`;
  try {
    const res = await model.generateContent(prompt);
    const raw = res.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.topics) ? parsed.topics.slice(0, count) : [];
  } catch (err) {
    console.warn(`[WorldHistory] suggestFreshTopics failed: ${err.message}`);
    return [];
  }
}

/* ── Pull a structured dossier on a single topic ── */
function buildDossierPrompt(topic) {
  return (
    `Build a scholarly dossier on: "${topic}"\n\n` +
    `Return ONE JSON object (no markdown, no prose). Schema:\n` +
    `{\n` +
    `  "summary":      "2-3 sentence executive overview",\n` +
    `  "origin":       "When/where/how it began, with dates",\n` +
    `  "key_events":   ["chronological list of 4-8 most important moments with dates"],\n` +
    `  "key_figures":  ["3-6 most important people, each with one-line role"],\n` +
    `  "causes":       "What led to this — political, economic, cultural, religious factors",\n` +
    `  "consequences": "Immediate aftermath and short-term effects",\n` +
    `  "legacy":       "Long-term impact and how it shapes the world today",\n` +
    `  "sources":      ["3-6 URLs from accredited outlets — NEVER Wikipedia"]\n` +
    `}\n\n` +
    `RULES: Use only accredited sources. Specific dates, names, and numbers. If you ` +
    `cannot find solid sourcing for a section, set it to "unknown" rather than guessing.`
  );
}

async function fetchDossier(topic) {
  const model = getHistoryModel();
  try {
    const res = await model.generateContent(buildDossierPrompt(topic));
    const raw = res.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[WorldHistory] dossier fetch failed for "${topic}": ${err.message}`);
    return null;
  }
}

const SECTIONS = [
  ["summary",      "Summary"],
  ["origin",       "Origin"],
  ["causes",       "Causes"],
  ["key_events",   "Key Events"],
  ["key_figures",  "Key Figures"],
  ["consequences", "Consequences"],
  ["legacy",       "Legacy"],
];

function formatSection(section, value) {
  if (!value || value === "unknown") return "";
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${v}`).join("\n");
  return String(value);
}

/* ── Tag a stored entry with history metadata for dashboards / dedupe ── */
async function tagEntry(title, topic, era, section) {
  try {
    const found = await firestore.collection("athena_knowledge")
      .where("title", "==", title).limit(1).get();
    if (!found.empty) {
      await found.docs[0].ref.update({
        historyTopic:   topic,
        historyEra:     era || FALLBACK_ERA,
        historySection: section,
      });
    }
  } catch (_) { /* best-effort */ }
}

/* ── Public: learn one topic ── */
export async function learnTopic(topic, era = FALLBACK_ERA) {
  const { storeNewKnowledge } = await import("./knowledgeUpdater.js");
  console.log(`[WorldHistory] Learning: ${topic}`);
  const dossier = await fetchDossier(topic);
  if (!dossier) {
    await markCovered(topic, era, 0);
    return 0;
  }
  let stored = 0;
  const sourcesLine = Array.isArray(dossier.sources) && dossier.sources.length
    ? `\n\nSources:\n- ${dossier.sources.join("\n- ")}`
    : "";
  for (const [key, label] of SECTIONS) {
    const body = formatSection(key, dossier[key]);
    if (!body) continue;
    const title = `[HISTORY] ${topic} — ${label}`;
    const ok = await storeNewKnowledge({
      title,
      body:        `${body}${sourcesLine}`,
      source:      Array.isArray(dossier.sources) && dossier.sources[0] ? dossier.sources[0] : "athena_world_history",
      verified:    true,
      explanation: `World-history scholarly dossier (${label}) for ${topic}`,
    });
    if (ok) {
      stored++;
      await tagEntry(title, topic, era, key);
    }
  }
  await markCovered(topic, era, stored);
  /* Queue the topic for the deep-research worker too — that engine adds
     WHO/WHAT/WHERE/HOW dimensions on top of the historical dossier. */
  try {
    const { enqueueSubject } = await import("./deepResearch.js");
    await enqueueSubject(topic, "world_history_curriculum");
  } catch (_) { /* optional */ }
  console.log(`[WorldHistory] ${topic}: stored ${stored} sections`);
  return stored;
}

/* ── Public: run a daily batch ── */
export async function runDailyHistorySweep(batchSize = 10) {
  const start = Date.now();
  let topics = await pickNextTopics(batchSize);
  if (topics.length < batchSize) {
    const need = batchSize - topics.length;
    const fresh = await suggestFreshTopics(need);
    topics = topics.concat(fresh.map(t => ({ topic: t.topic, era: t.era || FALLBACK_ERA })));
  }
  if (!topics.length) {
    console.log(`[WorldHistory] No topics to learn this pass.`);
    return 0;
  }
  console.log(`[WorldHistory] Daily sweep: ${topics.length} topic(s) → ${topics.map(t => t.topic).join(" | ")}`);
  let totalStored = 0;
  for (const t of topics) {
    try {
      totalStored += await learnTopic(t.topic, t.era);
    } catch (err) {
      console.warn(`[WorldHistory] ${t.topic}: ${err.message}`);
    }
    /* Pace ourselves so we don't blow Gemini quota in a tight loop. */
    await new Promise(r => setTimeout(r, 8000));
  }
  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(`[WorldHistory] Daily sweep complete in ${seconds}s — stored ${totalStored} entries.`);
  return totalStored;
}

/* ── Coverage report (used by !history status) ── */
export async function coverageStats() {
  try {
    const snap = await firestore.collection(COVERAGE_COLL).get();
    const total = CURRICULUM.length;
    const covered = snap.size;
    return { covered, curriculum: total, pctCurriculum: total ? Math.round((covered / total) * 100) : 0 };
  } catch {
    return { covered: 0, curriculum: CURRICULUM.length, pctCurriculum: 0 };
  }
}
