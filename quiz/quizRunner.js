import { selectQuizSession, MANDATORY_COUNT, RANDOM_COUNT } from "./quizData.js";
import { firestore, admin } from "../firebase.js";
import assignRole from "./roleAssigner.js";

export default async function runQuiz(user) {
  const quizRef = firestore.collection("discord_quiz_results").doc(user.id);
  const existing = await quizRef.get();

  if (existing.exists && existing.data().completed) {
    return existing.data().answers;
  }

  const questions = selectQuizSession();
  const answers = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const isMandatory = i < MANDATORY_COUNT;
    const optionsList = q.options.map((o) => `**${o.label}.** ${o.text}`).join("\n");
    const phaseLabel = isMandatory
      ? `Core Question ${i + 1} of ${MANDATORY_COUNT}`
      : `Question ${i + 1} of ${questions.length}`;

    await user.send(
      `**${phaseLabel}**\n${q.question}\n\n${optionsList}\n\n_Reply with A, B, C, or D._`
    );

    const dmChannel = await user.createDM();
    const filter = (m) => m.author.id === user.id;

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
      const selectedOption = q.options.find((o) => o.label === chosenLabel) || q.options[0];

      answers.push({
        questionId: q.id,
        label: selectedOption.label,
        question: q.question,
        answer: selectedOption.text,
        nation: selectedOption.nation,
        isMandatory,
      });
    } catch {
      await user.send(
        "You took too long to respond. Please DM Athena again or rejoin the server to retry."
      );
      throw new Error("Quiz timed out");
    }
  }

  await user.send("Athena is analyzing your responses and determining your nation placement...");

  const qaPairs = answers.map((a) => ({ question: a.question, answer: a.answer }));
  const assignedNation = await assignRole(qaPairs);

  const nationCounts = { SleeperZ: 0, ESpireZ: 0, BoroZ: 0, PsycZ: 0 };
  for (const a of answers) {
    if (nationCounts[a.nation] !== undefined) nationCounts[a.nation]++;
  }

  await quizRef.set({
    completed: true,
    answers,
    nationCounts,
    assignedNation,
    aiSorted: true,
    totalQuestions: questions.length,
    totalQuestionPool: 401,
    mandatoryCount: MANDATORY_COUNT,
    randomCount: RANDOM_COUNT,
    discordId: user.id,
    username: user.username,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return answers;
}
