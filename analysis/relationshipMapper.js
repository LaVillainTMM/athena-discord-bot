// File: analysis/relationshipMapper.js
import { firestore } from "../firebase.js";

export async function mapRelationships() {

    const db = firestore;

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
