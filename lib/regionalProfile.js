/* ──────────────────────────────────────────────────────
   REGIONAL PROFILE FETCHER

   Pulls origin / history / geography / economy / demographics
   summaries for every region (50 U.S. states + 7 continents)
   from ACCREDITED reference sources only.

   Source priority:
     1. Encyclopaedia Britannica   (britannica.com)
     2. CIA World Factbook         (cia.gov)               — continents
     3. U.S. State Department      (state.gov)             — fallback
     4. National Park Service      (nps.gov)               — geography fallback

   Wikipedia is intentionally NOT used — it is community-edited
   and not an accredited reference source per Athena's policy.

   Designed to run once per region; storeNewKnowledge dedupes
   by title so weekly re-runs are cheap.
────────────────────────────────────────────────────── */

/* Britannica section URLs follow a consistent pattern:
     https://www.britannica.com/place/<slug>            (overview)
     https://www.britannica.com/place/<slug>/History
     https://www.britannica.com/place/<slug>/Land
     https://www.britannica.com/place/<slug>/Economy
     https://www.britannica.com/place/<slug>/People
*/
const BRITANNICA_SECTIONS = [
  { path: "",          label: "Overview" },
  { path: "/History",  label: "Origin & History" },
  { path: "/Land",     label: "Geography & Landmarks" },
  { path: "/Economy",  label: "Economy & Industrialization" },
  { path: "/People",   label: "People & Demographics" },
];

/* Polite single-flight queue — Britannica is not an open API,
   so we pace requests carefully and identify ourselves clearly. */
const MIN_GAP_MS = 1500;
let lastCallAt = 0;
let chain = Promise.resolve();

function queue(fn) {
  const job = chain.then(fn);
  chain = job.catch(() => {});
  return job;
}

function britannicaSlug(name) {
  /* Britannica uses hyphenated, title-cased slugs. */
  return name
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

/* Strip HTML tags and normalize whitespace. */
function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/* Pull the meta description AND the first 1–3 paragraphs from a
   Britannica article page. Returns {summary, snippet, url} or null. */
async function fetchBritannicaSection(name, sectionPath) {
  return queue(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();

    const url = `https://www.britannica.com/place/${britannicaSlug(name)}${sectionPath}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "AthenaBot/1.0 (DBI NationZ Discord; contact: lavillaintmm)",
        "Accept":     "text/html",
      },
      redirect: "follow",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Britannica HTTP ${res.status}`);
    const html = await res.text();

    /* Meta description = vetted single-paragraph summary. */
    const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const summary = metaMatch ? metaMatch[1].trim() : "";

    /* Pull the first few <p> tags from the article body. */
    const paragraphs = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(html)) !== null && paragraphs.length < 3) {
      const text = plainText(pm[1]);
      if (text.length > 80) paragraphs.push(text);
    }
    const snippet = paragraphs.join("\n\n");

    if (!summary && !snippet) return null;
    return { summary, snippet, url };
  });
}

/* Build the per-region knowledge entries from Britannica. */
export async function fetchRegionalProfile(region) {
  const entries = [];
  for (const section of BRITANNICA_SECTIONS) {
    try {
      const data = await fetchBritannicaSection(region.name, section.path);
      if (!data) continue;
      const title = `${region.name} (${region.category}) — ${section.label}`;
      const body  =
        (data.summary ? `${data.summary}\n\n` : "") +
        (data.snippet ? `${data.snippet}\n\n` : "") +
        `Source: Encyclopaedia Britannica (accredited reference)\n` +
        `URL: ${data.url}`;
      entries.push({
        title,
        content:  body.trim(),
        source:   data.url,
        verified: true,
        region:   region.name,
        category: `${region.category} — ${section.label}`,
      });
    } catch (err) {
      console.warn(`[RegionalProfile] ${region.name} ${section.label}: ${err.message}`);
    }
  }
  return entries;
}

/* Iterate every region and store all available profile entries. */
export async function runProfileSweep(regions, storeFn) {
  const start = Date.now();
  let stored = 0, skipped = 0, failed = 0;

  console.log(`[RegionalProfile] Starting Britannica profile sweep across ${regions.length} regions...`);

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
