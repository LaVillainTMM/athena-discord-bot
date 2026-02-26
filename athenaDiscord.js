// athenaDiscord.js — Message logging, backfill, and context utilities

import { ChannelType } from "discord.js";
import { firestore, admin } from "./firebase.js";
import { getOrCreateAthenaUser, getAthenaUserIdForDiscordId } from "./athenaUser.js";

/* ────────────────────────────────────────────
   STORE A SINGLE DISCORD MESSAGE
   Saves immediately, then resolves athenaUserId async (non-blocking).
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
    discord_created_at: message.createdAt?.toISOString() || null,
    discord_created_ts: message.createdTimestamp || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await firestore.collection("messages").add(payload);

  getAthenaUserIdForDiscordId(message.author.id).then(athenaUserId => {
    if (athenaUserId) {
      docRef.update({ athena_user_id: athenaUserId }).catch(() => {});
    } else {
      getOrCreateAthenaUser(message.author).then(newId => {
        docRef.update({ athena_user_id: newId }).catch(() => {});
      }).catch(() => {});
    }
  }).catch(() => {});
}

/* ────────────────────────────────────────────
   STORE A BATCH OF HISTORICAL MESSAGES (backfill)
──────────────────────────────────────────── */
export async function storeMessageBatch(messages) {
  if (!messages || messages.length === 0) return 0;

  const ids = messages.map(m => m.id);
  const existing = new Set();

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
      discord_created_ts: msg.createdTimestamp || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  return newMessages.length;
}

/* ────────────────────────────────────────────
   BACKFILL ALL DISCORD CHANNEL HISTORY
   Fetches up to limitPerChannel messages per text channel.
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

        await new Promise(r => setTimeout(r, 300));
        if (batch.size < fetchSize) break;
      }

      if (fetched > 0) {
        console.log(`[Backfill] #${channel.name}: fetched ${fetched}, stored ${totalStored} total`);
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
   GET RECENT CHANNEL CONTEXT (live, Discord API)
   Used for the last ~30 messages from current channel.
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
    return `[RECENT ACTIVITY — #${channel.name}]\n${lines.join("\n")}\n[END RECENT ACTIVITY]\n\n`;
  } catch {
    return "";
  }
}

/* ────────────────────────────────────────────
   BUILD SERVER CONTEXT FROM FIREBASE
   Queries stored messages for a given channel + time range.
   This is the core of Athena's historical awareness.
──────────────────────────────────────────── */
export async function buildServerContext({
  channelName = null,
  guildId = null,
  daysBack = 7,
  limit = 200,
} = {}) {
  try {
    const cutoffTs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

    /* Query by channel_name if provided, else by guild_id */
    let query = firestore.collection("messages")
      .where("platform", "==", "discord");

    if (channelName) {
      query = query.where("channel_name", "==", channelName);
    } else if (guildId) {
      query = query.where("guild_id", "==", guildId);
    }

    /* Fetch more than limit so we can filter by date in memory */
    query = query.limit(limit * 4);

    const snap = await query.get();
    if (snap.empty) {
      console.log(`[ServerContext] No messages found for channel="${channelName}" guild="${guildId}"`);
      return "";
    }

    /* Filter by date range and sort chronologically */
    const filtered = snap.docs
      .map(d => d.data())
      .filter(d => {
        if (!d.discord_created_ts && !d.discord_created_at) return false;
        const ts = d.discord_created_ts || new Date(d.discord_created_at).getTime();
        return ts >= cutoffTs;
      })
      .filter(d => d.content && d.content.trim().length > 0)
      .sort((a, b) => {
        const tsA = a.discord_created_ts || new Date(a.discord_created_at).getTime();
        const tsB = b.discord_created_ts || new Date(b.discord_created_at).getTime();
        return tsA - tsB;
      })
      .slice(-limit);

    if (filtered.length === 0) {
      console.log(`[ServerContext] Messages found but none within last ${daysBack} days for channel="${channelName}"`);
      return "";
    }

    const lines = filtered.map(d => {
      const ts = d.discord_created_ts
        ? new Date(d.discord_created_ts)
        : new Date(d.discord_created_at);
      const time = ts.toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
        timeZone: "UTC", hour12: true
      });
      const author = d.global_name || d.username || "Unknown";
      return `[${time}] ${author}: ${d.content}`;
    });

    const scope = channelName ? `#${channelName}` : "server-wide";
    console.log(`[ServerContext] Built context: ${filtered.length} messages from ${scope} (last ${daysBack} days)`);
    return (
      `[SERVER HISTORY — ${scope}, last ${daysBack} day(s)]\n` +
      lines.join("\n") +
      `\n[END SERVER HISTORY]\n\n`
    );
  } catch (err) {
    console.error("[ServerContext] Error:", err.message);
    return "";
  }
}

/* ────────────────────────────────────────────
   LIST KNOWN CHANNEL NAMES IN FIREBASE
   Lets us fuzzy-match a user's channel reference.
──────────────────────────────────────────── */
export async function getKnownChannels(guildId) {
  try {
    const snap = await firestore.collection("messages")
      .where("guild_id", "==", guildId)
      .where("platform", "==", "discord")
      .limit(500)
      .get();
    const channels = new Set();
    snap.docs.forEach(d => {
      const name = d.data().channel_name;
      if (name) channels.add(name);
    });
    return [...channels];
  } catch {
    return [];
  }
}

/* ────────────────────────────────────────────
   BACKFILL EXISTING FIRESTORE MESSAGES
   Resolves athena_user_id for messages stored with only discord_user_id.
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
