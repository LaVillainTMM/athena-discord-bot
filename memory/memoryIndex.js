// File: memory/memoryIndex.js
import { firestore } from "../firebase.js";

const db = firestore;

export async function searchMemory(queryText) {
  const snapshot = await db.collection("athena_memory")
      .get();
    
    const results = [];

    snapshot.forEach(doc => {

        results.push(doc.data());

    });

    return results;
}
