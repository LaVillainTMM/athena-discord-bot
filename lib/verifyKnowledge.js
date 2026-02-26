import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

export async function verifyKnowledge(fact) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are Athena's internal verification system.

Analyze the following knowledge entry.

Return ONLY valid JSON (no markdown, no code fences):

{
  "valid": true or false,
  "confidence": number from 0 to 100,
  "reason": "short explanation"
}

Knowledge:
${JSON.stringify(fact)}`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();

    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    const json = JSON.parse(text);
    return json;
  } catch (err) {
    console.error("[Verify] Verification error:", err.message);
    return {
      valid: false,
      confidence: 0,
      reason: "verification failure",
    };
  }
}
