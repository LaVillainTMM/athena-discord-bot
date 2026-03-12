import { getFirestore } from "../firebase.js";

const db = firestore;

export async function searchMemory(keyword) {

    const snapshot = await db.collection("athena_memory")
        .where("summary", ">=", keyword)
        .get();

    const results = [];

    snapshot.forEach(doc => {

        results.push(doc.data());

    });

    return results;
}
