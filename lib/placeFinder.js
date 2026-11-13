/* ──────────────────────────────────────────────────────
   PLACE FINDER

   Given a city / area + (optional) interests, recommend
   places worth visiting — bars, cafés, parks, meetup spots,
   gyms, music venues, etc. Returns name, address, vibe, why
   it fits, and a Google Maps directions URL the user can tap.

   Powered by Gemini + Google Search grounding so results are
   live and pulled from real reviews / outlet roundups instead
   of hard-coded lists. Source policy is permissive here — the
   user wants real-world recommendations, so well-known review
   sites (Yelp, TripAdvisor, Google Reviews summaries, Eater,
   Time Out, local press) are allowed in addition to the usual
   accredited list.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

let placeModel = null;
function getPlaceModel() {
  if (placeModel) return placeModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      placeModel = genAI.getGenerativeModel({
        model: name,
        tools: [{ googleSearch: {} }],
        systemInstruction:
          "You are Athena's local-recommendations engine. Use Google Search to find " +
          "real, currently-open, well-reviewed places. Prefer spots with consistent 4+ " +
          "star ratings and active recent reviews. Return ONLY valid JSON in the schema " +
          "asked for — no prose, no markdown fences.",
      });
      console.log(`[PlaceFinder] Using model: ${name}`);
      return placeModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[PlaceFinder] No model available");
}

function mapsUrl(name, address) {
  const q = encodeURIComponent(`${name}, ${address || ""}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function directionsUrl(address) {
  const q = encodeURIComponent(address || "");
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

/* Build the prompt — city + optional interests + (optional) starting address. */
function buildPrompt(city, interests, count) {
  const interestsLine = interests && interests.length
    ? `User interests: ${interests.join(", ")}.\n`
    : "User interests: general — coffee, food, outdoors, social meetup spots, music, nightlife.\n";
  return (
    `Recommend ${count} real, well-reviewed places to hang out, meet people, and ` +
    `make friends in: "${city}".\n\n` +
    interestsLine +
    `Mix categories so the user has variety (a coffee shop or two, a park, a music ` +
    `venue or bar, a recurring meetup / community spot, a casual restaurant, etc.). ` +
    `Prefer spots with strong recent reviews and active regular crowds.\n\n` +
    `Return JSON ONLY (no markdown fences):\n` +
    `{\n` +
    `  "places": [\n` +
    `    {\n` +
    `      "name":     "Place name",\n` +
    `      "category": "coffee shop | bar | park | venue | gym | meetup | restaurant | other",\n` +
    `      "address":  "Full street address with city + state",\n` +
    `      "rating":   "e.g. 4.6 (Google) or 4.5 (Yelp)",\n` +
    `      "vibe":     "1 sentence describing the crowd / energy",\n` +
    `      "why":      "1 sentence on why it fits the user's interests and is good for meeting people"\n` +
    `    }\n` +
    `  ]\n` +
    `}`
  );
}

export async function findPlaces({ city, interests = [], count = 6 }) {
  if (!city || !city.trim()) throw new Error("city is required");
  const model = getPlaceModel();
  const result = await model.generateContent(buildPrompt(city.trim(), interests, count));
  const raw = result.response.text().trim();
  const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`PlaceFinder: model returned invalid JSON — ${err.message}`);
  }
  const places = Array.isArray(parsed?.places) ? parsed.places : [];
  /* Add maps + directions URLs the user can tap. */
  return places
    .filter(p => p && p.name && p.address)
    .map(p => ({
      ...p,
      mapsUrl:       mapsUrl(p.name, p.address),
      directionsUrl: directionsUrl(p.address),
    }));
}

/* Format a result list for a Discord message (nicely, under 2000 chars). */
export function formatPlacesForDiscord(city, places) {
  if (!places.length) {
    return `I couldn't find solid recommendations for **${city}** right now — try again with a more specific neighborhood or different interests.`;
  }
  const header = `**Places to check out in ${city}** — picked for solid reviews and friendly crowds:\n`;
  const blocks = places.map((p, i) => {
    const lines = [
      `**${i + 1}. ${p.name}** *(${p.category}${p.rating ? ` · ${p.rating}` : ""})*`,
      `${p.address}`,
      `${p.vibe}`,
      `Why: ${p.why}`,
      `[Open in Maps](${p.mapsUrl}) · [Directions](${p.directionsUrl})`,
    ];
    return lines.join("\n");
  });
  let out = header + "\n" + blocks.join("\n\n");
  if (out.length > 1900) {
    /* Discord cap — trim entries from the end until we fit. */
    while (out.length > 1900 && blocks.length > 1) {
      blocks.pop();
      out = header + "\n" + blocks.join("\n\n") + `\n\n_(showing top ${blocks.length})_`;
    }
  }
  return out;
}

/* Natural-language detector — fires on messages like:
     "I just moved to Austin, what should I check out?"
     "find me places in Brooklyn"
     "where can I hang out in Denver?"
     "looking to make friends in Seattle"
   Returns { city, interests } or null. */
const PLACE_TRIGGER_RX = [
  /\b(?:just moved|moving|new in town|new to)\s+(?:to\s+)?([A-Z][a-zA-Z .'-]{2,40}?)(?:[,.?!]|\s*$)/,
  /\bfind (?:me )?(?:places|spots|things to do|stuff to do|hangouts?)\s+(?:in|near|around)\s+([A-Z][a-zA-Z .'-]{2,40}?)(?:[,.?!]|\s*$)/i,
  /\bwhere (?:can|should) (?:i|we) (?:go|hang|hangout|meet|chill|eat|drink)\s+(?:in|near|around)\s+([A-Z][a-zA-Z .'-]{2,40}?)(?:[,.?!]|\s*$)/i,
  /\b(?:make|making|find) (?:new )?friends\s+(?:in|near|around)\s+([A-Z][a-zA-Z .'-]{2,40}?)(?:[,.?!]|\s*$)/i,
  /\bplaces to (?:hang|hangout|chill|meet|visit|go)\s+(?:in|near|around)\s+([A-Z][a-zA-Z .'-]{2,40}?)(?:[,.?!]|\s*$)/i,
];

const INTEREST_KEYWORDS = {
  coffee: ["coffee", "café", "cafe", "espresso", "matcha"],
  food: ["food", "restaurant", "eat", "dining", "brunch", "lunch", "dinner"],
  bar: ["bar", "drinks", "cocktail", "happy hour", "beer", "brewery"],
  outdoors: ["outdoors", "hiking", "park", "nature", "trail", "outside"],
  music: ["music", "concert", "venue", "live music", "show", "dj"],
  nightlife: ["nightlife", "club", "dancing", "late night"],
  fitness: ["gym", "workout", "fitness", "yoga", "climbing"],
  art: ["art", "gallery", "museum", "creative"],
  geek: ["board games", "gaming", "tabletop", "comic", "anime"],
};

function detectInterests(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const [tag, kws] of Object.entries(INTEREST_KEYWORDS)) {
    if (kws.some(k => lower.includes(k))) found.push(tag);
  }
  return found;
}

export function detectPlaceRequest(text) {
  if (!text) return null;
  for (const rx of PLACE_TRIGGER_RX) {
    const m = text.match(rx);
    if (m && m[1]) {
      const city = m[1].trim().replace(/[.,!?]+$/, "");
      if (city.length < 3) continue;
      return { city, interests: detectInterests(text) };
    }
  }
  return null;
}
