import { firestore } from "../firebase.js";

const db = firestore;

export async function createGoal(goalText) {

  if (!goalText) return null;

  const goal = {
    goal: goalText,
    priority: Math.random(),
    createdAt: new Date(),
    status: "active"
  };

  const res = await db.collection("athena_goals").add(goal);

  return res.id;
}

export async function getActiveGoals() {

  const snapshot = await db
    .collection("athena_goals")
    .where("status", "==", "active")
    .get();

  const goals = [];

  snapshot.forEach(doc => {
    goals.push({
      id: doc.id,
      ...doc.data()
    });
  });

  return goals;
}

export async function completeGoal(goalId) {

  if (!goalId) return;

  await db.collection("athena_goals").doc(goalId).update({
    status: "completed",
    completedAt: new Date()
  });
}
