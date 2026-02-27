// athenaDiscord.js — Full message logging, backfill, and context for ALL channel types

import { ChannelType } from "discord.js";
import { firestore, admin } from "./firebase.js";
import { getOrCreateAthenaUser, getAthenaUserIdForDiscordId } from "./athenaUser.js";

/* ── Channel types that can have messages fetched directly ── */
const DIRECT_MESSAGE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

/* ── Channel types whose content lives entirely in threads ── */
const THREAD_CONTAINER_TYPES = new Set([
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

/* ── All top-level types that may also have threads ── */
const THREAD_PARENT_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

/* ────────────────────────────────────────────
   BUILD MESSAGE PAYLOAD
   Consistent schema whether live or backfilled.
──────────────────────────────────────────── */
function buildPayload(msg, overrides = {}) {
  const isThread = msg.channel?.isThread?.() ?? false;
  const parent = msg.channel?.parent ?? null;

  return {
    message_id: msg.id,
    content: msg.content || "",
    /* channel / thread location */
    channel_id: isThread ? (parent?.id ?? msg.channelId) : msg.channelId,
    channel_name: isThread ? (parent?.name ?? null) : (msg.channel?.name ?? null),
    thread_id: isThread ? msg.channelId : null,
    thread_name: isThread ? (msg.channel?.name ?? null) : null,
    /* guild */
    guild_id: msg.guild?.id ?? null,
    guild_name: msg.guild?.name ?? null,
    /* author */
    discord_user_id: msg.author.id,
    username: msg.author.username,
    global_name: msg.author.globalName || msg.author.username,
    avatar_url: msg.author.displayAvatarURL?.({ size: 256 }) ?? null,
    /* meta */
    platform: "discord",
    athena_user_id: null,
    discord_created_at: msg.createdAt?.toISOString() ?? null,
    discord_created_ts: msg.createdTimestamp ?? null,
    ...overrides,
  };
}

/* ────────────────────────────────────────────
   STORE A SINGLE LIVE MESSAGE
──────────────────────────────────────────── */
export async function storeDiscordMessage(message) {
  if (!message?.author) return;
  if (message.author.bot) return;

  const payload = {
    ...buildPayload(message),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await firestore.collection("messages").add(payload);

  /* resolve canonical athenaUserId in background */
  getAthenaUserIdForDiscordId(message.author.id)
    .then(athenaUserId => {
      if (athenaUserId) {
        docRef.update({ athena_user_id: athenaUserId }).catch(() => {});
      } else {
        getOrCreateAthenaUser(message.author)
          .then(newId => docRef.update({ athena_user_id: newId }).catch(() => {}))
          .catch(() => {});
      }
    })
    .catch(() => {});
}

/* ────────────────────────────────────────────
   STORE A BATCH OF HISTORICAL MESSAGES
   Deduplicates by message_id. Splits into Firestore-safe batches of 500.
──────────────────────────────────────────── */
export async function storeMessageBatch(messages, meta = {}) {
  if (!messages?.length) return 0;

  /* deduplicate against existing messages */
  const ids = messages.map(m => m.id);
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await firestore.collection("messages")
      .where("message_id", "in", chunk).get();
    snap.docs.forEach(d => existing.add(d.data().message_id));
  }

  const fresh = messages.filter(m => !existing.has(m.id));
  if (!fresh.length) return 0;

  /* write in batches of 500 (Firestore limit) */
  let stored = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    const batch = firestore.batch();
    for (const msg of chunk) {
      const ref = firestore.collection("messages").doc();
      batch.set(ref, {
        ...buildPayload(msg, meta),
        backfilled: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    stored += chunk.length;
  }

  return stored;
}

/* ────────────────────────────────────────────
   FETCH ALL MESSAGES FROM A READABLE CHANNEL/THREAD
──────────────────────────────────────────── */
async function fetchAndStore(channel, { limitPerChannel, label }) {
  let fetched = 0, stored = 0, before = null;

  while (fetched < limitPerChannel) {
    const size = Math.min(100, limitPerChannel - fetched);
    const opts = { limit: size };
    if (before) opts.before = before;

    let batch;
    try {
      batch = await channel.messages.fetch(opts);
    } catch (err) {
      console.error(`[Backfill] Cannot read ${label}:`, err.message);
      break;
    }
    if (!batch.size) break;

    const msgs = [...batch.values()].filter(m => !m.author.bot && m.content?.trim());
    const s = await storeMessageBatch(msgs);
    stored += s;
    fetched += batch.size;
    before = batch.last()?.id;

    await new Promise(r => setTimeout(r, 250));
    if (batch.size < size) break;
  }

  if (fetched > 0) {
    console.log(`[Backfill] ${label}: ${fetched} fetched, ${stored} new`);
  }
  return { fetched, stored };
}

/* ────────────────────────────────────────────
   FETCH ALL THREADS FROM A CHANNEL (active + archived)
──────────────────────────────────────────── */
async function fetchAllThreads(channel) {
  const threads = [];
  try {
    const active = await channel.threads.fetchActive();
    threads.push(...active.threads.values());
  } catch { /* channel may not support threads */ }

  try {
    let before = null;
    while (true) {
      const opts = { limit: 100, fetchAll: false };
      if (before) opts.before = before;
      const archived = await channel.threads.fetchArchived(opts);
      threads.push(...archived.threads.values());
      if (!archived.hasMore || archived.threads.size === 0) break;
      before = archived.threads.last()?.id;
      await new Promise(r => setTimeout(r, 300));
    }
  } catch { /* some channel types don't support archived */ }

  return threads;
}

/* ────────────────────────────────────────────
   BACKFILL ALL DISCORD HISTORY
   Covers: text, announcement, voice, stage, forum, media + all threads
──────────────────────────────────────────── */
export async function backfillDiscordHistory(guild, { limitPerChannel = 500 } = {}) {
  console.log(`[Backfill] Starting full history backfill for: ${guild.name}`);
  let totalStored = 0, totalSections = 0;

  for (const [, channel] of guild.channels.cache) {
    if (!channel.viewable) continue;

    /* ── Forum / Media: no direct messages — only threads ── */
    if (THREAD_CONTAINER_TYPES.has(channel.type)) {
      const threads = await fetchAllThreads(channel);
      for (const thread of threads) {
        const label = `#${channel.name}/${thread.name} (forum thread)`;
        const { stored } = await fetchAndStore(thread, { limitPerChannel, label });
        totalStored += stored;
        if (stored > 0) totalSections++;
      }
      continue;
    }

    /* ── Direct message channels ── */
    if (DIRECT_MESSAGE_TYPES.has(channel.type) && !channel.isThread()) {
      const label = `#${channel.name} (${ChannelType[channel.type]})`;
      const { stored } = await fetchAndStore(channel, { limitPerChannel, label });
      totalStored += stored;
      if (stored > 0) totalSections++;

      /* also fetch threads inside text/announcement channels */
      if (THREAD_PARENT_TYPES.has(channel.type)) {
        const threads = await fetchAllThreads(channel);
        for (const thread of threads) {
          const tLabel = `#${channel.name}/${thread.name} (thread)`;
          const { stored: ts } = await fetchAndStore(thread, { limitPerChannel, label: tLabel });
          totalStored += ts;
          if (ts > 0) totalSections++;
        }
      }
    }
  }

  console.log(`[Backfill] Done. ${totalStored} new messages across ${totalSections} sections.`);
  return { totalStored, totalSections };
}

/* ────────────────────────────────────────────
   GET RECENT CHANNEL CONTEXT (live Discord API)
   Used for the most recent messages in the active channel.
──────────────────────────────────────────── */
export async function getRecentChannelContext(channel, limit = 30) {
  try {
    const messages = await channel.messages.fetch({ limit });
    if (!messages.size) return "";

    const isThread = channel.isThread?.() ?? false;
    const parentName = isThread ? (channel.parent?.name ?? null) : null;
    const locationLabel = parentName ? `#${parentName}/${channel.name}` : `#${channel.name}`;

    const lines = [...messages.values()]
      .filter(m => !m.author.bot || m.author.username.toLowerCase().includes("athena"))
      .reverse()
      .map(m => {
        const time = m.createdAt.toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true
        });
        return `[${time}] ${m.author.globalName || m.author.username}: ${m.content}`;
      });

    if (!lines.length) return "";
    return `[RECENT ACTIVITY — ${locationLabel}]\n${lines.join("\n")}\n[END RECENT ACTIVITY]\n\n`;
  } catch {
    return "";
  }
}

/* ────────────────────────────────────────────
   BUILD SERVER CONTEXT FROM FIREBASE
   Full historical query with channel + thread + author attribution.
──────────────────────────────────────────── */
export async function buildServerContext({
  channelName = null,
  threadName = null,
  guildId = null,
  daysBack = 7,
  limit = 200,
} = {}) {
  try {
    const cutoffTs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

    let query = firestore.collection("messages")
      .where("platform", "==", "discord");

    if (threadName) {
      /* specific thread requested */
      query = query.where("thread_name", "==", threadName);
    } else if (channelName) {
      /* could be a channel name or a forum/parent name */
      query = query.where("channel_name", "==", channelName);
    } else if (guildId) {
      query = query.where("guild_id", "==", guildId);
    }

    const snap = await query.limit(limit * 5).get();

    if (snap.empty) {
      /* try matching as parent_channel_name (forum scenario) */
      if (channelName) {
        return buildServerContext({ threadName: channelName, guildId, daysBack, limit });
      }
      console.log(`[ServerContext] No messages found for channel="${channelName}" thread="${threadName}"`);
      return "";
    }

    const filtered = snap.docs
      .map(d => d.data())
      .filter(d => {
        const ts = d.discord_created_ts || (d.discord_created_at ? new Date(d.discord_created_at).getTime() : null);
        return ts && ts >= cutoffTs && d.content?.trim();
      })
      .sort((a, b) => {
        const tsA = a.discord_created_ts || new Date(a.discord_created_at).getTime();
        const tsB = b.discord_created_ts || new Date(b.discord_created_at).getTime();
        return tsA - tsB;
      })
      .slice(-limit);

    if (!filtered.length) {
      console.log(`[ServerContext] No messages within last ${daysBack} days for "${channelName || threadName}"`);
      return "";
    }

    const lines = filtered.map(d => {
      const ts = d.discord_created_ts
        ? new Date(d.discord_created_ts)
        : new Date(d.discord_created_at);
      const when = ts.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true
      });
      const author = d.global_name || d.username || "Unknown";
      /* show full location: channel/thread or just channel */
      const loc = d.thread_name
        ? `#${d.channel_name}/${d.thread_name}`
        : `#${d.channel_name || "unknown"}`;
      return `[${when}] [${loc}] ${author}: ${d.content}`;
    });

    const scope = threadName
      ? `#${channelName || ""}/${threadName}`
      : channelName
        ? `#${channelName}`
        : "all channels";

    console.log(`[ServerContext] ${filtered.length} messages from ${scope} (last ${daysBack} days)`);
    return (
      `[SERVER HISTORY — ${scope}, last ${daysBack} day(s) | ${filtered.length} messages]\n` +
      lines.join("\n") +
      `\n[END SERVER HISTORY]\n\n`
    );
  } catch (err) {
    console.error("[ServerContext] Error:", err.message);
    return "";
  }
}

/* ────────────────────────────────────────────
   LIST KNOWN CHANNELS + THREADS IN FIREBASE
   Used for fuzzy-matching user channel references.
──────────────────────────────────────────── */
export async function getKnownChannels(guildId) {
  try {
    const snap = await firestore.collection("messages")
      .where("guild_id", "==", guildId)
      .where("platform", "==", "discord")
      .limit(1000)
      .get();

    const channels = new Set();
    const threads = new Set();

    snap.docs.forEach(d => {
      const data = d.data();
      if (data.channel_name) channels.add(data.channel_name);
      if (data.thread_name)  threads.add(data.thread_name);
    });

    return {
      channels: [...channels],
      threads: [...threads],
      all: [...channels, ...threads],
    };
  } catch {
    return { channels: [], threads: [], all: [] };
  }
}

/* ────────────────────────────────────────────
   GET ACTIVITY PEAKS
   Finds the most active time periods in the server.
   Groups messages by day, ranks by message count,
   and returns peak days with sample messages.
──────────────────────────────────────────── */
export async function getActivityPeaks({
  guildId = null,
  channelName = null,
  daysBack = 90,
  topDays = 5,
} = {}) {
  try {
    const cutoffTs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

    let query = firestore.collection("messages")
      .where("platform", "==", "discord");

    if (channelName) {
      query = query.where("channel_name", "==", channelName);
    } else if (guildId) {
      query = query.where("guild_id", "==", guildId);
    }

    const snap = await query.limit(5000).get();
    if (snap.empty) return "";

    /* group messages by day */
    const byDay = {};
    const byChannel = {};

    snap.docs.forEach(d => {
      const data = d.data();
      const ts = data.discord_created_ts || (data.discord_created_at ? new Date(data.discord_created_at).getTime() : null);
      if (!ts || ts < cutoffTs || !data.content?.trim()) return;

      const date = new Date(ts).toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
      });
      const dayKey = new Date(ts).toISOString().slice(0, 10); /* YYYY-MM-DD */

      if (!byDay[dayKey]) byDay[dayKey] = { label: date, count: 0, messages: [], channels: {} };
      byDay[dayKey].count++;
      byDay[dayKey].messages.push(data);

      const ch = data.thread_name
        ? `${data.channel_name}/${data.thread_name}`
        : (data.channel_name || "unknown");
      byDay[dayKey].channels[ch] = (byDay[dayKey].channels[ch] || 0) + 1;

      /* overall channel totals */
      byChannel[ch] = (byChannel[ch] || 0) + 1;
    });

    if (Object.keys(byDay).length === 0) return "";

    /* sort days by message count, take top N */
    const ranked = Object.entries(byDay)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topDays);

    /* overall most active channels */
    const topChannels = Object.entries(byChannel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ch, count]) => `#${ch} (${count} messages)`);

    /* format output */
    let out = `[ACTIVITY ANALYSIS — last ${daysBack} days]\n`;
    out += `Total messages analyzed: ${snap.docs.length}\n`;
    out += `Most active channels overall: ${topChannels.join(", ")}\n\n`;

    out += `TOP ${ranked.length} MOST ACTIVE DAYS:\n`;
    ranked.forEach(([dayKey, info], i) => {
      const topChs = Object.entries(info.channels)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([ch, n]) => `#${ch}(${n})`)
        .join(", ");
      out += `${i + 1}. ${info.label} — ${info.count} messages | Active in: ${topChs}\n`;

      /* include 10 sample messages from the peak day */
      const samples = info.messages
        .sort((a, b) => {
          const tsA = a.discord_created_ts || new Date(a.discord_created_at).getTime();
          const tsB = b.discord_created_ts || new Date(b.discord_created_at).getTime();
          return tsA - tsB;
        })
        .slice(0, 10);

      if (i === 0) {
        out += `   Sample messages from peak day:\n`;
        samples.forEach(m => {
          const ts = m.discord_created_ts ? new Date(m.discord_created_ts) : new Date(m.discord_created_at);
          const time = ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });
          const loc = m.thread_name ? `#${m.channel_name}/${m.thread_name}` : `#${m.channel_name || "?"}`;
          const author = m.global_name || m.username || "Unknown";
          out += `   [${time}] [${loc}] ${author}: ${m.content}\n`;
        });
      }
      out += "\n";
    });

    out += `[END ACTIVITY ANALYSIS]\n\n`;
    console.log(`[ActivityPeaks] Analyzed ${snap.docs.length} messages, found ${ranked.length} peak days`);
    return out;
  } catch (err) {
    console.error("[ActivityPeaks] Error:", err.message);
    return "";
  }
}

/* ────────────────────────────────────────────
   RESOLVE ATHENA USER IDs FOR EXISTING MESSAGES
──────────────────────────────────────────── */
export async function backfillExistingMessages() {
  console.log("[Backfill] Resolving athena_user_id for stored messages...");
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
