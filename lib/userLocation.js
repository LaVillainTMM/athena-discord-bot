/* ──────────────────────────────────────────────────────
   USER LOCATION

   Resolves a Discord user's physical location by combining:
     1. LIVE mobile GPS — if the user has linked the Athena
        mobile app, it writes coordinates to Firestore at
        athena_ai/users/humans/{athenaUserId}/profile/core
        under field `location` (lat, lon, label, updatedAt).
     2. SAVED `!setlocation` — set once via Discord command,
        geocoded with OpenWeather, stored on the same doc.

   Resolution order: prefer mobile GPS if it's < 30 minutes
   old, otherwise fall back to the saved value. Always returns
   `null` if neither source has data.
────────────────────────────────────────────────────── */
import { admin, firestore } from "../firebase.js";

const MOBILE_FRESH_MS = 30 * 60 * 1000;
const GEO_URL = "https://api.openweathermap.org/geo/1.0/direct";

function profileRef(athenaUserId) {
  return firestore
    .collection("athena_ai").doc("users")
    .collection("humans").doc(athenaUserId)
    .collection("profile").doc("core");
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? 0 : d.getTime();
}

/* ── Geocode a free-text place ("Brooklyn NY", "10 Times Square") ── */
export async function geocodeLocation(text) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error("OPENWEATHER_API_KEY not configured");
  if (!text || !text.trim()) throw new Error("No location text provided");

  const url = `${GEO_URL}?q=${encodeURIComponent(text.trim())}&limit=1&appid=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocode failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No geocoding result for "${text}"`);
  }
  const { lat, lon, name, state, country } = data[0];
  return {
    lat,
    lon,
    label: [name, state, country].filter(Boolean).join(", "),
  };
}

/* ── Set saved location (from !setlocation command) ── */
export async function setUserLocation(athenaUserId, { lat, lon, label }) {
  await profileRef(athenaUserId).set({
    location: {
      lat,
      lon,
      label,
      source: "saved",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });
  return { lat, lon, label, source: "saved" };
}

/* ── Resolve a user's current location ──
   Reads both `location` (saved) and `mobileLocation` (live GPS pushed by
   the mobile app). Prefers mobile if < 30 min old, otherwise saved.
   Returns null if neither exists. */
export async function getUserLocation(athenaUserId) {
  const snap = await profileRef(athenaUserId).get().catch(() => null);
  if (!snap || !snap.exists) return null;
  const data = snap.data() || {};

  const saved = data.location || null;
  const mobile = data.mobileLocation || null;

  const mobileFresh = mobile && mobile.lat != null && mobile.lon != null &&
    (Date.now() - tsToMs(mobile.updatedAt)) < MOBILE_FRESH_MS;

  if (mobileFresh) {
    return {
      lat: mobile.lat,
      lon: mobile.lon,
      label: mobile.label || `${mobile.lat.toFixed(3)}, ${mobile.lon.toFixed(3)}`,
      source: "mobile",
      updatedAt: tsToMs(mobile.updatedAt),
    };
  }
  if (saved && saved.lat != null && saved.lon != null) {
    return {
      lat: saved.lat,
      lon: saved.lon,
      label: saved.label || `${saved.lat.toFixed(3)}, ${saved.lon.toFixed(3)}`,
      source: "saved",
      updatedAt: tsToMs(saved.updatedAt),
    };
  }
  return null;
}

/* ── Format a location + timestamp block for Athena's context ── */
export function formatLocationContext({ location, sentAtMs, username }) {
  if (!location) {
    return `[USER CONTEXT]\nMessage from ${username || "user"} sent at ${new Date(sentAtMs).toUTCString()}.\nLocation: unknown — user has not shared one. If they ask about nearby things, suggest \`!setlocation <city>\`.\n[END USER CONTEXT]\n\n`;
  }
  const ageMin = Math.round((Date.now() - location.updatedAt) / 60000);
  const ageHint = location.source === "mobile"
    ? `live mobile GPS, updated ${ageMin} min ago`
    : `saved value, set ${ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`} ago`;
  return (
    `[USER CONTEXT]\n` +
    `Message from ${username || "user"} sent at ${new Date(sentAtMs).toUTCString()}.\n` +
    `Current location: ${location.label} (${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}) — ${ageHint}.\n` +
    `Maps: https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}\n` +
    `When relevant, openly reference the time and location in your reply.\n` +
    `[END USER CONTEXT]\n\n`
  );
}
