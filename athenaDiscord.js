// athenaDiscord.js — Message logging, backfill, and channel context utilities

import { ChannelType } from "discord.js";
import { firestore, admin } from "./firebase.js";
import { getOrCreateAthenaUser, getAthenaUserIdForDiscordId } from "./athenaUser.js";

/* ────────────────────────────────────────────
   STORE A SINGLE DISCORD MESSAGE
   Saves raw message immediately, then resolves athenaUserId async.
──────────────────────────────────────────── */
export async function storeDiscordMessage(message) {
  if (!message || !message.author) return;
  if (message.author.bot) return;

  const payload = {
    message_id: message.id,
    content: message.content,
    channel_id: message.channelId,
    channel_name: message.channel?.name || null,
    guild_id: message.guild?.id || null,
    guild_name: message.guild?.name || null,
    discord_user_id: message.author.id,
    username: message.author.username,
    global_name: message.author.globalName || message.author.username,
    avatar_url: message.author.displayAvatarURL?.({ size: 256 }) ?? null,
    platform: "discord",
    athena_user_id: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    discord_created_at: message.createdAt?.toISOString() || null,
  };

  const docRef = await firestore.collection("messages").add(payload);

  /* resolve canonical athenaUserId in background — do NOT block */
  getAthenaUserIdForDiscordId(message.author.id).then(athenaUserId => {
    if (athenaUserId) {
      docRef.update({ athena_user_id: athenaUserId }).catch(() => {});
    } else {
      /* first time seeing this user — create their profile */
      getOrCreateAthenaUser(message.author).then(newId => {
        docRef.update({ athena_user_id: newId }).catch(() => {});
      }).catch(() => {});
    }
  }).catch(() => {});
}

/* ────────────────────────────────────────────
   STORE A BATCH OF HISTORICAL MESSAGES (backfill)
   Used by the history backfill routines.
──────────────────────────────────────────── */
export async function storeMessageBatch(messages) {
  if (!messages || messages.length === 0) return 0;

  /* check which message_ids already exist to avoid duplicates */
  const ids = messages.map(m => m.id);
  const existing = new Set();

  /* Firestore 'in' queries max 30 items */
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await firestore.collection("messages")
      .where("message_id", "in", chunk)
      .get();
    snap.docs.forEach(d => existing.add(d.data().message_id));
  }

  const newMessages = messages.filter(m => !existing.has(m.id));
  if (newMessages.length === 0) return 0;

  const batch = firestore.batch();
  for (const msg of newMessages) {
    const ref = firestore.collection("messages").doc();
    batch.set(ref, {
      message_id: msg.id,
      content: msg.content,
      channel_id: msg.channelId,
      channel_name: msg.channel?.name || null,
      guild_id: msg.guild?.id || null,
      guild_name: msg.guild?.name || null,
      discord_user_id: msg.author.id,
      username: msg.author.username,
      global_name: msg.author.globalName || msg.author.username,
      avatar_url: msg.author.displayAvatarURL?.({ size: 256 }) ?? null,
      platform: "discord",
      athena_user_id: null,
      backfilled: true,
      discord_created_at: msg.createdAt?.toISOString() || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  return newMessages.length;
}

/* ────────────────────────────────────────────
   BACKFILL ALL DISCORD CHANNEL HISTORY
   Called once on bot ready. Fetches up to `limit` messages per channel.
──────────────────────────────────────────── */
export async function backfillDiscordHistory(guild, { limitPerChannel = 500 } = {}) {
  console.log(`[Backfill] Starting history backfill for guild: ${guild.name}`);

  const textChannels = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildText && c.viewable
  );

  let totalStored = 0;
  let totalChannels = 0;

  for (const [, channel] of textChannels) {
    try {
      let fetched = 0;
      let before = null;

      while (fetched < limitPerChannel) {
        const fetchSize = Math.min(100, limitPerChannel - fetched);
        const options = { limit: fetchSize };
        if (before) options.before = before;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        const msgArray = [...batch.values()].filter(m => !m.author.bot);
        const stored = await storeMessageBatch(msgArray);
        totalStored += stored;
        fetched += batch.size;
        before = batch.last()?.id;

        /* rate limit protection — small delay between fetches */
        await new Promise(r => setTimeout(r, 300));

        if (batch.size < fetchSize) break;
      }

      if (fetched > 0) {
        console.log(`[Backfill] #${channel.name}: fetched ${fetched}, new: ${totalStored}`);
        totalChannels++;
      }
    } catch (err) {
      console.error(`[Backfill] Error in #${channel.name}:`, err.message);
    }
  }

  console.log(`[Backfill] Complete. ${totalStored} new messages across ${totalChannels} channels.`);
  return { totalStored, totalChannels };
}

/* ────────────────────────────────────────────
   GET RECENT CHANNEL CONTEXT
   Returns a formatted string of recent messages for Athena's awareness.
──────────────────────────────────────────── */
export async function getRecentChannelContext(channel, limit = 30) {
  try {
    const messages = await channel.messages.fetch({ limit });
    if (messages.size === 0) return "";

    const lines = [...messages.values()]
      .filter(m => !m.author.bot || m.author.username.toLowerCase().includes("athena"))
      .reverse()
      .map(m => {
        const time = m.createdAt.toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true
        });
        return `[${time}] ${m.author.globalName || m.author.username}: ${m.content}`;
      });

    if (lines.length === 0) return "";

    return (
      `[RECENT SERVER ACTIVITY — #${channel.name}]\n` +
      lines.join("\n") +
      `\n[END RECENT ACTIVITY]\n`
    );
  } catch {
    return "";
  }
}

/* ────────────────────────────────────────────
   BACKFILL EXISTING FIRESTORE MESSAGES
   Resolves athena_user_id for messages that were stored with only discord_user_id.
──────────────────────────────────────────── */
export async function backfillExistingMessages() {
  console.log("[Backfill] Resolving athena_user_id for existing messages...");
  const batchSize = 200;
  let lastDoc = null;
  let updated = 0;

  while (true) {
    let q = firestore.collection("messages")
      .where("athena_user_id", "==", null)
      .limit(batchSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data();
      const discordId = data.discord_user_id || data.user_id;
      if (!discordId) continue;

      const athenaUserId = await getAthenaUserIdForDiscordId(discordId);
      if (athenaUserId) {
        await doc.ref.update({ athena_user_id: athenaUserId });
        updated++;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log(`[Backfill] Resolved ${updated} messages.`);
  return updated;
}
