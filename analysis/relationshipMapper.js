import { firestore } from "../firebase.js";

const db = firestore;

export async function mapRelationships(channelId = null, username = null) {

  let query = db.collection("messages");

  if (channelId) {
    query = query.where("channelId", "==", channelId);
  }

  query = query.orderBy("timestamp", "desc").limit(100);

  const snapshot = await query.get();

  const relationships = {};

  snapshot.forEach(doc => {
    const data = doc.data();
    if (!data) return;

    const user = data.userId || data.authorId;
    const channel = data.channelId;

    if (!user || !channel) return;

    if (!relationships[user]) {
      relationships[user] = new Set();
    }

    relationships[user].add(channel);
  });

  const result = {};

  for (const user in relationships) {
    result[user] = Array.from(relationships[user]);
  }

  return result;
}
