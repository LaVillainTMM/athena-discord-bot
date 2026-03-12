import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

export async function evaluateGoals() {

    const snapshot = await db.collection("athena_goals")
        .where("status", "==", "active")
        .get();

    snapshot.forEach(doc => {

        const goal = doc.data();

        console.log("Athena pursuing goal:", goal.goal);

    });

}
