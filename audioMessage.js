import { writeFile, unlink } from "fs/promises";
import { AttachmentBuilder } from "discord.js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/* ── ElevenLabs voice config ── */
const ELEVENLABS_VOICE_ID = "z1rEShu1SmowIOAmbHl1"; /* Lily — British female, velvety actress */
const ELEVENLABS_MODEL = "eleven_multilingual_v2";

/* ── Voice settings — natural, human-like pacing with UK character ── */
const VOICE_SETTINGS = {
  stability: 0.42,
  similarityBoost: 0.80,
  style: 0.38,
  useSpeakerBoost: true,
};

/* ── Generate MP3 via ElevenLabs SDK ── */
async function generateWithElevenLabs(text, filepath) {
  const elevenlabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
  });

  const audioStream = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
    text,
    modelId: ELEVENLABS_MODEL,
    outputFormat: "mp3_44100_128",
    voiceSettings: VOICE_SETTINGS,
  });

  /* Collect the ReadableStream chunks into a Buffer and write to disk */
  const chunks = [];
  const reader = audioStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  await writeFile(filepath, Buffer.concat(chunks));
}

/* ── Fallback: node-gtts (used only if ElevenLabs key is not set) ── */
async function generateWithGtts(text, filepath) {
  const { default: gtts } = await import("node-gtts");
  const { createWriteStream } = await import("fs");

  function splitForTTS(t, maxLen = 180) {
    const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      const trimmed = s.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;
      if ((current + " " + trimmed).length > maxLen) {
        if (current) chunks.push(current.trim());
        current = trimmed.length > maxLen ? trimmed.substring(0, maxLen) : trimmed;
      } else {
        current = current ? current + " " + trimmed : trimmed;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [t.substring(0, maxLen)];
  }

  return new Promise((resolve, reject) => {
    const chunks = splitForTTS(text);
    const fileStream = createWriteStream(filepath);
    let index = 0;

    const writeNext = () => {
      if (index >= chunks.length) { fileStream.end(); return; }
      const chunk = chunks[index++];
      const tts = new gtts("en");
      const ttsStream = tts.stream(chunk);
      ttsStream.on("error", (err) => { fileStream.destroy(); reject(err); });
      ttsStream.on("end", writeNext);
      ttsStream.pipe(fileStream, { end: false });
    };

    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    writeNext();
  });
}

/* ── Clean up temp file silently ── */
function cleanup(filepath) {
  unlink(filepath).catch(() => {});
}

/* ──────────────────────────────────────────────────────
   SEND AUDIO MESSAGE
   Generates an MP3 of the given text and sends it as a
   Discord file attachment in the specified channel.

   Parameters:
     channel  — Discord.js channel or message to reply to
     text     — The text to convert to speech
     label    — Human-readable label for the filename
   Returns:
     { ok: true } on success, { ok: false, error: string } on failure
────────────────────────────────────────────────────── */
export async function sendAudioMessage(channel, text, label = "athena_voice") {
  const audioText = text.substring(0, 5000).trim();
  if (!audioText) return { ok: false, error: "Empty text" };

  const safeName =
    label.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_") || "athena_voice";
  const filepath = `/tmp/${safeName}_${Date.now()}.mp3`;

  try {
    if (process.env.ELEVENLABS_API_KEY) {
      console.log("[AudioMessage] Using ElevenLabs SDK (Lily)");
      try {
        await generateWithElevenLabs(audioText, filepath);
      } catch (elevenErr) {
        console.error("[AudioMessage] ElevenLabs failed:", elevenErr.message);
        cleanup(filepath);
        return { ok: false, error: `ElevenLabs error — ${elevenErr.message}` };
      }
    } else {
      console.warn("[AudioMessage] ELEVENLABS_API_KEY not set — using Google TTS (not Lily)");
      await generateWithGtts(audioText, filepath);
    }

    const attachment = new AttachmentBuilder(filepath, {
      name: `${safeName}.mp3`,
      description: `Athena voice message: ${label}`,
    });

    if (typeof channel.reply === "function") {
      await channel.reply({ files: [attachment] });
    } else {
      await channel.send({ files: [attachment] });
    }

    cleanup(filepath);
    return { ok: true };
  } catch (err) {
    console.error("[AudioMessage] Send failed:", err.message);
    cleanup(filepath);
    return { ok: false, error: err.message };
  }
}

/* ──────────────────────────────────────────────────────
   IS AUDIO REQUEST
   Returns true if the message is asking for a voice/audio
   response — used to decide whether to attach an MP3.
────────────────────────────────────────────────────── */
export function isAudioRequest(content) {
  const lower = content.toLowerCase();

  if (/\b(voice\s*message|voice\s*memo|send\s*(me\s*)?(an?\s*)?(audio|voice|mp3)|audio\s*(version|of|message|clip)|narrate|listen\s*to|as\s*audio|in\s*audio|recite|read\s*aloud|read\s*out\s*loud)\b/.test(lower)) return true;
  if (/\bread\s*(me|it|this)\b/.test(lower)) return true;
  if (/\bread\b.{0,60}\b(for|to)\s+me\b/.test(lower)) return true;
  if (/\bspeak\s*(it|this|out|to\s*me)\b/.test(lower)) return true;
  if (/\bread\s+(?:the|a|an)\s+\w/.test(lower)) return true;

  return false;
}

/* ──────────────────────────────────────────────────────
   SPLIT LONG RESPONSE FOR MULTI-PART AUDIO
   For very long responses, splits text into parts of up
   to `maxLen` chars each to be sent as separate files.
────────────────────────────────────────────────────── */
export function splitResponseForAudio(text, maxLen = 4500) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > maxLen) {
      if (current.trim()) parts.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text.substring(0, maxLen)];
}
