import crypto from "crypto";

/*
Creates a simplified voice embedding from audio buffer.
In production this should be replaced with a real ML model.
*/

export function generateVoiceEmbedding(audioBuffer) {

    const hash = crypto.createHash("sha256").update(audioBuffer).digest();

    const embedding = [];

    for (let i = 0; i < hash.length; i++) {
        embedding.push(hash[i] / 255);
    }

    return embedding;
}
