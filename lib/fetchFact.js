// Uses Node 18+ native fetch — no external dependency needed

import { fetchRegionalFact } from "./regionalFetcher.js";

/* Track which article IDs have already been returned this session */
const seenIds = new Set();

/* Cycle counter — alternates between space news, regional news, and a wider
   topic pool so every cycle pulls something different. */
let cycle = 0;

async function fetchSpaceNews() {
  try {
    const offset = Math.floor(Math.random() * 50);
    const res = await fetch(
      `https://api.spaceflightnewsapi.net/v4/articles/?limit=20&offset=${offset}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.results?.length) return null;

    const article = data.results.find(a => !seenIds.has(a.id)) || data.results[0];
    seenIds.add(article.id);
    if (seenIds.size > 200) {
      const ids = [...seenIds].slice(0, 100);
      ids.forEach(id => seenIds.delete(id));
    }

    return {
      title:    article.title,
      content:  article.summary,
      source:   article.url,
      verified: true,
    };
  } catch (err) {
    console.warn("[FetchFact:Space]", err.message);
    return null;
  }
}

/* Main entry point — alternates sources so the knowledge base stays diverse. */
export async function fetchFact() {
  cycle++;
  /* 2 of every 3 cycles pull regional (states/continents); 1 of 3 pulls space */
  if (cycle % 3 === 0) {
    const fact = await fetchSpaceNews();
    if (fact) return fact;
    return fetchRegionalFact(); /* fall through if space source is empty */
  }
  const regional = await fetchRegionalFact();
  if (regional) return regional;
  return fetchSpaceNews(); /* fall back if regional source is empty */
}
