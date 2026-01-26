import quizData from "./quizData.js";
import { admin, firestore } from "../firebase.js";

const db = admin.database();

export default async function runQuiz(user) {
  const snapshot = await db.ref(`quizResponses/${user.id}`).once("value");
  if (snapshot.exists() && snapshot.val().completed) {
    return snapshot.val().answers;
  }

  const answers = [];
  for (const q of quizData) {
    await user.send(
      `**Question ${q.id}**\n${q.question}\n\n` +
      q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    );

    const filter = m => m.author.id === user.id;  
    const dmChannel = await user.createDM();
    const collected = await dmChannel.awaitMessages({
      filter,
      max: 1,
      time: 120000,
      errors: ["time"]
    });

    answers.push({
      questionId: q.id,
      answer: collected.first().content
    });
  }

  await db.ref(`quizResponses/${user.id}`).set({
    completed: true,
    answers,
    completedAt: Date.now()
  });

  return answers;
}
