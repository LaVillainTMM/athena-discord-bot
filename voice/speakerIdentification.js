
import { firestore } from "../firebase.js";

// ==========================================
// ATHENA SPEAKER IDENTIFICATION SYSTEM
// ==========================================

const COLLECTION = "athena_voice_profiles";

const EMBEDDING_MODEL = "ecapa-tdnn-v1";

const MATCH_THRESHOLD = 0.85;
const MINIMUM_MARGIN = 0.05;

// ==========================================
// VALIDATE SPEAKER EMBEDDINGS
// ==========================================

function isValidEmbedding(vector) {
  return (
    Array.isArray(vector) &&
    vector.length >= 64 &&
    vector.every(Number.isFinite) &&
    vector.some(value => value !== 0)
  );
}

// ==========================================
// COSINE SIMILARITY
// ==========================================

export function cosineSimilarity(a, b) {
  if (
    !isValidEmbedding(a) ||
    !isValidEmbedding(b) ||
    a.length !== b.length
  ) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator =
    Math.sqrt(normA) * Math.sqrt(normB);

  return denominator > 0
    ? dot / denominator
    : -1;
}

// ==========================================
// SPEAKER IDENTIFICATION
// ==========================================

export async function identifySpeaker(
  audioBuffer,
  options = {}
) {
  try {
    const {
      embedding,
      model,
      candidateUserIds = []
    } = options;

    // Never identify speakers using raw audio hashes.

    if (
      !isValidEmbedding(embedding) ||
      model !== EMBEDDING_MODEL
    ) {
      console.log(
        "[SpeakerIdentification] Valid voice embedding required."
      );

      return null;
    }

    // Only compare explicitly authorized candidates.

    const candidates = [
      ...new Set(candidateUserIds)
    ].filter(id =>
      typeof id === "string" &&
      id.length > 0 &&
      !id.includes("/")
    ).slice(0, 10);

    if (candidates.length === 0) {
      return null;
    }

    const snapshot = await firestore
      .collection(COLLECTION)
      .where("athenaUserId", "in", candidates)
      .get();

    const scores = new Map();

    snapshot.forEach(doc => {
      const profile = doc.data();

      if (
        profile.consentGranted !== true ||
        profile.active !== true ||
        profile.embeddingModel !== EMBEDDING_MODEL ||
        !isValidEmbedding(profile.embedding)
      ) {
        return;
      }

      const score = cosineSimilarity(
        embedding,
        profile.embedding
      );

      const previous =
        scores.get(profile.athenaUserId) ?? -1;

      scores.set(
        profile.athenaUserId,
        Math.max(previous, score)
      );
    });

    const matches = [...scores.entries()]
      .map(([athenaUserId, score]) => ({
        athenaUserId,
        score
      }))
      .sort((a, b) => b.score - a.score);

    const best = matches[0];
    const second = matches[1];

    if (!best || best.score < MATCH_THRESHOLD) {
      return null;
    }

    if (
      second &&
      best.score - second.score < MINIMUM_MARGIN
    ) {
      return null;
    }

    console.log(
      "[SpeakerIdentification] Possible enrolled speaker match."
    );

    return best.athenaUserId;

  } catch (error) {
    console.error(
      "[SpeakerIdentification] Error:",
      error.message
    );

    return null;
  }
}
