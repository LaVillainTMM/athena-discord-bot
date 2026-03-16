// File: analysis/relationshipMapper.js
import { firestore } from "../firebase.js";

export async function mapRelationships(channelId, username) {
  const db = firestore;
  const snapshot = await db.collection("messages")
      .where("channelId", "==", channelId)
      .orderBy("timestamp", "desc")
      .limit(100)
      .get();
  
export async function mapRelationships() {

    const snapshot = await db.collection("messages").get();

    const relationships = {};

    snapshot.forEach(doc => {

        const data = doc.data();

        const user = data.userId;
        const channel = data.channelId;

        if (!relationships[user]) {
            relationships[user] = new Set();
        }

        relationships[user].add(channel);

    });

    return relationships;

}
