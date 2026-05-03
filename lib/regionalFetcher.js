/* ──────────────────────────────────────────────────────
   REGIONAL KNOWLEDGE FETCHER

   Pulls one news article per call from a rotating list of
   geographic regions: all 50 U.S. states + every continent.
   Uses the public GDELT 2.1 DOC API (no key required).

   Two entry points:
     - fetchRegionalFact()  → cycles to next region, returns 1 article
     - runDailySweep(store) → fetches one article from EVERY region,
                              stores each via the provided callback.
                              Designed to run once per 24h.
────────────────────────────────────────────────────── */

const US_STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
  "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
  "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan",
  "Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada",
  "New Hampshire","New Jersey","New Mexico","New York","North Carolina",
  "North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
  "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
];

const CONTINENTS = [
  "Africa","Antarctica","Asia","Europe","North America","Oceania","South America",
];

/* All regions, tagged with category for storage */
export const REGIONS = [
  ...US_STATES.map(name => ({ name, kind: "us_state",  category: "US State" })),
  ...CONTINENTS.map(name => ({ name, kind: "continent", category: "Continent" })),
];

/* Track which article URLs have been returned this session to avoid dupes */
const seenUrls = new Set();
let cursor = 0;

/* GDELT 2.1 DOC API — returns recent news articles for a query.
   No API key required. Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ */
async function gdeltSearch(region, { timespanHours = 24, max = 10 } = {}) {
  const query = encodeURIComponent(`"${region}"`);
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc` +
    `?query=${query}&mode=ArtList&format=json` +
    `&maxrecords=${max}&sort=DateDesc&timespan=${timespanHours}h`;

  const res = await fetch(url, { headers: { "User-Agent": "AthenaBot/1.0" } });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const text = await res.text();
  /* GDELT sometimes returns empty body or non-JSON when no hits */
  if (!text.trim()) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  return data.articles || [];
}

/* Pick the first article we haven't already returned. */
function pickFresh(articles) {
  for (const a of articles) {
    if (a.url && !seenUrls.has(a.url)) {
      seenUrls.add(a.url);
      /* Cap memory */
      if (seenUrls.size > 5000) {
        const ids = [...seenUrls].slice(0, 2500);
        ids.forEach(u => seenUrls.delete(u));
      }
      return a;
    }
  }
  return null;
}

/* Convert a GDELT article into a knowledge entry */
function toKnowledgeEntry(article, region) {
  const title = `${region.name} (${region.category}): ${article.title}`.substring(0, 280);
  const body  =
    `${article.title}\n\n` +
    `Source: ${article.domain || article.sourcecountry || "unknown"}\n` +
    `Published: ${article.seendate || "unknown"}\n` +
    `URL: ${article.url}`;
  return {
    title,
    content:  body,
    source:   article.url,
    verified: true,
    region:   region.name,
    category: region.category,
  };
}

/* ── ROTATING SINGLE-FETCH ────────────────────────────
   Returns one article from the next region in rotation.
   Skips regions with no recent articles after a small
   number of attempts. Designed to be plugged into the
   existing 60s autonomous learning interval. */
export async function fetchRegionalFact() {
  for (let attempts = 0; attempts < REGIONS.length; attempts++) {
    const region = REGIONS[cursor];
    cursor = (cursor + 1) % REGIONS.length;

    try {
      const articles = await gdeltSearch(region.name, { timespanHours: 48, max: 10 });
      const fresh = pickFresh(articles);
      if (fresh) {
        return toKnowledgeEntry(fresh, region);
      }
    } catch (err) {
      console.warn(`[RegionalFetcher] ${region.name}: ${err.message}`);
    }
  }
  return null; /* every region was exhausted this round */
}

/* ── DAILY SWEEP ───────────────────────────────────────
   Iterates every region (50 states + 7 continents = 57 calls)
   and invokes storeFn(entry) for each. Used at startup and
   every 24h so Athena always has at least one fresh entry per
   region per day. Spaces calls out so we don't hammer GDELT. */
export async function runDailySweep(storeFn) {
  const start = Date.now();
  let stored = 0, skipped = 0, failed = 0;

  console.log(`[RegionalSweep] Starting daily sweep across ${REGIONS.length} regions...`);

  for (const region of REGIONS) {
    try {
      const articles = await gdeltSearch(region.name, { timespanHours: 24, max: 5 });
      const fresh = pickFresh(articles);
      if (!fresh) {
        skipped++;
        continue;
      }
      const entry = toKnowledgeEntry(fresh, region);
      const ok = await storeFn(entry);
      if (ok) stored++; else skipped++;
    } catch (err) {
      failed++;
      console.warn(`[RegionalSweep] ${region.name}: ${err.message}`);
    }
    /* 750ms gap → ~43s per full sweep, gentle on GDELT */
    await new Promise(r => setTimeout(r, 750));
  }

  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(
    `[RegionalSweep] Complete in ${seconds}s — stored: ${stored}, skipped: ${skipped}, failed: ${failed}`
  );
  return { stored, skipped, failed };
}
