import { selectQuizSession, MANDATORY_COUNT, RANDOM_COUNT } from "./quizData.js";
import { firestore, admin } from "../firebase.js";
import assignRole from "./roleAssigner.js";

/* ── Active session guard — prevents a user from being in two quiz sessions at once ── */
const activeSessions = new Set(); /* Set of Discord user IDs currently in a quiz */

export function isInActiveQuiz(userId) {
  return activeSessions.has(userId);
}

/* ── Run the full 50-question quiz via Discord DMs ──
   Returns: { answers, assignedNation }
   Throws on timeout or DM failure. ── */
export default async function runQuiz(user) {
  /* Prevent double sessions */
  if (activeSessions.has(user.id)) {
    throw new Error("You already have an active quiz session. Please complete it in your DMs.");
  }

  /* Check if already completed */
  const quizRef  = firestore.collection("discord_quiz_results").doc(user.id);
  const existing = await quizRef.get();
  if (existing.exists && existing.data()?.completed) {
    return { answers: existing.data().answers, assignedNation: existing.data().assignedNation };
  }

  activeSessions.add(user.id);
  const questions = selectQuizSession();
  const answers   = [];

  try {
    for (let i = 0; i < questions.length; i++) {
      const q           = questions[i];
      const isMandatory = i < MANDATORY_COUNT;
      const phaseLabel  = isMandatory
        ? `Core Question ${i + 1} of ${MANDATORY_COUNT}`
        : `Question ${i + 1} of ${questions.length}`;

      const optionsList = q.options.map(o => `**${o.label}.** ${o.text}`).join("\n");

      await user.send(
        `**[DBI NationZ Quiz — ${phaseLabel}]**\n\n${q.question}\n\n${optionsList}\n\n_Reply with A, B, C, or D._`
      );

      const dmChannel = await user.createDM();
      const filter    = m => m.author.id === user.id && !m.content.startsWith("!");

      try {
        const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 120_000, errors: ["time"] });
        const response       = collected.first().content.trim().toUpperCase().charAt(0);
        const validLabels    = ["A", "B", "C", "D"];
        const chosenLabel    = validLabels.includes(response) ? response : "A";
        const selectedOption = q.options.find(o => o.label === chosenLabel) ?? q.options[0];

        answers.push({
          questionId: q.id,
          label:      selectedOption.label,
          question:   q.question,
          answer:     selectedOption.text,
          nation:     selectedOption.nation,
          isMandatory,
        });
      } catch {
        await user.send(
          "You took too long to respond (2 minutes per question). " +
          "Type **!quiz** in your DMs with Athena to restart from the beginning."
        );
        throw new Error("Quiz timed out");
      }
    }

    /* ── AI Nation Assignment ── */
    await user.send(
      "**All questions answered.**\n\nAthena is analyzing your responses and determining your nation placement...\n" +
      "_This may take up to 30 seconds._"
    );

    const qaPairs       = answers.map(a => ({ question: a.question, answer: a.answer }));
    const assignedNation = await assignRole(qaPairs);

    const nationCounts = { SleeperZ: 0, ESpireZ: 0, BoroZ: 0, PsycZ: 0 };
    for (const a of answers) {
      if (nationCounts[a.nation] !== undefined) nationCounts[a.nation]++;
    }

    await quizRef.set({
      completed:         true,
      answers,
      nationCounts,
      assignedNation,
      aiSorted:          true,
      totalQuestions:    questions.length,
      totalQuestionPool: 401,
      mandatoryCount:    MANDATORY_COUNT,
      randomCount:       RANDOM_COUNT,
      discordId:         user.id,
      username:          user.username,
      completedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    return { answers, assignedNation };
  } finally {
    activeSessions.delete(user.id);
  }
}
