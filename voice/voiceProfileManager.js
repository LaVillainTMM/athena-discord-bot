import { getFirestore } from "firebase-admin/firestore";
import { generateVoiceEmbedding } from "./voiceFingerprint.js";

const db = getFirestore();

export async function enrollVoice(userId, audioBuffer) {

    const embedding = generateVoiceEmbedding(audioBuffer);

    await db.collection("athena_voice_profiles").doc(userId).set({

        athenaUserId: userId,
        embedding: embedding,
        createdAt: new Date()

    });

}
