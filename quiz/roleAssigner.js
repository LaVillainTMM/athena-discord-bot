export default function assignRole(answers) {
  const scores = {
    SleeperZ: 0,
    ESpireZ: 0,
    BoroZ: 0,
    PsycZ: 0,
  };

  for (const a of answers) {
    if (a.nation && scores[a.nation] !== undefined) {
      scores[a.nation]++;
    }
  }

  return Object.keys(scores).reduce((a, b) =>
    scores[a] >= scores[b] ? a : b
  );
}
