import quizData from "./quizData.js";
import { rtdb as db } from "../firebase.js";

export default async function runQuiz(user) {
  const snapshot = await db.ref(`quizResponses/${user.id}`).once("value");
  if (snapshot.exists() && snapshot.val().completed) {
    return snapshot.val().answers;
  }

  const answers = [];
  for (const q of quizData) {
    const optionsList = q.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    await user.send(
      `**Question ${q.id} of ${quizData.length}**\n${q.question}\n\n${optionsList}\n\n_Reply with the number of your answer._`
    );

    const dmChannel = await user.createDM();
    const filter = m => m.author.id === user.id;

    try {
      const collected = await dmChannel.awaitMessages({
        filter,
        max: 1,
        time: 120000,
        errors: ["time"]
      });

      const response = collected.first().content.trim();
      const choiceIndex = parseInt(response) - 1;

      const selectedOption = (choiceIndex >= 0 && choiceIndex < q.options.length)
        ? q.options[choiceIndex]
        : response;

      answers.push({
        questionId: q.id,
        answer: selectedOption
      });
    } catch (err) {
      await user.send("You took too long to respond. Please rejoin the server to try again.");
      throw new Error("Quiz timed out");
    }
  }

  await db.ref(`quizResponses/${user.id}`).set({
    completed: true,
    answers,
    completedAt: Date.now()
  });

  return answers;
}
