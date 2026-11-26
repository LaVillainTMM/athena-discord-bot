
import { firestore } from "../firebase.js";
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENAI_API_KEY
});

export async function summarizeChannel(channelId) {
  try {
    const snapshot = await firestore
      .collection("messages")
      .where("channelId", "==", channelId)
      .limit(100)
      .get();

    const text = snapshot.docs
      .map(doc => doc.data().content)
      .filter(value => typeof value === "string")
      .join("\n");

    if (!text.trim()) {
      return "No messages to summarize.";
    }

    const result = await genAI.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `Summarize the following conversation:\n${text}`
    });

    const summary = result.text?.trim();

    if (!summary) {
      return "No summary generated.";
    }

    await firestore.collection("athena_memory").add({
      channelId,
      summary,
      createdAt: new Date()
    });

    return summary;

  } catch (error) {
    console.error(
      "[Athena Memory] Summarization error:",
      error.message
    );

    return "Error generating summary.";
  }
}
