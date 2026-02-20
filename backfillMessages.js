// backfillMessages.js
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { firestore, admin } from "./firebase.js";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// optional: backfill only messages after this date (ISO string)
const BACKFILL_FROM = process.env.BACKFILL_FROM || null;

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

          batch.push({
            user_id: msg.author.id,
            username: msg.author.username,
            content: msg.content,
            guild_id: guild.id,
            guild_name: guild.name,
            channel_id: channel.id,
            channel_name: channel.name,
            timestamp: msg.createdAt,
            fetchedAtUTC: new Date(),
            platform: "discord",
          });
        }

        while (batch.length > 0) {
          const slice = batch.splice(0, 500);
          const batchWrite = firestore.batch();
          slice.forEach(doc => {
            const ref = firestore.collection("messages").doc();
            batchWrite.set(ref, doc);
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
