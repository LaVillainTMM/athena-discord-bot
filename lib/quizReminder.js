import { firestore, admin } from "../firebase.js";

const NATION_ROLES        = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];
const WEEK_MS             = 7 * 24 * 60 * 60 * 1000;
const REMINDER_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000; /* 6 days — prevents double-messaging */

/* ── Check if a Discord user has a completed quiz on file ── */
export async function hasCompletedQuiz(discordId) {
  const doc = await firestore.collection("discord_quiz_results").doc(discordId).get();
  return doc.exists && doc.data()?.completed === true;
}

/* ── Get the timestamp of the last reminder sent to a user ── */
async function getLastRemindedAt(discordId) {
  const doc = await firestore.collection("quiz_reminders").doc(discordId).get();
  return doc.exists ? (doc.data()?.lastRemindedAt?.toDate() ?? null) : null;
}

/* ── Record that we sent a reminder to this user ── */
async function recordReminder(discordId) {
  await firestore.collection("quiz_reminders").doc(discordId).set(
    { lastRemindedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/* ── Build the reminder DM message ── */
function buildReminderMessage(hasRole) {
  const context = hasRole
    ? "Even though you already have a Nation role, your full DBI Quiz still needs to be on file."
    : "Completing the DBI Quiz is required to gain full access to the server.";

  return (
    `**DBI NationZ — Quiz Required**\n\n` +
    `${context}\n\n` +
    `The quiz is **50 questions** and takes roughly 20–30 minutes to complete. ` +
    `Your answers are analyzed by Athena AI to determine your official Nation placement.\n\n` +
    `➤  Reply **!quiz** right here to begin your quiz session.\n` +
    `➤  Or type **!quiz** in any server channel where I'm active.\n\n` +
    `_This is a weekly reminder. Complete the quiz to remove it._`
  );
}

/* ── Send weekly quiz reminders to all members without a completed quiz ── */
export async function sendWeeklyQuizReminders(guild) {
  console.log("[QuizReminder] Starting weekly quiz check...");

  await guild.members.fetch();

  let reminded      = 0;
  let alreadyDone   = 0;
  let onCooldown    = 0;
  let failed        = 0;

  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;

    /* Skip if quiz already completed */
    const completed = await hasCompletedQuiz(member.user.id);
    if (completed) { alreadyDone++; continue; }

    /* Skip if reminded recently */
    const lastAt = await getLastRemindedAt(member.user.id);
    if (lastAt && Date.now() - lastAt.getTime() < REMINDER_COOLDOWN_MS) {
      onCooldown++;
      continue;
    }

    /* Send DM */
    const hasRole = member.roles.cache.some(r => NATION_ROLES.includes(r.name));
    try {
      await member.send(buildReminderMessage(hasRole));
      await recordReminder(member.user.id);
      reminded++;
      console.log(`[QuizReminder] Reminded ${member.user.username} (hasRole: ${hasRole})`);
    } catch (err) {
      console.warn(`[QuizReminder] Could not DM ${member.user.username}: ${err.message}`);
      failed++;
    }

    /* Respect Discord rate limits — 1 DM per second */
    await new Promise(r => setTimeout(r, 1000));
  }

  const summary = `reminded: ${reminded}, done: ${alreadyDone}, cooldown: ${onCooldown}, failed: ${failed}`;
  console.log(`[QuizReminder] Complete — ${summary}`);
  return { reminded, alreadyDone, onCooldown, failed };
}

/* ── Schedule weekly reminders every Sunday at midnight ── */
export function scheduleWeeklyReminders(guild) {
  const msUntilNextSunday = () => {
    const now        = new Date();
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + ((7 - now.getDay()) % 7 || 7));
    nextSunday.setHours(0, 0, 0, 0);
    return nextSunday.getTime() - now.getTime();
  };

  const delay = msUntilNextSunday();
  console.log(`[QuizReminder] Scheduled — first run in ${Math.round(delay / 3_600_000)}h (next Sunday midnight)`);

  setTimeout(() => {
    sendWeeklyQuizReminders(guild);
    setInterval(() => sendWeeklyQuizReminders(guild), WEEK_MS);
  }, delay);
}
