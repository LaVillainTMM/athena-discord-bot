// lib/knowledgeUpdater.js
import { setTimeout as wait } from "timers/promises";

let _cache = new Map();
let _lastLoadedAt = null;
let _running = false;
let _stopped = false;
let _listeners = [];

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

/**
 * Initialize the updater. Start background refresh automatically.
 *
 * Options:
 * - collection = 'knowledge_entries' (Firestore collection name)
 * - intervalMs = 5 * 60 * 1000 (default 5 minutes)
 * - maxRetries = 5
 * - initialLoad = true
 * - logger = console
 */
export async function initKnowledgeUpdater(firestore, options = {}) {
  if (_running) return { getEntry, searchEntries, getAllEntries, subscribe };

  const {
    collection = "knowledge_entries",
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

      const snap = await firestore.collection(collection).get();
      if (snap.empty) {
        logger.warn(`[Knowledge] collection "${collection}" is empty or missing`);
      }

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

      // replace cache atomically
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

  // initial load with retry/backoff
  if (initialLoad) {
    let attempt = 0;
    let ok = false;
    while (attempt < maxRetries && !ok) {
      ok = await loadOnce();
      if (!ok) {
        attempt++;
        const backoffMs = Math.min(60_000, 500 * 2 ** attempt); // 500ms * 2^attempt capped at 60s
        logger.warn(`[Knowledge] retry ${attempt}/${maxRetries} after ${backoffMs}ms`);
        await wait(backoffMs);
      }
    }
  } else {
    _cache = new Map();
  }

  // background loop
  (async function backgroundLoop() {
    while (!_stopped) {
      try {
        const ok = await loadOnce();
        if (!ok) {
          await wait(Math.min(60_000, Math.max(5000, intervalMs / 6)));
        } else {
          await wait(intervalMs);
        }
      } catch (err) {
        logger.error("[Knowledge] background loop error:", err);
        await wait(Math.min(60_000, Math.max(5000, intervalMs / 6)));
      }
    }
    _running = false;
  })();

  return { getEntry, searchEntries, getAllEntries, subscribe };
}

export function stopUpdater() {
  _stopped = true;
}
