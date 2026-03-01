import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} from "@discordjs/voice";

import fs from "fs";
import fetch from "node-fetch";

const player = createAudioPlayer();

export async function speak(connection, text) {

  try {

    // Gemini TTS placeholder (replace later with Azure voice)
    const response = await fetch(
      "https://api.streamelements.com/kappa/v2/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice: "Brian",
          text
        })
      }
    );

    const buffer = await response.arrayBuffer();
    fs.writeFileSync("voice.mp3", Buffer.from(buffer));

    const resource = createAudioResource("voice.mp3");

    connection.subscribe(player);
    player.play(resource);

    player.once(AudioPlayerStatus.Idle, () => {
      fs.unlinkSync("voice.mp3");
    });

  } catch (err) {
    console.error("Speak error:", err);
  }
}
