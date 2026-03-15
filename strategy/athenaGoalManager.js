// File: strategy/athenaGoalManager.js
import { firestore } from "../firebase.js";

const db = firestore;

export async function createGoal(goalData) {
  const res = await db.collection("athena_goals")
      .add(goalData);

const db = firestore;

export async function createGoal(goalText) {

    await db.collection("athena_goals").add({

        goal: goalText,
        priority: Math.random(),
        createdAt: new Date(),
        status: "active"

    });

}
