import { admin, firestore } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ── Gemini client for style analysis ── */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

async function getGeminiModel() {
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash-001",
    "gemini-1.5-flash",
    "gemini-pro",
  ];
  for (const m of models) {
    try {
      return genAI.getGenerativeModel({ model: m });
    } catch (_) { }
  }
  return genAI.getGenerativeModel({ model: "gemini-pro" });
}

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
function messagesCol(athenaUserId) {
  return firestore
    .collection("athena_ai")
    .doc("users")
    .collection("humans")
    .doc(athenaUserId)
    .collection("messages");
}

/* ──────────────────────────────────────────────────────
   GEMINI STYLE ANALYSIS
   Given a list of messages from one person, classifies
   their communication style across multiple dimensions.
────────────────────────────────────────────────────── */
async function analyzeIndividualStyle(displayName, messages) {
  if (!messages || messages.length < 2) return null;

  const sample = messages.slice(-80).join("\n");
  const prompt = `
You are analyzing the communication style of a Discord member named "${displayName}".
Below are their recent messages. Analyze and respond with ONLY valid JSON — no markdown, no explanation.

Messages:
${sample}

Respond with this exact JSON shape:
{
  "primaryTone": "humorous|philosophical|serious|casual|aggressive|supportive|analytical|mixed",
  "humorStyle": "sarcastic|dry|silly|dark|absent|punny|witty",
  "intellectualDepth": "surface|moderate|deep|very_deep",
  "topics": ["topic1", "topic2"],
  "sentiment": "positive|negative|neutral|volatile",
  "verbosity": "brief|moderate|verbose",
  "emotionalExpression": "expressive|reserved|balanced",
  "socialRole": "leader|supporter|comedian|philosopher|lurker|instigator|mediator",
  "interactionStyle": "collaborative|competitive|playful|confrontational|nurturing",
  "summary": "2-3 sentence natural language summary of this person's communication style and personality traits"
}
`;

  try {
    const model = await getGeminiModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.error(`[VoiceRecognition] Style analysis failed for ${displayName}:`, err.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────
   GEMINI GROUP DYNAMICS ANALYSIS
   Analyzes how participants interact with each other
   during a voice session based on their combined text.
────────────────────────────────────────────────────── */
async function analyzeGroupDynamics(participants) {
  const hasEnoughData = participants.some(p => (p.textMessages || []).length >= 2);
  if (!hasEnoughData) return null;

  const memberBlocks = participants
    .filter(p => (p.textMessages || []).length > 0)
    .map(p => `[${p.displayName}]:\n${p.textMessages.join("\n")}`)
    .join("\n\n");

  if (!memberBlocks.trim()) return null;

  const prompt = `
You are analyzing the group dynamics of a Discord voice call.
Below are text messages sent by each member during or around the call.
Respond with ONLY valid JSON — no markdown, no explanation.

Messages by member:
${memberBlocks}

Respond with this exact JSON shape:
{
  "overallTone": "casual|focused|chaotic|philosophical|humorous|tense|mixed",
  "dominantTopics": ["topic1", "topic2", "topic3"],
  "groupDynamic": "1-2 sentence description of how this group interacts together",
  "notablePatterns": ["pattern1", "pattern2"],
  "memberRoles": [
    { "displayName": "...", "roleInGroup": "..." }
  ],
  "cohesion": "tight|moderate|loose",
  "energyLevel": "low|medium|high|chaotic"
}
`;

  try {
    const model = await getGeminiModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("[VoiceRecognition] Group dynamics analysis failed:", err.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────
   GET OR CREATE VOICE PROFILE
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

    totalVoiceSeconds: 0,
    totalSessions: 0,
    lastVoiceActivity: null,

    voiceCharacteristics: {
      notes: [],
      identificationConfidence: 0,
      samplesCollected: 0,
    },

    /* Communication style — built from text analysis during/around voice calls */
    communicationStyle: null,

    /* Cumulative style across all sessions — updated after each session */
    cumulativeStyle: {
      toneFrequency: {},
      topTopics: [],
      sessionCount: 0,
      lastAnalyzed: null,
    },

    knownVoiceContacts: [],
    sessionHistory: [],

    createdAt: now,
    updatedAt: now,
  };

  await ref.set(profile);

  await userProfileRef(athenaUserId).set(
    {
      voiceProfile: {
        profileId: athenaUserId,
        totalVoiceSeconds: 0,
        totalSessions: 0,
        lastVoiceActivity: null,
        communicationStyle: null,
      },
      "linkedPlatforms.voice": athenaUserId,
    },
    { merge: true }
  ).catch(() => {});

  console.log(`[VoiceRecognition] Created voice profile for ${discordUser.username} (${athenaUserId})`);
  return profile;
}

/* ──────────────────────────────────────────────────────
   CAPTURE TEXT MESSAGE DURING VOICE SESSION
   Called from bot.js message handler when a sender is
   currently in an active voice session.
────────────────────────────────────────────────────── */
export function captureVoiceText(channelId, userId, content) {
  /* This function is called by bot.js with the activeSessions map.
     The map is kept in bot.js and passed here as a side-effect.
     We just export a helper that bot.js uses directly. */
}

/* ──────────────────────────────────────────────────────
   START VOICE SESSION
────────────────────────────────────────────────────── */
export async function startVoiceSession({ sessionId, guildId, guildName, channelId, channelName, startTime }) {
  try {
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
      textLog: [],
      insights: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[Firestore:voice_sessions] Started session ${sessionId} (#${channelName})`);
  } catch (err) {
    console.error(`[Firestore:voice_sessions] startVoiceSession FAILED for ${sessionId}:`, err.message);
    throw err;
  }
}

/* ──────────────────────────────────────────────────────
   ADD PARTICIPANT JOIN
────────────────────────────────────────────────────── */
export async function recordParticipantJoin(sessionId, { athenaUserId, discordId, displayName, joinTime }) {
  try {
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
    console.log(`[Firestore:voice_sessions] Recorded join ${displayName} → ${sessionId}`);
  } catch (err) {
    console.error(`[Firestore:voice_sessions] recordParticipantJoin FAILED for ${displayName} → ${sessionId}:`, err.message);
    throw err; /* let callers' .catch handle it; do not silently succeed */
  }
}

/* ──────────────────────────────────────────────────────
   FINALIZE VOICE SESSION
   Full rich finalization:
   - Stores text log from the session
   - Runs per-participant and group Gemini style analysis
   - Updates voice profiles with rich style data
   - Updates cumulative style trends over time
────────────────────────────────────────────────────── */
export async function finalizeVoiceSession(session) {
  const endTime = new Date();
  const durationSeconds = Math.floor((endTime - session.startTime) / 1000);

  if (durationSeconds < 5) return;

  /* Build participant summaries with their text messages */
  const participantList = [...session.participants.values()];
  const participantSummaries = participantList.map(p => ({
    athenaUserId: p.athenaUserId || null,
    discordId: p.discordId,
    displayName: p.displayName,
    joinTime: new Date(p.joinTime).toISOString(),
    leaveTime: endTime.toISOString(),
    durationSeconds: Math.floor((endTime - p.joinTime) / 1000),
    textMessages: p.textMessages || [],
    textMessageCount: (p.textMessages || []).length,
  }));

  /* Build full chronological text log for the session */
  const textLog = (session.textLog || []).sort((a, b) =>
    new Date(a.timestamp) - new Date(b.timestamp)
  );

  console.log(`[VoiceRecognition] Finalizing session ${session.sessionId} — running style analysis...`);

  /* Run per-participant style analysis in parallel */
  const styleResults = await Promise.all(
    participantSummaries.map(p =>
      analyzeIndividualStyle(p.displayName, p.textMessages)
        .then(style => ({ athenaUserId: p.athenaUserId, discordId: p.discordId, style }))
        .catch(() => ({ athenaUserId: p.athenaUserId, discordId: p.discordId, style: null }))
    )
  );

  /* Run group dynamics analysis */
  const groupInsights = await analyzeGroupDynamics(participantSummaries).catch(() => null);

  /* Map style results by discordId for easy lookup */
  const styleMap = {};
  for (const r of styleResults) {
    styleMap[r.discordId] = r.style;
  }

  /* Enrich participant summaries with style data */
  const enrichedParticipants = participantSummaries.map(p => ({
    ...p,
    communicationStyle: styleMap[p.discordId] || null,
  }));

  /* Update the session document with full rich data */
  try {
    await voiceSessionsCol().doc(session.sessionId).set(
      {
        endTime: admin.firestore.Timestamp.fromDate(endTime),
        duration: durationSeconds,
        status: "completed",
        participants: enrichedParticipants.map(p => ({
          ...p,
          textMessages: p.textMessages.slice(-100), /* cap at 100 msgs per participant */
        })),
        participantCount: enrichedParticipants.length,
        textLog: textLog.slice(-500), /* cap at 500 total messages */
        insights: groupInsights,
      },
      { merge: true }
    );
    console.log(`[Firestore:voice_sessions] Finalized session ${session.sessionId} (${durationSeconds}s, ${enrichedParticipants.length} participants)`);
  } catch (err) {
    console.error(`[Firestore:voice_sessions] finalizeVoiceSession FAILED for ${session.sessionId}:`, err.message);
    throw err; /* propagate so callers' .catch logs the failure path explicitly */
  }

  /* Build contact list */
  const participantIds = participantSummaries
    .filter(p => p.athenaUserId)
    .map(p => p.athenaUserId);

  /* Update each participant's voice profile */
  const batch = firestore.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const p of enrichedParticipants) {
    if (!p.athenaUserId) continue;

    const profileRef = voiceProfilesCol().doc(p.athenaUserId);

    const contacts = participantIds
      .filter(id => id !== p.athenaUserId)
      .map(id => {
        const contact = participantSummaries.find(x => x.athenaUserId === id);
        return {
          athenaUserId: id,
          displayName: contact?.displayName || id,
          sessionCount: 1,
        };
      });

    /* Rich session summary stored on the voice profile */
    const sessionSummary = {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelName: session.channelName,
      joinTime: p.joinTime,
      leaveTime: p.leaveTime,
      durationSeconds: p.durationSeconds,
      participantCount: participantSummaries.length,
      participantNames: participantSummaries.map(x => x.displayName),
      textMessageCount: p.textMessageCount,
      communicationStyle: p.communicationStyle,
      groupInsights: groupInsights ? {
        overallTone: groupInsights.overallTone,
        dominantTopics: groupInsights.dominantTopics,
        groupDynamic: groupInsights.groupDynamic,
      } : null,
    };

    /* Build tone frequency update for cumulative style tracking */
    const toneKey = p.communicationStyle?.primaryTone;
    const toneUpdate = toneKey
      ? { [`cumulativeStyle.toneFrequency.${toneKey}`]: admin.firestore.FieldValue.increment(1) }
      : {};

    batch.set(profileRef, {
      totalVoiceSeconds: admin.firestore.FieldValue.increment(p.durationSeconds),
      totalSessions: admin.firestore.FieldValue.increment(1),
      lastVoiceActivity: now,
      communicationStyle: p.communicationStyle || admin.firestore.FieldValue.delete(),
      knownVoiceContacts: admin.firestore.FieldValue.arrayUnion(...contacts),
      sessionHistory: admin.firestore.FieldValue.arrayUnion(sessionSummary),
      "cumulativeStyle.sessionCount": admin.firestore.FieldValue.increment(1),
      "cumulativeStyle.lastAnalyzed": now,
      updatedAt: now,
      ...toneUpdate,
    }, { merge: true });

    /* Mirror to main profile */
    batch.set(userProfileRef(p.athenaUserId), {
      "voiceProfile.totalVoiceSeconds": admin.firestore.FieldValue.increment(p.durationSeconds),
      "voiceProfile.totalSessions": admin.firestore.FieldValue.increment(1),
      "voiceProfile.lastVoiceActivity": now,
      "voiceProfile.communicationStyle": p.communicationStyle || null,
    }, { merge: true });
  }

  await batch.commit();

  const styleLog = enrichedParticipants
    .filter(p => p.communicationStyle)
    .map(p => `${p.displayName}: ${p.communicationStyle.primaryTone}`)
    .join(", ");

  console.log(`[VoiceRecognition] Session ${session.sessionId} finalized — ${durationSeconds}s, styles: [${styleLog || "no text data"}]`);
}

/* ──────────────────────────────────────────────────────
   BUILD STYLE PROFILE FROM MESSAGE HISTORY
   Retroactively analyzes all of a user's stored messages
   in Firestore to build their communication style profile.
   Addresses the "sessions that already happened" gap.
────────────────────────────────────────────────────── */
export async function buildStyleProfileFromHistory(athenaUserId) {
  try {
    /* Fetch up to 200 recent messages for this user from Firebase */
    const snap = await messagesCol(athenaUserId)
      .orderBy("timestamp", "desc")
      .limit(200)
      .get();

    if (snap.empty) return null;

    const messages = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.role === "user" && d.content && d.content.length > 3) {
        messages.push(d.content);
      }
    });

    if (messages.length < 5) return null;

    /* Get display name from voice profile or user profile */
    const vpDoc = await voiceProfilesCol().doc(athenaUserId).get();
    const displayName = vpDoc.exists
      ? vpDoc.data().displayName
      : athenaUserId;

    const style = await analyzeIndividualStyle(displayName, messages.reverse());
    if (!style) return null;

    /* Store the derived style on the voice profile */
    await voiceProfilesCol().doc(athenaUserId).set(
      {
        communicationStyle: style,
        "voiceCharacteristics.samplesCollected": messages.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    /* Mirror to main profile */
    await userProfileRef(athenaUserId).set(
      { "voiceProfile.communicationStyle": style },
      { merge: true }
    ).catch(() => {});

    console.log(`[VoiceRecognition] Built style profile for ${displayName} from ${messages.length} historical messages — tone: ${style.primaryTone}`);
    return style;
  } catch (err) {
    console.error(`[VoiceRecognition] buildStyleProfileFromHistory error:`, err.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────
   BUILD ALL STYLE PROFILES
   Admin function: run retroactive analysis on every user
   who has a voice profile but no communicationStyle set.
────────────────────────────────────────────────────── */
export async function buildAllStyleProfiles() {
  const snap = await voiceProfilesCol()
    .where("communicationStyle", "==", null)
    .get();

  const ids = snap.docs.map(d => d.id);
  console.log(`[VoiceRecognition] Building style profiles for ${ids.length} users...`);

  let built = 0;
  for (const id of ids) {
    const style = await buildStyleProfileFromHistory(id).catch(() => null);
    if (style) built++;
    await new Promise(r => setTimeout(r, 500)); /* rate limit Gemini */
  }

  console.log(`[VoiceRecognition] Done — built ${built}/${ids.length} profiles`);
  return { total: ids.length, built };
}

/* ──────────────────────────────────────────────────────
   ADD VOICE NOTE
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
────────────────────────────────────────────────────── */
export async function getVoiceProfile(athenaUserId) {
  const doc = await voiceProfilesCol().doc(athenaUserId).get();
  return doc.exists ? doc.data() : null;
}

/* ──────────────────────────────────────────────────────
   GET RECENT VOICE SESSIONS
   Returns both completed and active sessions, newest first.
────────────────────────────────────────────────────── */
export async function getRecentVoiceSessions(guildId, limit = 10) {
  /* completed sessions (have endTime, ordered properly) */
  const completedSnap = await voiceSessionsCol()
    .where("guildId", "==", guildId)
    .where("status", "==", "completed")
    .orderBy("endTime", "desc")
    .limit(limit)
    .get();

  /* active sessions (no endTime yet — order by startTime) */
  const activeSnap = await voiceSessionsCol()
    .where("guildId", "==", guildId)
    .where("status", "==", "active")
    .orderBy("startTime", "desc")
    .limit(5)
    .get();

  const completed = completedSnap.docs.map(d => d.data());
  const active    = activeSnap.docs.map(d => d.data());

  /* merge, deduplicate by sessionId, most recent first */
  const all = [...active, ...completed];
  const seen = new Set();
  const merged = [];
  for (const s of all) {
    if (!seen.has(s.sessionId)) {
      seen.add(s.sessionId);
      merged.push(s);
    }
  }
  return merged.slice(0, limit);
}

/* ──────────────────────────────────────────────────────
   FORMAT VOICE SESSIONS FOR ATHENA CONTEXT
   Converts session documents into a readable text block
   that Athena can use to answer voice-related questions.
────────────────────────────────────────────────────── */
export function formatVoiceSessionsForContext(sessions) {
  if (!sessions || sessions.length === 0) {
    return "[VOICE HISTORY: No voice sessions recorded yet for this server.]\n\n";
  }

  const lines = [`[VOICE CALL HISTORY — ${sessions.length} recent session(s)]\n`];

  for (const s of sessions) {
    const start = s.startTime?.toDate?.() ?? new Date(s.startTime);
    const end   = s.endTime?.toDate?.()   ?? (s.status === "active" ? null : new Date(s.endTime));
    const durationMins = s.duration ? Math.round(s.duration / 60) : null;

    lines.push(`── Session in #${s.channelName || s.channelId} (${s.status})`);
    lines.push(`   Started: ${start.toLocaleString()}`);
    if (end) lines.push(`   Ended:   ${end.toLocaleString()} (${durationMins ?? "?"} min)`);

    const participants = Array.isArray(s.participants) ? s.participants : [];
    if (participants.length > 0) {
      const names = participants.map(p => p.displayName).join(", ");
      lines.push(`   Participants (${participants.length}): ${names}`);

      for (const p of participants) {
        const msgCount = p.textMessageCount ?? (p.textMessages?.length ?? 0);
        const style    = p.communicationStyle?.primaryTone ?? null;
        const detail   = [
          p.durationSeconds ? `${Math.round(p.durationSeconds / 60)} min` : null,
          msgCount > 0 ? `${msgCount} msgs` : null,
          style ? `tone: ${style}` : null,
        ].filter(Boolean).join(", ");
        if (detail) lines.push(`     • ${p.displayName}: ${detail}`);

        /* include their transcript lines if any */
        const msgs = p.textMessages || [];
        if (msgs.length > 0) {
          lines.push(`       Messages during call:`);
          for (const m of msgs.slice(0, 10)) {
            lines.push(`         "${m}"`);
          }
          if (msgs.length > 10) lines.push(`         ... and ${msgs.length - 10} more`);
        }
      }
    } else {
      lines.push(`   Participants: (none recorded)`);
    }

    /* group insights */
    if (s.insights) {
      lines.push(`   Group dynamics: ${s.insights.groupDynamic ?? ""} | Tone: ${s.insights.overallTone ?? ""}`);
      if (s.insights.dominantTopics?.length) {
        lines.push(`   Topics discussed: ${s.insights.dominantTopics.join(", ")}`);
      }
    }

    /* text log snippets (what was said in text chat during the call) */
    const textLog = Array.isArray(s.textLog) ? s.textLog : [];
    if (textLog.length > 0) {
      lines.push(`   Text chat during call (${textLog.length} messages):`);
      for (const entry of textLog.slice(0, 15)) {
        lines.push(`     [${entry.displayName}]: ${entry.content}`);
      }
      if (textLog.length > 15) lines.push(`     ... and ${textLog.length - 15} more`);
    }

    lines.push("");
  }

  lines.push("[END VOICE CALL HISTORY]\n");
  return lines.join("\n");
}
