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

/* ── Google News RSS (no key, no per-IP throttling) ─────
   We previously used GDELT, but Railway's shared egress IPs are
   aggressively rate-limited (429 on every call). Google News RSS is
   public, no key required, and tolerant of background fetching.
   Format: https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en

   Still serialized through a single chain with a small gap to be a
   well-behaved client. */
const MIN_GAP_MS = 1500;
let lastCallAt = 0;
let chain = Promise.resolve();

function newsSearch(region, opts = {}) {
  const job = chain.then(() => doNewsSearch(region, opts));
  chain = job.catch(() => {});
  return job;
}

/* Minimal RSS parser — extracts <item><title>/<link>/<pubDate>/<source> */
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const tagRe  = (tag) => new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  /* Google News encodes the real publisher URL in <source url="..."> */
  const sourceUrlRe = /<source[^>]*\burl=["']([^"']+)["']/i;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title   = (block.match(tagRe("title"))   || [])[1];
    const link    = (block.match(tagRe("link"))    || [])[1];
    const pubDate = (block.match(tagRe("pubDate")) || [])[1];
    const sourceUrlMatch = block.match(sourceUrlRe);
    if (title && link) {
      items.push({
        title:    title.trim(),
        url:      link.trim(),
        seendate: pubDate ? pubDate.trim() : "",
        /* `domain` carries the publisher's real URL when available so the
           accredited-source filter can resolve it back to a hostname. */
        domain:   sourceUrlMatch ? sourceUrlMatch[1].trim() : "",
      });
    }
  }
  return items;
}

async function doNewsSearch(region, { max = 10 } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const query = encodeURIComponent(`"${region}"`);
  const url   = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  const backoffs = [4000, 12000];
  let lastErr;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    lastCallAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "AthenaBot/1.0 (+discord)" } });
      if (res.status === 429 || res.status === 503) {
        if (attempt === backoffs.length) throw new Error(`HTTP ${res.status}`);
        console.warn(`[RegionalFetcher] ${region}: ${res.status} — retrying in ${backoffs[attempt] / 1000}s`);
        await new Promise(r => setTimeout(r, backoffs[attempt]));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseRssItems(xml).slice(0, max);
      return items;
    } catch (err) {
      lastErr = err;
      if (attempt === backoffs.length) throw err;
      await new Promise(r => setTimeout(r, backoffs[attempt]));
    }
  }
  throw lastErr || new Error("News fetch failed");
}

/* Backwards-compatible alias used below */
const gdeltSearch = newsSearch;

/* ── Accredited source allow-list ──────────────────────
   Athena's policy: only learn from accredited outlets and official
   government / educational sources. Wikipedia and community blogs
   are excluded. Match by hostname suffix (handles regional
   subdomains like uk.reuters.com, edition.cnn.com). */
const TRUSTED_DOMAINS = [
  /* Wire services & major newspapers (editorial standards, fact-checking) */
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "npr.org",
  "nytimes.com", "washingtonpost.com", "wsj.com", "bloomberg.com",
  "theguardian.com", "ft.com", "economist.com", "pbs.org",
  "abcnews.go.com", "cbsnews.com", "nbcnews.com", "cnn.com",
  "usatoday.com", "latimes.com", "chicagotribune.com",
  "csmonitor.com", "axios.com", "politico.com", "propublica.org",
  "forbes.com", "time.com", "newsweek.com", "thehill.com",
  /* International accredited */
  "aljazeera.com", "dw.com", "france24.com", "japantimes.co.jp",
  "scmp.com", "smh.com.au", "abc.net.au", "cbc.ca", "globeandmail.com",
  /* Government & official (auto-trusted by suffix below as well) */
  "voanews.com", "c-span.org",
];

function isTrustedSource(url) {
  if (!url) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return false; }
  /* Accept any .gov, .mil, .edu domain (US + international: .gov.uk, .ac.uk, .edu.au, etc.) */
  if (/\.gov(\.[a-z]{2,3})?$/.test(host)) return true;
  if (/\.mil(\.[a-z]{2,3})?$/.test(host)) return true;
  if (/\.edu(\.[a-z]{2,3})?$/.test(host)) return true;
  if (/\.ac\.[a-z]{2,3}$/.test(host))     return true;
  /* Allow-list match by suffix */
  return TRUSTED_DOMAINS.some(d => host === d || host.endsWith("." + d));
}

/* Google News uses news.google.com redirect URLs that hide the real
   publisher. The publisher name is in the <source url="..."> tag of
   the RSS item — we record it as `domain` in parseRssItems. */
function publisherDomain(article) {
  const candidates = [article.domain, article.url].filter(Boolean);
  for (const c of candidates) {
    try { return new URL(c.startsWith("http") ? c : `https://${c}`).hostname.toLowerCase(); }
    catch {}
  }
  return "";
}

/* Pick the first NOT-yet-seen article from a TRUSTED source. */
function pickFresh(articles) {
  for (const a of articles) {
    if (!a.url || seenUrls.has(a.url)) continue;
    /* Trust gate — domain comes from the RSS <source url="..."> tag,
       not the news.google.com redirect URL. */
    const sourceUrl = a.domain && a.domain.startsWith("http") ? a.domain : `https://${a.domain || ""}`;
    if (!isTrustedSource(sourceUrl)) continue;
    seenUrls.add(a.url);
    if (seenUrls.size > 5000) {
      const ids = [...seenUrls].slice(0, 2500);
      ids.forEach(u => seenUrls.delete(u));
    }
    return a;
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
    /* The global request gate already enforces a 5s gap; no extra wait needed. */
  }

  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(
    `[RegionalSweep] Complete in ${seconds}s — stored: ${stored}, skipped: ${skipped}, failed: ${failed}`
  );
  return { stored, skipped, failed };
}
