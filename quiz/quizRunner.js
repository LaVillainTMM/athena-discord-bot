import { selectRandomQuizQuestions, QUIZ_SESSION_SIZE } from "./quizData.js";
import { firestore, admin } from "../firebase.js";

export default async function runQuiz(user) {
  const quizRef = firestore.collection("discord_quiz_results").doc(user.id);
  const existing = await quizRef.get();

  if (existing.exists && existing.data().completed) {
    return existing.data().answers;
  }

  const questions = selectRandomQuizQuestions(QUIZ_SESSION_SIZE);
  const answers = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const optionsList = q.options
      .map(o => `**${o.label}.** ${o.text}`)
      .join("\n");

    await user.send(
      `**Question ${i + 1} of ${questions.length}**\n${q.question}\n\n${optionsList}\n\n_Reply with A, B, C, or D._`
    );

    const dmChannel = await user.createDM();
    const filter = m => m.author.id === user.id;

    try {
      const collected = await dmChannel.awaitMessages({
        filter,
        max: 1,
        time: 120000,
        errors: ["time"],
      });

      const response = collected.first().content.trim().toUpperCase();
      const validLabels = ["A", "B", "C", "D"];
      const chosenLabel = validLabels.includes(response) ? response : "A";

      const selectedOption = q.options.find(o => o.label === chosenLabel) || q.options[0];

      answers.push({
        questionId: q.id,
        label: selectedOption.label,
        answer: selectedOption.text,
        nation: selectedOption.nation,
      });
    } catch (err) {
      await user.send(
        "You took too long to respond. Please DM Athena again or rejoin the server to retry."
      );
      throw new Error("Quiz timed out");
    }
  }

  const nationCounts = { SleeperZ: 0, ESpireZ: 0, BoroZ: 0, PsycZ: 0 };
  for (const a of answers) {
    if (nationCounts[a.nation] !== undefined) {
      nationCounts[a.nation]++;
    }
  }
  const assignedNation = Object.keys(nationCounts).reduce((a, b) =>
    nationCounts[a] >= nationCounts[b] ? a : b
  );

  await quizRef.set({
    completed: true,
    answers,
    nationCounts,
    assignedNation,
    totalQuestions: questions.length,
    totalQuestionPool: 401,
    discordId: user.id,
    username: user.username,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return answers;
}
