// backfillMessages.js
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { firestore, admin } from "./firebase.js";
import { Timestamp } from "firebase-admin/firestore";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// optional: backfill only messages after this date (ISO string)
const BACKFILL_FROM = process.env.BACKFILL_FROM || null;

async function getCentralUserId(discordId) {
  const snap = await firestore
    .collection("athena_ai")
    .where("platforms.discord.id", "==", discordId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id; // document ID == central user UID
}

async function backfillGuildMessages() {
  console.log("[Backfill] Starting message backfill...");

  for (const guild of client.guilds.cache.values()) {
    console.log(`[Backfill] Processing guild: ${guild.name} (${guild.id})`);

    const channels = guild.channels.cache.filter(c => c.isTextBased());

    for (const channel of channels.values()) {
      console.log(`[Backfill] Fetching messages from channel: ${channel.name} (${channel.id})`);

      let lastId = null;
      let fetched;
      do {
        fetched = await channel.messages.fetch({ limit: 100, before: lastId }).catch(err => {
          console.error(`[Backfill] Failed fetching messages: ${err.message}`);
          return null;
        });

        if (!fetched || fetched.size === 0) break;

        const batch = [];

        for (const msg of fetched.values()) {
          if (msg.author.bot) continue;
          if (BACKFILL_FROM && msg.createdAt < new Date(BACKFILL_FROM)) continue;

          const userDocId = await getCentralUserId(msg.author.id);
          if (!userDocId) {
            console.warn(`[Backfill] No central user found for ${msg.author.username}`);
            continue;
          }

          const timestamp = Timestamp.fromDate(msg.createdAt);

          batch.push({
            user_uid: userDocId,
            platform: "discord",
            user_id: msg.author.id,
            username: msg.author.username,
            content: msg.content,
            guild_id: guild.id,
            guild_name: guild.name,
            channel_id: channel.id,
            channel_name: channel.name,
            timestamp: timestamp,
            timezone_offset_minutes: msg.createdAt.getTimezoneOffset(),
            fetchedAtUTC: Timestamp.now(),
          });
        }

        while (batch.length > 0) {
          const slice = batch.splice(0, 500);
          const batchWrite = firestore.batch();
          slice.forEach(doc => {
            const ref = firestore.collection("messages").doc();
            batchWrite.set(ref, doc);

            // also update user message stats
            const userRef = firestore.collection("athena_ai").doc(doc.user_uid);
            batchWrite.update(userRef, {
              "message_stats.total_messages": admin.firestore.FieldValue.increment(1),
              "message_stats.last_message": doc.timestamp,
            });
          });
          await batchWrite.commit();
          console.log(`[Backfill] Wrote ${slice.length} messages to Firestore`);
        }

        lastId = fetched.last()?.id;
      } while (fetched.size === 100);

      console.log(`[Backfill] Finished channel: ${channel.name}`);
    }

    console.log(`[Backfill] Finished guild: ${guild.name}`);
  }

  console.log("[Backfill] Message backfill completed.");
  process.exit(0);
}

client.once("ready", async () => {
  console.log(`[Backfill] Logged in as ${client.user.tag}`);
  await backfillGuildMessages();
});

client.login(process.env.DISCORD_TOKEN);
