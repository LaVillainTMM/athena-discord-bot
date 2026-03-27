// File: memory/conversationSummarizer.js
import { firestore } from "../firebase.js";
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENAI_API_KEY
});

const db = firestore;

export async function summarizeChannel(channelId) {
  try {
    const snapshot = await db
      .collection("messages")
      .where("channelId", "==", channelId) // 🔥 IMPORTANT FIX
      .limit(100)
      .get();

    let text = "";

    snapshot.forEach(doc => {
      text += doc.data().content + "\n";
    });

    if (!text) return "No messages to summarize.";

    /* ✅ NEW SDK CALL */
    const result = await genAI.models.generateContent({
      model: "gemini-1.5-flash",
      contents: `Summarize the following conversation:\n${text}`
    });

    const summary = result.text || "No summary generated.";

    await db.collection("athena_memory").add({
      channelId,
      summary,
      createdAt: new Date()
    });

    return summary;

  } catch (error) {
    console.error("Summarization error:", error);
    return "Error generating summary.";
  }
}
