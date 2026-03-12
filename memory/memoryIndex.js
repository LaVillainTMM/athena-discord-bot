import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

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
