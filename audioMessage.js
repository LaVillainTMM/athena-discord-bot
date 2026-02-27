import { writeFile, unlink } from "fs/promises";
import { AttachmentBuilder } from "discord.js";

/* ── Azure TTS voice config ──
   en-GB-SoniaNeural  — natural RP British female (primary)
   en-GB-LibbyNeural  — younger, clearer RP female (alternative)
── */
const AZURE_VOICE        = "en-GB-SoniaNeural";
const AZURE_OUTPUT_FORMAT = "audio-24khz-160kbitrate-mono-mp3";

/* ── Escape text for SSML ── */
function escapeXml(text) {
  return text
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

/* ── Generate MP3 via Azure TTS REST API ── */
async function generateWithAzure(text, filepath) {
  const key    = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION || "eastus";

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-GB'>
  <voice name='${AZURE_VOICE}'>
    <prosody rate='-5%' pitch='+2%'>${escapeXml(text)}</prosody>
  </voice>
</speak>`;

  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type":              "application/ssml+xml",
        "X-Microsoft-OutputFormat":  AZURE_OUTPUT_FORMAT,
        "User-Agent":                "AthenaBot",
      },
      body: ssml,
    }
  );

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Azure TTS ${response.status}: ${err.substring(0, 200)}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(filepath, Buffer.from(buffer));
}

/* ── Fallback: node-gtts (used only if Azure keys are not configured) ── */
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
    if (process.env.AZURE_SPEECH_KEY) {
      console.log(`[AudioMessage] Using Azure TTS (${AZURE_VOICE})`);
      try {
        await generateWithAzure(audioText, filepath);
      } catch (azureErr) {
        console.error("[AudioMessage] Azure TTS failed:", azureErr.message);
        cleanup(filepath);
        return { ok: false, error: `Azure TTS error — ${azureErr.message}` };
      }
    } else {
      console.warn("[AudioMessage] AZURE_SPEECH_KEY not set — using Google TTS fallback");
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
