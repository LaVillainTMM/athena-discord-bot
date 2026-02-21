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

/* ----------------- STORE NEW KNOWLEDGE ----------------- */
export async function storeNewKnowledge({ title, body, sourceUserId, platform }) {
  if (!body || !body.trim()) return;

  const normalizedBody = body.trim().toLowerCase();
  const exists = Array.from(_cache.values()).some(
    e => (e.body || "").trim().toLowerCase() === normalizedBody
  );

  if (exists) return;

  try {
    await firestore.collection("knowledge_updates").add({
      title: title || "general",
      body: body.trim(),
      user_id: sourceUserId,
      platform,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      verified: false,
    });

    console.log("[Learning] New knowledge queued for review:", title, body);
  } catch (err) {
    console.error("[Learning] Failed to store new knowledge:", err.message);
  }
}

/* ----------------- INITIALIZE UPDATER ----------------- */
export async function initKnowledgeUpdater(firestoreInstance, options = {}) {
  if (_running) return { getEntry, searchEntries, getAllEntries, subscribe, storeNewKnowledge };

  const {
    collection = "athena_knowledge",
    intervalMs = +(process.env.KNOWLEDGE_REFRESH_INTERVAL_MS || 5 * 60 * 1000),
    maxRetries = 5,
    initialLoad = true,
    logger = console
  } = options;

  _running = true;
  _stopped = false;

  async function loadOnce() {
    try {
      logger.info(`[Knowledge] loading from ${collection} ...`);
      const snap = await firestoreInstance.collection(collection).get();

      if (snap.empty) logger.warn(`[Knowledge] collection "${collection}" is empty or missing`);

      const entries = [];
      snap.forEach(doc => {
        const data = doc.data();
        const entry = {
          id: doc.id,
          title: data.title || "",
          body: data.body || "",
          tags: data.tags || [],
          updatedAt: data.updatedAt?.toDate?.() || new Date()
        };
        entries.push(entry);
      });

      const newMap = new Map();
      for (const e of entries) newMap.set(e.id, e);
      _cache = newMap;
      _lastLoadedAt = new Date();
      logger.info(`[Knowledge] loaded ${entries.length} entries (at ${_lastLoadedAt.toISOString()})`);
      _emit(Array.from(_cache.values()));
      return true;
    } catch (err) {
      logger.error("[Knowledge] load failed:", err);
      return false;
    }
  }

  if (initialLoad) {
    let attempt = 0;
    let ok = false;
    while (attempt < maxRetries && !ok) {
      ok = await loadOnce();
      if (!ok) {
        attempt++;
        const backoffMs = Math.min(60_000, 500 * 2 ** attempt);
        logger.warn(`[Knowledge] retry ${attempt}/${maxRetries} after ${backoffMs}ms`);
        await wait(backoffMs);
      }
    }
  } else {
    _cache = new Map();
  }

  (async function backgroundLoop() {
    while (!_stopped) {
      try {
        const ok = await loadOnce();
        await wait(ok ? intervalMs : Math.min(60_000, Math.max(5000, intervalMs / 6)));
      } catch (err) {
        logger.error("[Knowledge] background loop error:", err);
        await wait(Math.min(60_000, Math.max(5000, intervalMs / 6)));
      }
    }
    _running = false;
  })();

  return { getEntry, searchEntries, getAllEntries, subscribe, storeNewKnowledge };
}

/* ----------------- AUTONOMOUS LEARNING ----------------- */
export function startAutonomousLearning(storeFn, intervalMs = 180_000) { // 3 min default
  async function gatherKnowledge() {
    try {
      // Placeholder for real web/news scraping or API calls
      const newFact = {
        title: `Autonomous Fact ${new Date().toISOString()}`,
        body: `Sample fact collected automatically at ${new Date().toISOString()}`,
        sourceUserId: null,
        platform: "autonomous"
      };

      await storeFn(newFact);
      console.log(`[Autonomous Learning] Added new knowledge at ${new Date().toISOString()}`);
    } catch (err) {
      console.error("[Autonomous Learning] Failed to store knowledge:", err);
    }
  }

  gatherKnowledge();
  return setInterval(gatherKnowledge, intervalMs);
}

/* ----------------- STOP ----------------- */
export function stopUpdater() {
  _stopped = true;
}
