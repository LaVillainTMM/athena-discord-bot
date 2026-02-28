// Uses Node 18+ native fetch — no external dependency needed

/* Track which article IDs have already been returned this session */
const seenIds = new Set();

export async function fetchFact() {
  try {
    /* Fetch a pool of recent articles and pick one that hasn't been seen yet.
       Use a random offset so we don't always start from the same position. */
    const offset = Math.floor(Math.random() * 50); /* articles 0-49 */
    const res = await fetch(
      `https://api.spaceflightnewsapi.net/v4/articles/?limit=20&offset=${offset}`
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.results?.length) return null;

    /* Find the first article we haven't returned yet this session */
    const article = data.results.find(a => !seenIds.has(a.id));
    if (!article) {
      /* All 20 were already seen — clear oldest half and try the first one */
      if (seenIds.size > 100) {
        const ids = [...seenIds].slice(0, 50);
        ids.forEach(id => seenIds.delete(id));
      }
      /* Return the first result anyway to avoid returning null perpetually */
      const fallback = data.results[0];
      seenIds.add(fallback.id);
      return {
        title: fallback.title,
        content: fallback.summary,
        source: fallback.url,
        verified: true,
      };
    }

    seenIds.add(article.id);

    return {
      title:    article.title,
      content:  article.summary,
      source:   article.url,
      verified: true,
    };
  } catch (err) {
    console.error("[FetchFact] Error:", err.message);
    return null;
  }
}
