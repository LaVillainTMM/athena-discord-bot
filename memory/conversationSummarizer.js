import { getFirestore } from "../firebase.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const db = firestore;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function summarizeChannel(channelId) {

    const snapshot = await db.collection("messages")
        .where("channelId", "==", channelId)
        .orderBy("timestamp", "desc")
        .limit(100)
        .get();

    let text = "";

    snapshot.forEach(doc => {

        text += doc.data().content + "\n";

    });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(
        "Summarize the following conversation:\n" + text
    );

    const summary = result.response.text();

    await db.collection("athena_memory").add({

        channelId,
        summary,
        createdAt: new Date()

    });

    return summary;
}
