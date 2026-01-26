const QUESTION_WEIGHTS = {
  1: {
    "Strategy and planning": { ESpireZ: 2 },
    "Growth and learning": { SleeperZ: 4 },
    "Loyalty and protection": { BoroZ: 3 },
    "Psychology and insight": { PsycZ: 1 }
  },
  2: {
    "Direct confrontation": { BoroZ: 3 },
    "Adapt and outmaneuver": { ESpireZ: 2 },
    "Stand ground with allies": { SleeperZ: 1 },
    "Observe before acting": { PsycZ: 4 }
  }

};

export default function assignRole(answers) {
  const scores = {
    SleeperZ: 0,
    ESpireZ: 0,
    BoroZ: 0,
    PsycZ: 0
  };

  for (const a of answers) {
    const qMap = QUESTION_WEIGHTS[a.questionId];
    if (!qMap) continue;

    const answerWeights = qMap[a.answer];
    if (!answerWeights) continue;

    for (const role in answerWeights) {
      scores[role] += answerWeights[role]
    }
  }

  return Object.keys(scores).reduce((a, b) =>
    scores[a] > scores[b] ? a : b
  );
}
