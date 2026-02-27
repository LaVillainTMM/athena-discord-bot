import gtts from "node-gtts";
import { createWriteStream, unlink } from "fs";
import { AttachmentBuilder } from "discord.js";

/* ── Split text at sentence boundaries for the 190-char TTS limit ── */
function splitForTTS(text, maxLen = 180) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
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
  return chunks.length ? chunks : [text.substring(0, maxLen)];
}

/* ── Generate a single MP3 file from text (handles chunking internally) ──
   Concatenates MP3 byte streams from multiple TTS requests into one file.
   MP3 frames are independently decodable so appending works correctly. */
function generateAudioFile(text, filepath) {
  return new Promise((resolve, reject) => {
    const chunks = splitForTTS(text);
    const fileStream = createWriteStream(filepath);
    let index = 0;

    const writeNext = () => {
      if (index >= chunks.length) {
        fileStream.end();
        return;
      }
      const chunk = chunks[index++];
      const tts = new gtts("en");
      const ttsStream = tts.stream(chunk);

      ttsStream.on("error", err => {
        fileStream.destroy();
        reject(err);
      });

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
  unlink(filepath, () => {});
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
     true on success, false on failure
────────────────────────────────────────────────────── */
export async function sendAudioMessage(channel, text, label = "athena_voice") {
  /* Cap at ~2000 chars per audio file — longer content should be chunked by caller */
  const audioText = text.substring(0, 2000).trim();
  if (!audioText) return false;

  const safeName = label.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_") || "athena_voice";
  const filepath = `/tmp/${safeName}_${Date.now()}.mp3`;

  try {
    await generateAudioFile(audioText, filepath);

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
    return true;
  } catch (err) {
    console.error("[AudioMessage] Failed to generate/send audio:", err.message);
    cleanup(filepath);
    return false;
  }
}

/* ──────────────────────────────────────────────────────
   IS AUDIO REQUEST
   Returns true if the message is asking for a voice/audio
   response — used to decide whether to attach an MP3.
────────────────────────────────────────────────────── */
export function isAudioRequest(content) {
  return /\b(voice\s*message|voice\s*memo|read\s*(me|it|aloud|out\s*loud|this)|send\s*(me\s*)?(an?\s*)?(audio|voice|mp3)|audio\s*(version|of|message|clip)|narrate|speak\s*(it|this|me|to\s*me|out)|listen\s*to|as\s*audio|in\s*audio)\b/i
    .test(content);
}

/* ──────────────────────────────────────────────────────
   SPLIT LONG RESPONSE FOR MULTI-PART AUDIO
   For very long responses (e.g. multiple laws), splits
   the text into parts of up to `maxLen` chars each so
   they can be sent as separate audio files.
────────────────────────────────────────────────────── */
export function splitResponseForAudio(text, maxLen = 1800) {
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
