import { getFirestore } from "../firebase.js";

const db = firestore;

export async function createGoal(goalText) {

    await db.collection("athena_goals").add({

        goal: goalText,
        priority: Math.random(),
        createdAt: new Date(),
        status: "active"

    });

}
