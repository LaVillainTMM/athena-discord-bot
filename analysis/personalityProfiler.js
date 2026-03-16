// File: analysis/personalityProfiler.js
import { firestore } from "../firebase.js";

export async function buildPersonalityModel(userId) {

    const db = firestore;

    const snapshot = await db.collection("messages")
        .where("userId", "==", userId)
        .limit(200)
        .get();

    let questionCount = 0;
    let messageCount = 0;

    snapshot.forEach(doc => {

        const msg = doc.data().content || "";

        messageCount++;

        if (msg.includes("?")) {
            questionCount++;
        }

    });

    const curiosity = messageCount > 0 ? questionCount / messageCount : 0;

    const profile = {
        curiosity,
        analytical: curiosity > 0.3,
        persistence: messageCount > 50
    };

    await db.collection("athena_user_profiles").doc(userId).set(profile);

    return profile;
}
