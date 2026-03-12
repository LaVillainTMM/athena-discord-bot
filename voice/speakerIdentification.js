import { getFirestore } from "../firebase.js";
import { generateVoiceEmbedding } from "./voiceFingerprint.js";

const db = firestore;

function cosineSimilarity(a, b) {

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {

        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];

    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function identifySpeaker(audioBuffer) {

    const embedding = generateVoiceEmbedding(audioBuffer);

    const snapshot = await db.collection("athena_voice_profiles").get();

    let bestMatch = null;
    let highestScore = 0;

    snapshot.forEach(doc => {

        const profile = doc.data();

        const score = cosineSimilarity(embedding, profile.embedding);

        if (score > highestScore) {

            highestScore = score;
            bestMatch = profile.athenaUserId;

        }

    });

    if (highestScore > 0.85) {

        return bestMatch;

    }

    return null;
}
