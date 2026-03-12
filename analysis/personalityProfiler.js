import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

export async function buildPersonalityModel(userId) {

    const snapshot = await db.collection("messages")
        .where("userId", "==", userId)
        .limit(200)
        .get();

    let questionCount = 0;
    let messageCount = 0;

    snapshot.forEach(doc => {

        const msg = doc.data().content;

        messageCount++;

        if (msg.includes("?")) {
            questionCount++;
        }

    });

    const curiosity = questionCount / messageCount;

    const profile = {

        curiosity,
        analytical: curiosity > 0.3,
        persistence: messageCount > 50

    };

    await db.collection("athena_user_profiles").doc(userId).set(profile);

    return profile;
}
