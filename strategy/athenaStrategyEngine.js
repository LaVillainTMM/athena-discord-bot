// File: strategy/athenaStrategyEngine.js
import { firestore } from "../firebase.js";

const db = firestore;

export async function evaluateGoals(userId) {
  const snapshot = await db.collection("athena_goals")
      .where("userId", "==", userId)
      .get();

    snapshot.forEach(doc => {

        const goal = doc.data();

        console.log("Athena pursuing goal:", goal.goal);

    });

}
