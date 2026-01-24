const quizData = require("./quizData");
const db = require("../firebase");

async function runQuiz(user) {
  const answers = [];

  for (const q of quizData) {
    const dm = await user.send(
      `**Question ${q.id}**\n${q.question}\n\n` +
      q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    );

    const filter = m => m.author.id === user.id;
    const collected = await dm.channel.awaitMessages({
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

module.exports = runQuiz;
