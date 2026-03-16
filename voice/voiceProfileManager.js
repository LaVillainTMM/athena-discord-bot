// File: voice/voiceProfileManager.js
import { firestore } from "../firebase.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function getOrCreateVoiceProfile(userId) {
  const db = firestore;
  const docRef = db.collection("voice_profiles").doc(userId);
  const doc = await docRef.get();
  if (!doc.exists) {
    await docRef.set({ userId });
  }
  return docRef;
}
