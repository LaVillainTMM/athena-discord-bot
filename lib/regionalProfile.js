/* ──────────────────────────────────────────────────────
   REGIONAL PROFILE FETCHER

   For each region (U.S. state or continent), pulls plain-text
   summaries from Wikipedia covering:
     - History          (origin, how it came to be)
     - Geography        (landscape, landmarks, geographic change)
     - Economy          (industrialization, modern industries)
     - Demographics     (people and how the population has shifted)

   Source: Wikipedia REST summary API (no key required).
     https://en.wikipedia.org/api/rest_v1/page/summary/<Title>

   Designed to run ONCE per region (storeNewKnowledge dedupes by title)
   so the bot accumulates a permanent origin/history record alongside
   the rotating daily news sweep.
────────────────────────────────────────────────────── */

const TOPICS = [
  { key: "History",      label: "Origin & History" },
  { key: "Geography",    label: "Geography & Landmarks" },
  { key: "Economy",      label: "Economy & Industrialization" },
  { key: "Demographics", label: "People & Demographics" },
];

/* Polite single-flight queue — Wikipedia is generous but we still
   space requests so the bot is a well-behaved client. */
const MIN_GAP_MS = 600;
let lastCallAt = 0;
let chain = Promise.resolve();

function queue(fn) {
  const job = chain.then(fn);
  chain = job.catch(() => {});
  return job;
}

async function wikiSummary(title) {
  return queue(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();

    const slug = encodeURIComponent(title.replace(/\s+/g, "_"));
    const url  = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
    const res  = await fetch(url, {
      headers: {
        "User-Agent": "AthenaBot/1.0 (DBI NationZ Discord; contact: lavillaintmm)",
        "Accept":     "application/json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    const data = await res.json();
    if (!data.extract || !data.extract.trim()) return null;
    return {
      title:   data.title || title,
      extract: data.extract.trim(),
      url:     data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${slug}`,
    };
  });
}

/* Build the four topic entries for a region. Skips topics where the
   "Topic of <Region>" article doesn't exist (Wikipedia 404). */
export async function fetchRegionalProfile(region) {
  const entries = [];
  for (const topic of TOPICS) {
    const candidate = `${topic.key} of ${region.name}`;
    try {
      const summary = await wikiSummary(candidate);
      if (!summary) continue;
      const title = `${region.name} (${region.category}) — ${topic.label}`;
      const body  =
        `${summary.extract}\n\n` +
        `Source: Wikipedia (${summary.title})\n` +
        `URL: ${summary.url}`;
      entries.push({
        title,
        content:  body,
        source:   summary.url,
        verified: true,
        region:   region.name,
        category: `${region.category} — ${topic.label}`,
      });
    } catch (err) {
      console.warn(`[RegionalProfile] ${candidate}: ${err.message}`);
    }
  }
  return entries;
}

/* Iterate every region and store all available profile entries.
   Designed to run once at startup; subsequent runs are cheap because
   storeNewKnowledge dedupes by title before doing any heavy work. */
export async function runProfileSweep(regions, storeFn) {
  const start = Date.now();
  let stored = 0, skipped = 0, failed = 0;

  console.log(`[RegionalProfile] Starting profile sweep across ${regions.length} regions...`);

  for (const region of regions) {
    try {
      const entries = await fetchRegionalProfile(region);
      for (const entry of entries) {
        const ok = await storeFn(entry);
        if (ok) stored++; else skipped++;
      }
    } catch (err) {
      failed++;
      console.warn(`[RegionalProfile] ${region.name}: ${err.message}`);
    }
  }

  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(
    `[RegionalProfile] Complete in ${seconds}s — stored: ${stored}, skipped: ${skipped}, failed: ${failed}`
  );
  return { stored, skipped, failed };
}
