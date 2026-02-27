import { admin, firestore } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";

/* ── Collection helpers ── */
function voiceProfilesCol() {
  return firestore.collection("athena_ai").doc("voice_profiles").collection("profiles");
}
function voiceSessionsCol() {
  return firestore.collection("athena_ai").doc("voice_sessions").collection("sessions");
}
function userProfileRef(athenaUserId) {
  return firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("profile")
    .doc("core");
}

/* ──────────────────────────────────────────────────────
   GET OR CREATE VOICE PROFILE
   Called when a user first joins a voice channel.
   Creates the profile if it doesn't exist and links it
   to the user's main Athena profile.
────────────────────────────────────────────────────── */
export async function getOrCreateVoiceProfile(athenaUserId, discordUser) {
  const ref = voiceProfilesCol().doc(athenaUserId);
  const existing = await ref.get();

  if (existing.exists) return existing.data();

  const now = admin.firestore.FieldValue.serverTimestamp();
  const profile = {
    athenaUserId,
    discordId: discordUser.id,
    displayName: discordUser.globalName || discordUser.username,

    /* cumulative stats */
    totalVoiceSeconds: 0,
    totalSessions: 0,
    lastVoiceActivity: null,

    /* voice identification data */
    voiceCharacteristics: {
      /* Future: store voice fingerprint vectors, pitch profile,
         speaking pace, vocabulary patterns, etc. */
      notes: [],
      identificationConfidence: 0,
      samplesCollected: 0,
    },

    /* people they've called with (for social graph + identity verification) */
    knownVoiceContacts: [],

    /* lightweight session log — last 50 sessions */
    sessionHistory: [],

    createdAt: now,
    updatedAt: now,
  };

  await ref.set(profile);

  /* link the voice profile back to the user's main Athena profile */
  await userProfileRef(athenaUserId).set(
    {
      voiceProfile: {
        profileId: athenaUserId,
        totalVoiceSeconds: 0,
        totalSessions: 0,
        lastVoiceActivity: null,
      },
      "linkedPlatforms.voice": athenaUserId,
    },
    { merge: true }
  ).catch(() => {});

  console.log(`[VoiceRecognition] Created voice profile for ${discordUser.username} (${athenaUserId})`);
  return profile;
}

/* ──────────────────────────────────────────────────────
   START VOICE SESSION
   Called when the first non-bot user joins a channel.
   Creates a Firebase record for the session.
────────────────────────────────────────────────────── */
export async function startVoiceSession({ sessionId, guildId, guildName, channelId, channelName, startTime }) {
  const ref = voiceSessionsCol().doc(sessionId);
  await ref.set({
    sessionId,
    guildId,
    guildName,
    channelId,
    channelName,
    startTime: admin.firestore.Timestamp.fromDate(startTime),
    endTime: null,
    duration: null,
    status: "active",
    participants: [],
    participantCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[VoiceRecognition] Session started: ${sessionId} in #${channelName}`);
}

/* ──────────────────────────────────────────────────────
   ADD PARTICIPANT JOIN
   Called when a user joins a voice channel mid-session.
────────────────────────────────────────────────────── */
export async function recordParticipantJoin(sessionId, { athenaUserId, discordId, displayName, joinTime }) {
  const ref = voiceSessionsCol().doc(sessionId);
  await ref.set(
    {
      participants: admin.firestore.FieldValue.arrayUnion({
        athenaUserId: athenaUserId || null,
        discordId,
        displayName,
        joinTime: admin.firestore.Timestamp.fromDate(new Date(joinTime)),
        leaveTime: null,
        durationSeconds: null,
      }),
      participantCount: admin.firestore.FieldValue.increment(1),
    },
    { merge: true }
  );
}

/* ──────────────────────────────────────────────────────
   FINALIZE VOICE SESSION
   Called when the last participant leaves a channel.
   Writes final stats and updates each participant's
   voice profile with session data.
────────────────────────────────────────────────────── */
export async function finalizeVoiceSession(session) {
  const endTime = new Date();
  const durationSeconds = Math.floor((endTime - session.startTime) / 1000);

  /* Skip trivially short sessions (< 5 seconds) */
  if (durationSeconds < 5) return;

  /* Compute per-participant durations */
  const participantSummaries = [...session.participants.values()].map(p => ({
    athenaUserId: p.athenaUserId || null,
    discordId: p.discordId,
    displayName: p.displayName,
    joinTime: new Date(p.joinTime).toISOString(),
    leaveTime: endTime.toISOString(),
    durationSeconds: Math.floor((endTime - p.joinTime) / 1000),
  }));

  /* Update the session document */
  await voiceSessionsCol().doc(session.sessionId).set(
    {
      endTime: admin.firestore.Timestamp.fromDate(endTime),
      duration: durationSeconds,
      status: "completed",
      participants: participantSummaries,
      participantCount: participantSummaries.length,
    },
    { merge: true }
  );

  /* Build the contact list for cross-referencing */
  const participantIds = participantSummaries
    .filter(p => p.athenaUserId)
    .map(p => p.athenaUserId);

  /* Update each participant's voice profile */
  const batch = firestore.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const p of participantSummaries) {
    if (!p.athenaUserId) continue;

    const profileRef = voiceProfilesCol().doc(p.athenaUserId);

    /* Contacts are other participants in this call */
    const contacts = participantIds
      .filter(id => id !== p.athenaUserId)
      .map(id => {
        const contact = participantSummaries.find(x => x.athenaUserId === id);
        return { athenaUserId: id, displayName: contact?.displayName || id };
      });

    /* Lightweight session summary stored on voice profile */
    const sessionSummary = {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelName: session.channelName,
      joinTime: p.joinTime,
      leaveTime: p.leaveTime,
      durationSeconds: p.durationSeconds,
      participantCount: participantSummaries.length,
    };

    batch.set(profileRef, {
      totalVoiceSeconds: admin.firestore.FieldValue.increment(p.durationSeconds),
      totalSessions: admin.firestore.FieldValue.increment(1),
      lastVoiceActivity: now,
      knownVoiceContacts: admin.firestore.FieldValue.arrayUnion(...contacts),
      sessionHistory: admin.firestore.FieldValue.arrayUnion(sessionSummary),
      updatedAt: now,
    }, { merge: true });

    /* Mirror key stats to the main user profile for quick access */
    batch.set(userProfileRef(p.athenaUserId), {
      "voiceProfile.totalVoiceSeconds": admin.firestore.FieldValue.increment(p.durationSeconds),
      "voiceProfile.totalSessions": admin.firestore.FieldValue.increment(1),
      "voiceProfile.lastVoiceActivity": now,
    }, { merge: true });
  }

  await batch.commit();

  console.log(`[VoiceRecognition] Session ${session.sessionId} finalized — ${durationSeconds}s, ${participantSummaries.length} participant(s)`);
}

/* ──────────────────────────────────────────────────────
   ADD VOICE NOTE
   Admin tool: annotate a user's voice profile with
   an identification note (e.g. "deep voice", "fast speaker").
   Used to manually improve recognition accuracy.
────────────────────────────────────────────────────── */
export async function addVoiceNote(athenaUserId, note, addedBy = "admin") {
  const ref = voiceProfilesCol().doc(athenaUserId);
  await ref.set(
    {
      "voiceCharacteristics.notes": admin.firestore.FieldValue.arrayUnion({
        note,
        addedBy,
        addedAt: new Date().toISOString(),
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/* ──────────────────────────────────────────────────────
   GET VOICE PROFILE
   Retrieve a user's voice recognition profile.
────────────────────────────────────────────────────── */
export async function getVoiceProfile(athenaUserId) {
  const doc = await voiceProfilesCol().doc(athenaUserId).get();
  return doc.exists ? doc.data() : null;
}

/* ──────────────────────────────────────────────────────
   GET RECENT VOICE SESSIONS
   Returns the N most recent sessions for a guild/channel.
────────────────────────────────────────────────────── */
export async function getRecentVoiceSessions(guildId, limit = 10) {
  const snap = await voiceSessionsCol()
    .where("guildId", "==", guildId)
    .where("status", "==", "completed")
    .orderBy("endTime", "desc")
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}
