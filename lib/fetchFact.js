import fetch from "node-fetch";

export async function fetchFact() {
  try {
    const res = await fetch(
      "https://api.spaceflightnewsapi.net/v4/articles/?limit=1"
    );

    const data = await res.json();
    if (!data.results?.length) return null;

    const article = data.results[0];

    return {
      title: article.title,
      content: article.summary,
      source: article.url,
      verified: true
    };
  } catch (err) {
    console.error("Fetch fact error:", err);
    return null;
  }
}
