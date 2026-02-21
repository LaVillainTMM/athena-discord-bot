// lib/knowledgeUpdater.js
import { setTimeout as wait } from "timers/promises";
import { firestore, admin } from "../firebase.js";

let _cache = new Map();
let _lastLoadedAt = null;
let _running = false;
let _stopped = false;
let _listeners = [];

/* ----------------- BASIC CACHE FUNCTIONS ----------------- */
export function getEntry(id) {
  return _cache.get(id) ?? null;
}

export function getAllEntries() {
  return Array.from(_cache.values());
}

export function searchEntries(query, max = 10) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase();
  const results = [];
  for (const entry of _cache.values()) {
    const score =
      (entry.title?.toLowerCase().includes(q) ? 2 : 0) +
      (entry.body?.toLowerCase().includes(q) ? 1 : 0);
    if (score > 0) results.push({ entry, score });
  }
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(r => r.entry);
}

export function subscribe(listener) {
  _listeners.push(listener);
  return () => {
    const idx = _listeners.indexOf(listener);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

function _emit(entries) {
  for (const l of _listeners) {
    try {
      l(entries);
    } catch (err) {
      console.error("[Knowledge] listener error", err);
    }
  }
}


         // ---------------- GEMINI SETUP ----------------
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* =====================================================
   VERIFIED FACT GENERATION
===================================================== */
async function generateVerifiedFact() {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro"
  });

  const prompt = `
You are Athena, an autonomous research AI.

Find ONE REAL, RECENT, VERIFIABLE fact from:
- science
- technology
- global news
- research publications
- conferences
- press releases

Rules:
- Must be factual
- Must be specific
- No opinions
- No placeholders

Return STRICT JSON ONLY:

{
"title": "",
"fact": "",
"verified": true,
"explanation": "",
"source_type": ""
}
`;

  const result = await model.generateContent(prompt);

  let text = result.response.text()
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(text);
}
