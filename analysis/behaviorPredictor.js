// File: analysis/behaviorPredictor.js
import { firestore } from "../firebase.js";

export async function predictUserBehavior(userId) {

    const db = firestore;

    const profileDoc = await db.collection("athena_user_profiles")
        .doc(userId)
        .get();

    if (!profileDoc.exists) return null;

    const profile = profileDoc.data();

    let prediction = "general interaction";

    if (profile.curiosity > 0.5) {
        prediction = "likely to ask complex questions";
    }

    return prediction;
}
