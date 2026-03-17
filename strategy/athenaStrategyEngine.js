import { firestore } from "../firebase.js";

const db = firestore;

export async function evaluateGoals() {

  const goals = [];

  const snapshot = await db
    .collection("athena_goals")
    .where("status", "==", "active")
    .get();

  snapshot.forEach(doc => {

    const data = doc.data();
    if (!data) return;

    goals.push({
      id: doc.id,
      goal: data.goal || "",
      priority: data.priority || 0,
      createdAt: data.createdAt || null,
      status: data.status || "active"
    });

  });

  return goals;
}
