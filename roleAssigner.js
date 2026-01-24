function assignRole(answers) {
  let scores = {
    SleeperZ: 0,
    ESpireZ: 0,
    BoroZ: 0,
    PsycZ: 0
  };

  for (const a of answers) {
    if (a.answer.includes("Strategy")) scores.ESpireZ++;
    if (a.answer.includes("Growth")) scores.SleeperZ++;
    if (a.answer.includes("Loyalty")) scores.BoroZ++;
    if (a.answer.includes("Psychology")) scores.PsycZ++;
  }

  return Object.keys(scores).reduce((a, b) =>
    scores[a] > scores[b] ? a : b
  );
}

module.exports = assignRole;
