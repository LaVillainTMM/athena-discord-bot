import { GoogleGenerativeAI } from "@google/generative-ai";
import { firestore } from "./firebase.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const VISION_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash",
];

async function getVisionModel() {
  for (const m of VISION_MODELS) {
    try {
      return genAI.getGenerativeModel({ model: m });
    } catch (_) {}
  }
  return genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

/* ── Fetch image as base64 ── */
async function imageUrlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return {
    inlineData: {
      data: Buffer.from(buffer).toString("base64"),
      mimeType: res.headers.get("content-type") || "image/png",
    },
  };
}

/* ── Firebase collection helpers ── */
function memberFacesCol() {
  return firestore.collection("member_visual_profiles");
}

/* ──────────────────────────────────────────────────────
   STORE MEMBER VISUAL PROFILE
   Fetches the user's Discord avatar, uses Gemini Vision
   to describe their appearance, and stores the result in
   Firebase for future face identification.
────────────────────────────────────────────────────── */
export async function storeMemberVisualProfile(user) {
  try {
    const avatarUrl = user.displayAvatarURL
      ? user.displayAvatarURL({ size: 256, extension: "png" })
      : user.avatarURL?.({ size: 256 }) ?? null;

    if (!avatarUrl) return;

    const docRef = memberFacesCol().doc(user.id);
    const existing = await docRef.get();

    /* Only re-analyze if avatar changed */
    const storedAvatar = existing.exists ? existing.data()?.avatarUrl : null;
    if (storedAvatar === avatarUrl) return;

    const model = await getVisionModel();
    const imagePart = await imageUrlToBase64(avatarUrl);

    const result = await model.generateContent([
      imagePart,
      `Describe this person's visible physical appearance for the purpose of later identifying them in photos.
Focus on: face shape, skin tone, hair color/style/length, eye color if visible, distinguishing features (beard, glasses, piercings, etc.), approximate age range, and any unique characteristics.
Keep the description factual, objective, and under 200 words.
If this is not a photo of a real person (e.g., it is an anime avatar, cartoon, or logo), respond with ONLY: "NON_HUMAN_AVATAR"`,
    ]);

    const description = result.response.text().trim();

    if (description === "NON_HUMAN_AVATAR" || description.includes("NON_HUMAN")) {
      await docRef.set(
        {
          discordId: user.id,
          username: user.username,
          displayName: user.globalName || user.username,
          avatarUrl,
          hasRealPhoto: false,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      return;
    }

    await docRef.set(
      {
        discordId: user.id,
        username: user.username,
        displayName: user.globalName || user.username,
        avatarUrl,
        appearanceDescription: description,
        hasRealPhoto: true,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`[VisualID] Stored visual profile for ${user.username}`);
  } catch (err) {
    console.error(`[VisualID] storeMemberVisualProfile error for ${user?.username}:`, err.message);
  }
}

/* ──────────────────────────────────────────────────────
   IDENTIFY MEMBERS IN IMAGE
   Given a Discord image URL, uses Gemini Vision to detect
   people visible in the image and tries to match them
   against stored member visual profiles.

   Returns: Array of { discordId, username, confidence, description }
────────────────────────────────────────────────────── */
export async function identifyMembersInImage(imageUrl, guildId) {
  try {
    const model = await getVisionModel();
    const imagePart = await imageUrlToBase64(imageUrl);

    /* Step 1: Describe all people visible in the image */
    const describeResult = await model.generateContent([
      imagePart,
      `Describe all people visible in this image for identification purposes.
For each person, provide: face shape, skin tone, hair color/style, eye color if visible, distinguishing features (beard, glasses, etc.), approximate age range, clothing colors/style.
If there are no real people visible (anime characters, cartoons, etc.), respond with ONLY: "NO_REAL_PEOPLE"
Format: One paragraph per person, separated by "---"`,
    ]);

    const descriptionText = describeResult.response.text().trim();
    if (descriptionText === "NO_REAL_PEOPLE" || descriptionText.includes("NO_REAL_PEOPLE")) {
      return [];
    }

    const peopleDescriptions = descriptionText.split("---").map(d => d.trim()).filter(Boolean);
    if (peopleDescriptions.length === 0) return [];

    /* Step 2: Load stored member profiles that have real photos */
    const snapshot = await memberFacesCol()
      .where("hasRealPhoto", "==", true)
      .limit(50)
      .get();

    if (snapshot.empty) return [];

    const memberProfiles = [];
    snapshot.forEach(doc => memberProfiles.push(doc.data()));

    /* Step 3: For each person in the image, find the best match */
    const results = [];

    for (const personDesc of peopleDescriptions) {
      /* Build a matching prompt comparing this person against all stored profiles */
      const profileList = memberProfiles
        .map((p, i) => `[${i + 1}] ${p.username} (${p.displayName}): ${p.appearanceDescription}`)
        .join("\n\n");

      const matchResult = await model.generateContent(
        `You are identifying a person visible in a Discord image.

Person seen in image:
${personDesc}

Known DBI Nation Z Discord members:
${profileList}

Does this person match any of the members listed above? 
If yes, respond with ONLY valid JSON: {"matched": true, "memberIndex": <1-based index>, "confidence": "high|medium|low", "reason": "<brief reason>"}
If no match: {"matched": false}
Do not include markdown or explanation — just the JSON.`
      );

      const matchText = matchResult.response.text().trim();
      try {
        const match = JSON.parse(matchText.replace(/```json|```/g, "").trim());
        if (match.matched && match.memberIndex) {
          const profile = memberProfiles[match.memberIndex - 1];
          if (profile) {
            results.push({
              discordId: profile.discordId,
              username: profile.username,
              displayName: profile.displayName,
              confidence: match.confidence || "medium",
              reason: match.reason || "",
              personDescription: personDesc,
            });

            /* Store this sighting in Firebase */
            await memberFacesCol().doc(profile.discordId).collection("sightings").add({
              imageUrl,
              guildId: guildId || null,
              confidence: match.confidence || "medium",
              reason: match.reason || "",
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (_) {
        /* JSON parse failed — skip this match */
      }
    }

    return results;
  } catch (err) {
    console.error("[VisualID] identifyMembersInImage error:", err.message);
    return [];
  }
}

/* ──────────────────────────────────────────────────────
   GET VISUAL PROFILE
   Returns stored visual profile for a Discord user ID.
────────────────────────────────────────────────────── */
export async function getMemberVisualProfile(discordId) {
  try {
    const doc = await memberFacesCol().doc(discordId).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.error("[VisualID] getMemberVisualProfile error:", err.message);
    return null;
  }
}
