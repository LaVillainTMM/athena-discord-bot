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
  },
  3: {
    "Mastery and excellence": { SleeperZ: 3 },
    "Innovation and vision": { ESpireZ: 4 },
    "Strength and resilience": { BoroZ: 2 },
    "Understanding the unseen": { PsycZ: 3 }
  },
  4: {
    "Intelligence and creativity": { ESpireZ: 3 },
    "Passion and determination": { BoroZ: 2 },
    "Honor and dependability": { SleeperZ: 2 },
    "Intuition and awareness": { PsycZ: 4 }
  },
  5: {
    "Analyze every angle before acting": { SleeperZ: 4 },
    "Charge forward with confidence": { BoroZ: 3 },
    "Protect those around you first": { BoroZ: 2, SleeperZ: 1 },
    "Read the room and adapt quietly": { PsycZ: 3 }
  },
  6: {
    "The strategist who plans the approach": { ESpireZ: 3, SleeperZ: 1 },
    "The visionary who inspires the team": { ESpireZ: 4 },
    "The protector who holds the line": { BoroZ: 4 },
    "The observer who sees what others miss": { PsycZ: 4 }
  },
  7: {
    "Stay calm and think clearly": { SleeperZ: 4 },
    "Channel it into motivation": { ESpireZ: 3 },
    "Dig in and refuse to break": { BoroZ: 4 },
    "Detach and analyze from a distance": { PsycZ: 3 }
  },
  8: {
    "One of wisdom and knowledge": { SleeperZ: 4 },
    "One of bold change and progress": { ESpireZ: 4 },
    "One of loyalty and unbreakable bonds": { BoroZ: 3 },
    "One of deep understanding of human nature": { PsycZ: 4 }
  },
  9: {
    "Knowledge is the ultimate weapon": { SleeperZ: 4, ESpireZ: 1 },
    "Fortune favors the bold": { ESpireZ: 3, BoroZ: 1 },
    "Strength through unity": { BoroZ: 4 },
    "The mind is deeper than the ocean": { PsycZ: 4 }
  },
  10: {
    "Learn from it and adjust your strategy": { SleeperZ: 3, ESpireZ: 1 },
    "Confront them directly and move on": { BoroZ: 3 },
    "Feel deeply hurt but remain loyal to others": { BoroZ: 2, SleeperZ: 1 },
    "Observe their pattern to understand why": { PsycZ: 4 }
  },
  11: {
    "Air - clear, swift, and intellectual": { ESpireZ: 3 },
    "Fire - passionate, bold, and transformative": { ESpireZ: 2, BoroZ: 2 },
    "Earth - stable, strong, and enduring": { BoroZ: 4, SleeperZ: 1 },
    "Water - deep, adaptive, and mysterious": { PsycZ: 4 }
  },
  12: {
    "Research, reading, and analysis": { SleeperZ: 4 },
    "Hands-on experimentation": { ESpireZ: 3 },
    "Through mentors and trusted guides": { BoroZ: 2, SleeperZ: 1 },
    "Quiet observation and reflection": { PsycZ: 3 }
  },
  13: {
    "A clear-headed plan": { SleeperZ: 3, ESpireZ: 1 },
    "Energy and motivation": { ESpireZ: 4 },
    "Unwavering support": { BoroZ: 4 },
    "Insight into what's really going on": { PsycZ: 4 }
  },
  14: {
    "Your mind and ability to outthink problems": { SleeperZ: 4 },
    "Your drive and refusal to quit": { ESpireZ: 3, BoroZ: 1 },
    "Your heart and devotion to your people": { BoroZ: 4 },
    "Your perception and emotional intelligence": { PsycZ: 4 }
  },
  15: {
    "Philosophy and strategic thinking": { SleeperZ: 4, ESpireZ: 1 },
    "Leadership and entrepreneurship": { ESpireZ: 4 },
    "Martial arts and physical mastery": { BoroZ: 4 },
    "Psychology and human behavior": { PsycZ: 4 }
  },
  16: {
    "Ignorance and being unprepared": { SleeperZ: 4 },
    "Stagnation and wasted potential": { ESpireZ: 4 },
    "Failing the people who depend on you": { BoroZ: 4 },
    "Being misunderstood or unseen": { PsycZ: 4 }
  },
  17: {
    "Reading, chess, or solving puzzles": { SleeperZ: 4 },
    "An adventure or creative project": { ESpireZ: 3 },
    "Time with close friends and family": { BoroZ: 3 },
    "Journaling, meditating, or people-watching": { PsycZ: 3 }
  },
  18: {
    "Useful frameworks that can be optimized": { SleeperZ: 3, ESpireZ: 1 },
    "Guidelines meant to be challenged": { ESpireZ: 4 },
    "Important for maintaining order": { BoroZ: 3 },
    "Interesting reflections of who made them": { PsycZ: 3 }
  },
  19: {
    "That your strategy was proven right": { SleeperZ: 3, ESpireZ: 1 },
    "That you pushed past your limits": { ESpireZ: 3, BoroZ: 1 },
    "That your team succeeded together": { BoroZ: 4 },
    "That you understood the game better than anyone": { PsycZ: 4 }
  },
  20: {
    "Her strategic brilliance and wisdom": { SleeperZ: 4, ESpireZ: 1 },
    "Her courage and willingness to act": { ESpireZ: 3, BoroZ: 2 },
    "Her fierce protection of her people": { BoroZ: 4 },
    "Her deep insight into truth and justice": { PsycZ: 4 }
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
      scores[role] += answerWeights[role];
    }
  }

  return Object.keys(scores).reduce((a, b) =>
    scores[a] > scores[b] ? a : b
  );
}
