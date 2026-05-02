// dojKnowledge.js — DOJ press release indexer and redaction researcher for Athena

import { firestore } from "../firebase.js";

const DOJ_RSS_URL   = "https://www.justice.gov/news/rss";
const DOJ_BASE      = "https://www.justice.gov";
const USER_AGENT    = "AthenaBot/1.0 (DBI Nation Z intelligence system)";

/* ── Strip HTML and truncate ── */
function cleanHtml(html = "") {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim()
    .substring(0, 3000);
}

/* ── Extract a value from simple XML/RSS ── */
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

/* ── Parse RSS feed into item array ── */
function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title       = extractTag(block, "title");
    const link        = extractTag(block, "link");
    const description = cleanHtml(extractTag(block, "description") || "");
    const pubDate     = extractTag(block, "pubDate");
    const category    = extractTag(block, "category");
    if (title && link) items.push({ title, link, description, pubDate, category });
  }
  return items;
}

/* ── Detect redaction markers in text ── */
function detectRedactions(text) {
  const patterns = [
    /\[REDACTED\]/gi,
    /\[b\]\s*\[b\]/gi,
    /████+/g,
    /\(U\/\/FOUO\)/g,
    /\(S\/\/NF\)/g,
    /\(TS\)/g,
    /<redacted>/gi,
    /redacted by/gi,
    /withheld pursuant to/gi,
    /exemption \d+\([\w]+\)/gi,
  ];
  const found = patterns.filter(p => p.test(text)).map(p => p.source);
  return { hasRedactions: found.length > 0, patterns: found };
}

/* ── Common redaction reasons by pattern ── */
function interpretRedactionReason(text) {
  const reasons = [];

  if (/exemption\s*6/i.test(text) || /personal.*privacy/i.test(text))
    reasons.push("Privacy protection (Exemption 6 — personal identifying information)");
  if (/exemption\s*7\(a\)/i.test(text) || /law enforcement.*pending/i.test(text))
    reasons.push("Ongoing law enforcement investigation (Exemption 7(a))");
  if (/exemption\s*7\(c\)/i.test(text))
    reasons.push("Privacy of individuals in law enforcement records (Exemption 7(c))");
  if (/exemption\s*7\(d\)/i.test(text) || /confidential.*source/i.test(text))
    reasons.push("Confidential informant / source protection (Exemption 7(d))");
  if (/exemption\s*7\(e\)/i.test(text) || /technique/i.test(text))
    reasons.push("Law enforcement technique protection (Exemption 7(e))");
  if (/grand jury|rule 6\(e\)/i.test(text))
    reasons.push("Grand jury secrecy (Federal Rule of Criminal Procedure 6(e))");
  if (/national security|classified/i.test(text))
    reasons.push("National security classification");
  if (/deliberative|pre-decisional/i.test(text))
    reasons.push("Deliberative process privilege");
  if (/attorney.client|work product/i.test(text))
    reasons.push("Attorney-client privilege / work product doctrine");

  return reasons.length > 0
    ? reasons.join("; ")
    : "Reason not specified — likely standard FOIA exemption or active investigation protection";
}

/* ────────────────────────────────────────────────────────
   FETCH AND STORE LATEST DOJ PRESS RELEASES
   Returns count of newly stored entries.
──────────────────────────────────────────────────────── */
export async function syncLatestDojPressReleases(limit = 25) {
  console.log("[DOJ] Syncing latest DOJ press releases...");

  let xml;
  try {
    const res = await fetch(DOJ_RSS_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    console.error("[DOJ] RSS fetch failed:", err.message);
    return 0;
  }

  const items = parseRss(xml).slice(0, limit);
  let stored = 0;

  for (const item of items) {
    try {
      /* Skip if already stored */
      const existing = await firestore.collection("athena_knowledge")
        .where("source", "==", item.link)
        .limit(1).get();
      if (!existing.empty) continue;

      const { hasRedactions, patterns } = detectRedactions(item.description);
      const redactionNote = hasRedactions
        ? `\n\n[REDACTION DETECTED — patterns: ${patterns.join(", ")}. Further research required to determine removed content.]`
        : "";

      const ref = await firestore.collection("athena_knowledge").add({
        title:    item.title,
        content:  `Source: ${item.link}\nPublished: ${item.pubDate || "Unknown"}\nCategory: ${item.category || "DOJ"}\n\n${item.description}${redactionNote}`,
        source:   item.link,
        category: "DOJ Press Release",
        verified: true,
        hasRedactions,
        platform: "doj_scraper",
        createdAt: new Date().toISOString(),
      });
      console.log(`[Firestore:athena_knowledge] DOJ stored ${ref.id} — "${item.title}"`);

      stored++;
    } catch (err) {
      console.error(`[Firestore:athena_knowledge] DOJ store FAILED for "${item.title}":`, err.message);
    }
  }

  console.log(`[DOJ] Stored ${stored} new press releases (${items.length} fetched)`);
  return stored;
}

/* ────────────────────────────────────────────────────────
   SEARCH DOJ.GOV FOR A SPECIFIC TOPIC
   Fetches the DOJ search results page, extracts relevant
   entries, and stores them in Firebase.
──────────────────────────────────────────────────────── */
export async function searchAndStoreDoj(query, limit = 10) {
  console.log(`[DOJ] Searching DOJ.gov for: "${query}"`);

  const searchUrl = `https://www.justice.gov/search?query=${encodeURIComponent(query)}&page=0`;
  let html;

  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`DOJ Search HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error("[DOJ] Search fetch failed:", err.message);
    return { stored: 0, results: [] };
  }

  /* Extract result links and titles from HTML */
  const results = [];
  const linkRe = /href="(\/[^"]+)"[^>]*>\s*<[^>]+>([^<]{5,200})/g;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const path = m[1];
    const title = m[2].trim();
    if (
      !path.startsWith("/search") &&
      !path.startsWith("/static") &&
      title.length > 10 &&
      !results.some(r => r.path === path)
    ) {
      results.push({ path, title, url: DOJ_BASE + path });
    }
  }

  /* Store found results as knowledge entries */
  let stored = 0;
  for (const result of results.slice(0, 5)) {
    try {
      const existing = await firestore.collection("athena_knowledge")
        .where("source", "==", result.url).limit(1).get();
      if (!existing.empty) continue;

      const ref = await firestore.collection("athena_knowledge").add({
        title:    result.title,
        content:  `DOJ Search Result for "${query}"\nSource: ${result.url}\n\nThis document was found through DOJ.gov search indexing.`,
        source:   result.url,
        category: "DOJ Document",
        verified: true,
        searchQuery: query,
        platform: "doj_scraper",
        createdAt: new Date().toISOString(),
      });
      console.log(`[Firestore:athena_knowledge] DOJ search-store ${ref.id} — "${result.title}"`);
      stored++;
    } catch (err) {
      console.error(`[Firestore:athena_knowledge] DOJ search-store FAILED for "${result.title}":`, err.message);
    }
  }

  return { stored, results };
}

/* ────────────────────────────────────────────────────────
   STORE A MANUAL DOJ RESEARCH ENTRY
   Used when Athena discovers redaction context through
   her AI analysis + web search capabilities.
──────────────────────────────────────────────────────── */
export async function storeDojResearchEntry({ title, content, source, redactionContext, redactionReason }) {
  try {
    const reason = redactionReason || interpretRedactionReason(content);
    const ref = await firestore.collection("athena_knowledge").add({
      title,
      content: `${content}\n\nREDACTION CONTEXT: ${redactionContext || "Not specified"}\nREDACTION REASON: ${reason}`,
      source:   source || "DOJ.gov research",
      category: "DOJ Redaction Research",
      verified: true,
      platform: "doj_scraper",
      createdAt: new Date().toISOString(),
    });
    console.log(`[Firestore:athena_knowledge] DOJ research stored ${ref.id} — "${title}"`);
    return true;
  } catch (err) {
    console.error(`[Firestore:athena_knowledge] DOJ research store FAILED for "${title}":`, err.message);
    return false;
  }
}

/* ────────────────────────────────────────────────────────
   GET DOJ KNOWLEDGE SUMMARY
   Returns a count summary for admin display.
──────────────────────────────────────────────────────── */
export async function getDojKnowledgeSummary() {
  try {
    const snap = await firestore.collection("athena_knowledge")
      .where("platform", "==", "doj_scraper")
      .get();

    const categories = {};
    snap.docs.forEach(d => {
      const cat = d.data().category || "Unknown";
      categories[cat] = (categories[cat] || 0) + 1;
    });

    return { total: snap.size, categories };
  } catch (err) {
    return { total: 0, categories: {} };
  }
}
