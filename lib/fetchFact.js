// Uses Node 18+ native fetch — no external dependency needed

export async function fetchFact() {
  try {
    const res = await fetch(
      "https://api.spaceflightnewsapi.net/v4/articles/?limit=1"
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.results?.length) return null;

    const article = data.results[0];

    return {
      title: article.title,
      content: article.summary,
      source: article.url,
      verified: true,
    };
  } catch (err) {
    console.error("[FetchFact] Error:", err.message);
    return null;
  }
}
