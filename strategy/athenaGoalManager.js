import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

export async function createGoal(goalText) {

    await db.collection("athena_goals").add({

        goal: goalText,
        priority: Math.random(),
        createdAt: new Date(),
        status: "active"

    });

}
