/* ──────────────────────────────────────────────────────
   REGIONAL DEEP PROFILE

   For every state / continent in the regional roster, pull a
   structured living profile covering:
     - WEATHER     (current snapshot via OpenWeatherMap, climate via Gemini)
     - POPULATION  (latest census estimate)
     - BUSINESSES  (count + dominant sectors)
     - CRIME       (latest UCR / FBI / state DOJ rates)
     - CONSTRUCTION (active major projects + canceled / paused projects)
     - LANDSCAPE   (recent geographic / infrastructure changes)

   Sources are gathered through Gemini's grounded Google Search
   (Wikipedia banned, accredited sources only — same allow-list
   as deepResearch.js). Weather snapshot is fetched directly from
   OpenWeatherMap when an API key is available.

   Each section becomes a separate athena_knowledge entry tagged
   with `regionalProfileSection` so dedupe works on weekly re-runs.
────────────────────────────────────────────────────── */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "../firebase.js";
import { fetchWeather } from "./weather.js";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

/* ── Source policy (shared with deepResearch.js) ── */
const SOURCE_BLOCK_RX = /wikipedia\.org/i;

function isSourceAllowed(url) {
  if (!url) return true;
  if (SOURCE_BLOCK_RX.test(url)) return false;
  return true;
}

/* ── Grounded research model with same fallback chain as deepResearch ── */
let profileModel = null;
function getProfileModel() {
  if (profileModel) return profileModel;
  const candidates = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
  for (const name of candidates) {
    try {
      profileModel = genAI.getGenerativeModel({
        model: name,
        tools: [{ googleSearch: {} }],
        systemInstruction:
          "You are Athena's regional intelligence engine. Cite ONLY accredited sources " +
          "(.gov, .edu, .mil, .ac.<cc>, Britannica, Reuters, AP, BBC, NPR, NYT, Washington " +
          "Post, WSJ, Bloomberg, Guardian, FT, Economist, PBS, CNN, U.S. Census, FBI UCR, " +
          "BEA, BLS, state DOTs). NEVER cite Wikipedia. If a number can't be sourced, omit it.",
      });
      console.log(`[RegionalDeepProfile] Using model: ${name}`);
      return profileModel;
    } catch (_) { /* try next */ }
  }
  throw new Error("[RegionalDeepProfile] No model available");
}

/* ── State capitals (for live weather snapshot) ── */
const STATE_CAPITALS = {
  Alabama: "Montgomery", Alaska: "Juneau", Arizona: "Phoenix", Arkansas: "Little Rock",
  California: "Sacramento", Colorado: "Denver", Connecticut: "Hartford", Delaware: "Dover",
  Florida: "Tallahassee", Georgia: "Atlanta", Hawaii: "Honolulu", Idaho: "Boise",
  Illinois: "Springfield", Indiana: "Indianapolis", Iowa: "Des Moines", Kansas: "Topeka",
  Kentucky: "Frankfort", Louisiana: "Baton Rouge", Maine: "Augusta", Maryland: "Annapolis",
  Massachusetts: "Boston", Michigan: "Lansing", Minnesota: "Saint Paul", Mississippi: "Jackson",
  Missouri: "Jefferson City", Montana: "Helena", Nebraska: "Lincoln", Nevada: "Carson City",
  "New Hampshire": "Concord", "New Jersey": "Trenton", "New Mexico": "Santa Fe",
  "New York": "Albany", "North Carolina": "Raleigh", "North Dakota": "Bismarck",
  Ohio: "Columbus", Oklahoma: "Oklahoma City", Oregon: "Salem", Pennsylvania: "Harrisburg",
  "Rhode Island": "Providence", "South Carolina": "Columbia", "South Dakota": "Pierre",
  Tennessee: "Nashville", Texas: "Austin", Utah: "Salt Lake City", Vermont: "Montpelier",
  Virginia: "Richmond", Washington: "Olympia", "West Virginia": "Charleston",
  Wisconsin: "Madison", Wyoming: "Cheyenne",
};

/* ── Live weather snapshot for the region's capital (or a representative city for continents) ── */
const CONTINENT_REPRESENTATIVE_CITY = {
  Africa: "Nairobi", Antarctica: "McMurdo Station", Asia: "Tokyo", Europe: "Brussels",
  "North America": "Mexico City", Oceania: "Sydney", "South America": "São Paulo",
};

async function fetchRegionWeather(region) {
  if (!process.env.OPENWEATHER_API_KEY) return null;
  const city = STATE_CAPITALS[region.name] || CONTINENT_REPRESENTATIVE_CITY[region.name];
  if (!city) return null;
  try {
    const w = await fetchWeather(`${city}, ${region.name}`);
    return {
      city,
      summary:
        `Capital city: ${city}\n` +
        `Conditions: ${w.description} (${w.main})\n` +
        `Temperature: ${w.tempF}°F (${w.tempC}°C), feels like ${w.feelsLikeF}°F\n` +
        `Humidity: ${w.humidity}%, Wind: ${w.windMph} mph ${w.windDir}, Cloud cover: ${w.cloudCover}%\n` +
        `Snapshot taken: ${new Date().toISOString()}`,
    };
  } catch (err) {
    console.warn(`[RegionalDeepProfile] weather fetch failed for ${region.name}: ${err.message}`);
    return null;
  }
}

/* ── Structured profile prompt ── */
function buildProfilePrompt(regionName) {
  return (
    `Build a structured living profile for: "${regionName}"\n\n` +
    `Return ONE valid JSON object (no markdown fences, no prose). Schema:\n` +
    `{\n` +
    `  "population":   { "value": "latest estimate with year", "source": "U.S. Census / outlet name or URL" },\n` +
    `  "businesses":   { "value": "approximate count of registered businesses + 3-5 dominant sectors", "source": "..." },\n` +
    `  "crime":        { "value": "most recent overall crime rate per 100k + violent vs property breakdown if known", "source": "FBI UCR / state DOJ / BJS" },\n` +
    `  "construction": { "active": ["3-6 major active infrastructure or development projects with year"], "canceled": ["2-4 notable canceled or paused projects with year"], "source": "state DOT / DOJ / news" },\n` +
    `  "landscape":    { "value": "2-3 sentences on recent geographic / infrastructure / industrial changes", "source": "..." },\n` +
    `  "climate":      { "value": "1-2 sentence climate overview (typical temperature ranges, dominant weather patterns, hazards)", "source": "NOAA / NWS / Britannica" }\n` +
    `}\n\n` +
    `HARD RULES:\n` +
    `- ONLY accredited sources: .gov, .edu, .mil, .ac.<cc>, Britannica, Reuters, AP, BBC, NPR, NYT, ` +
    `Washington Post, WSJ, Bloomberg, Guardian, FT, Economist, PBS, CNN, U.S. Census, FBI UCR, BEA, BLS.\n` +
    `- NEVER use Wikipedia.\n` +
    `- If you cannot source a field, set its "value" (or "active"/"canceled") to "unknown" and omit "source".\n` +
    `- Be specific. Use real numbers and named projects, not generalities.`
  );
}

async function fetchProfileSections(regionName) {
  const model = getProfileModel();
  try {
    const result = await model.generateContent(buildProfilePrompt(regionName));
    const raw = result.response.text().trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.warn(`[RegionalDeepProfile] ${regionName} profile fetch failed: ${err.message}`);
    return null;
  }
}

/* Tag every entry stored by this module with the section so the
   dedupe + dashboard queries can find them. */
async function tagEntry(title, region, section) {
  try {
    const found = await firestore.collection("athena_knowledge")
      .where("title", "==", title).limit(1).get();
    if (!found.empty) {
      await found.docs[0].ref.update({
        regionalProfileSection: section,
        regionalProfileRegion:  region.name.toLowerCase(),
        regionalProfileUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (_) { /* best-effort */ }
}

/* ── Build all the per-region knowledge entries ── */
async function buildEntries(region, profile, weather) {
  const entries = [];
  const tag = (section, title, body, source) => {
    entries.push({ section, title, body, source: source || "athena_regional_profile" });
  };

  if (weather?.summary) {
    tag(
      "weather",
      `${region.name} (${region.category}) — Live Weather Snapshot (${weather.city})`,
      `Live weather snapshot for ${weather.city}, ${region.name}.\n\n${weather.summary}`,
      "OpenWeatherMap"
    );
  }

  if (profile?.climate?.value && profile.climate.value !== "unknown") {
    tag(
      "climate",
      `${region.name} (${region.category}) — Climate Overview`,
      `Climate overview.\n\n${profile.climate.value}`,
      profile.climate.source
    );
  }

  if (profile?.population?.value && profile.population.value !== "unknown") {
    tag(
      "population",
      `${region.name} (${region.category}) — Population`,
      `Population estimate.\n\n${profile.population.value}`,
      profile.population.source
    );
  }

  if (profile?.businesses?.value && profile.businesses.value !== "unknown") {
    tag(
      "businesses",
      `${region.name} (${region.category}) — Businesses & Industry`,
      `Business landscape.\n\n${profile.businesses.value}`,
      profile.businesses.source
    );
  }

  if (profile?.crime?.value && profile.crime.value !== "unknown") {
    tag(
      "crime",
      `${region.name} (${region.category}) — Crime Statistics`,
      `Crime statistics (most recent reported year).\n\n${profile.crime.value}`,
      profile.crime.source
    );
  }

  const c = profile?.construction;
  if (c && (c.active?.length || c.canceled?.length)) {
    const parts = [];
    if (c.active?.length)   parts.push(`ACTIVE / SUCCESSFUL PROJECTS:\n- ${c.active.join("\n- ")}`);
    if (c.canceled?.length) parts.push(`CANCELED / PAUSED PROJECTS:\n- ${c.canceled.join("\n- ")}`);
    tag(
      "construction",
      `${region.name} (${region.category}) — Construction & Infrastructure`,
      parts.join("\n\n"),
      c.source
    );
  }

  if (profile?.landscape?.value && profile.landscape.value !== "unknown") {
    tag(
      "landscape",
      `${region.name} (${region.category}) — Landscape & Infrastructure Changes`,
      `Recent landscape / infrastructure changes.\n\n${profile.landscape.value}`,
      profile.landscape.source
    );
  }

  return entries.filter(e => isSourceAllowed(e.source));
}

/* ── Run a deep profile for ONE region ── */
export async function profileRegion(region) {
  const { storeNewKnowledge } = await import("./knowledgeUpdater.js");
  console.log(`[RegionalDeepProfile] Profiling ${region.name}...`);

  const [weather, profile] = await Promise.all([
    fetchRegionWeather(region),
    fetchProfileSections(region.name),
  ]);

  const entries = await buildEntries(region, profile, weather);
  if (!entries.length) {
    console.warn(`[RegionalDeepProfile] ${region.name}: no entries produced`);
    return 0;
  }

  let stored = 0;
  for (const e of entries) {
    const ok = await storeNewKnowledge({
      title:       e.title,
      body:        e.body,
      source:      e.source,
      verified:    true,
      explanation: `Regional deep profile (${e.section}) for ${region.name}`,
    });
    if (ok) {
      stored++;
      await tagEntry(e.title, region, e.section);
    }
  }
  console.log(`[RegionalDeepProfile] ${region.name}: stored ${stored}/${entries.length} sections`);
  return stored;
}

/* ── Sweep every region (slow, polite, runs in background) ── */
export async function runDeepProfileSweep(regions) {
  const start = Date.now();
  let stored = 0;
  console.log(`[RegionalDeepProfile] Sweep starting for ${regions.length} regions (this takes a while)...`);
  for (const region of regions) {
    try {
      stored += await profileRegion(region);
    } catch (err) {
      console.warn(`[RegionalDeepProfile] ${region.name}: ${err.message}`);
    }
    /* Pace ourselves — 5s between regions to be gentle on Gemini quota and OWM. */
    await new Promise(r => setTimeout(r, 5000));
  }
  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(`[RegionalDeepProfile] Sweep complete in ${seconds}s — stored ${stored} entries.`);
  return stored;
}
