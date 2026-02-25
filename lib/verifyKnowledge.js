import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/*
====================================
ATHENA KNOWLEDGE VERIFIER
====================================
Evaluates truth likelihood and usefulness
*/

export async function verifyKnowledge(fact) {

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro"
    });

    const prompt = `
You are Athena's internal verification system.

Analyze the following knowledge entry.

Return ONLY valid JSON:

{
  "valid": true or false,
  "confidence": number from 0 to 100,
  "reason": "short explanation"
}

Knowledge:
${JSON.stringify(fact)}
`;

    const result = await model.generateContent(prompt);

    const text = result.response.text().trim();

    const json = JSON.parse(text);

    return json;

  } catch (err) {
    console.error("Verification error:", err);

    return {
      valid: false,
      confidence: 0,
      reason: "verification failure"
    };
  }
}
