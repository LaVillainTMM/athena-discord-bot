import { GoogleGenerativeAI } from "@google/generative-ai";

const NATION_SORT_PROMPT = `You are Athena, guardian intelligence of DBI Nation Z. You have just administered a 50-question assessment — 20 mandatory core questions and 30 drawn from a broader knowledge pool — to determine where a new member belongs.

The four nations and their defining nature:
• SleeperZ — Acts unseen. Values stillness, patience, wisdom, and strategic sacrifice. Protects the defenseless from the shadows. Honesty expressed through principled silence and disciplined restraint. Balances the world by absorbing personal cost.
• ESpireZ — Rises so others may rise. Visionary, ambitious, inspiring. Leads by example and shared purpose. Consistency and the weight of responsibility define their honor. Will not ascend alone.
• BoroZ — Builds what endures. Disciplined, reliable, operational. Craftsmanship and hard work are their creed. Endurance is their gift. The foundation others stand on.
• PsycZ — Evolves thought and combats stagnation. Psychologically sharp, boldly expressive, fearless. Questions everything. Uses perception, deception, and challenge as tools of truth and growth.

You assess members across these behavioral lenses — NOT by tallying nation tags, but by reading the actual mindset pattern:
• Honesty — direct, calculated, through silence, or provocative
• Integrity — values demonstrated in action versus words
• Mentality — analytical, visionary, operational, or psychological
• Deceptiveness — used for protection, disruption, self-preservation, or truth-seeking
• Craftsmanship — how they create, solve, and build
• Reactions — instincts under conflict, crisis, and betrayal
• Purpose — what fundamentally drives them

Read all 50 answers as a unified portrait of who this person is. Respond with ONLY one word — the nation name. No explanation. No punctuation. Just one of: SleeperZ, ESpireZ, BoroZ, PsycZ`;

function fallbackSort(qaPairs) {
  const counts = { SleeperZ: 0, ESpireZ: 0, BoroZ: 0, PsycZ: 0 };
  const nations = Object.keys(counts);
  qaPairs.forEach((pair) => {
    nations.forEach((n) => {
      if (pair.answer && pair.answer.includes(n)) counts[n]++;
    });
  });
  return nations.reduce((a, b) => (counts[a] >= counts[b] ? a : b));
}

export default async function assignRole(qaPairs) {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) return fallbackSort(qaPairs);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const answersText = qaPairs
      .map((pair, i) => `Q${i + 1}: ${pair.question}\nA: ${pair.answer}`)
      .join("\n\n");

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${NATION_SORT_PROMPT}\n\nHere are the member's 50 answers:\n\n${answersText}`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 20 },
    });

    const raw = result.response.text().trim();
    const valid = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];
    const found = valid.find((n) => raw.includes(n));
    return found ?? fallbackSort(qaPairs);
  } catch (err) {
    console.error("[roleAssigner] Gemini error:", err.message);
    return fallbackSort(qaPairs);
  }
}
