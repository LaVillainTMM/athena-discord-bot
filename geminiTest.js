

import "dotenv/config";

import {
  GoogleGenerativeAI
} from "@google/generative-ai";

const apiKey = process.env.GOOGLE_GENAI_API_KEY;

if (!apiKey) {
  console.error("[Gemini Test] API key missing");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

const modelName =
  process.env.GEMINI_MODEL || "gemini-2.5-pro";

try {
  console.log(
    "[Gemini Test] Testing:",
    modelName
  );

  const model = genAI.getGenerativeModel({
    model: modelName
  });

  const result = await model.generateContent(
    "Respond only with: Athena operational."
  );

  console.log(
    "[Gemini Test] Response:",
    result.response.text()
  );

} catch (error) {
  const safeMessage = String(
    error.message || "Unknown error"
  ).split(apiKey).join("[REDACTED]");

  console.error(
    "[Gemini Test] Status:",
    error.status || "Unknown"
  );

  console.error(
    "[Gemini Test] Error:",
    safeMessage
  );

  process.exitCode = 1;
}
