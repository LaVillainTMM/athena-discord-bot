/* ──────────────────────────────────────────────────────────────────────────
   weather.js — Live weather data via OpenWeatherMap
   Provides current conditions when users ask about weather. Free tier API key
   from https://openweathermap.org/api (1,000 calls/day).
   ────────────────────────────────────────────────────────────────────────── */

const API_KEY  = process.env.OPENWEATHER_API_KEY;
const GEO_URL  = "https://api.openweathermap.org/geo/1.0/direct";
const ONECALL  = "https://api.openweathermap.org/data/2.5/weather";

/* ── Detect if a message is asking about weather ────────────────────────── */
const WEATHER_PATTERNS = [
  /\bweather\b/i,
  /\b(temperature|temp)\b.*\b(in|at|for)\b/i,
  /\bhow (hot|cold|warm)\b/i,
  /\bis it (raining|snowing|sunny|cloudy)\b/i,
  /\bforecast\b/i,
  /\bhumidity\b/i,
  /\b(rain|snow) (today|tomorrow|now)\b/i,
];

export function isWeatherQuery(text) {
  if (!text) return false;
  return WEATHER_PATTERNS.some(p => p.test(text));
}

/* ── Pull a location string out of a weather question ────────────────────
   Examples it handles:
     "what's the weather in Orlando Florida"      → "Orlando Florida"
     "weather report for New York"                → "New York"
     "is it raining in london right now"          → "london"
     "current temperature at Miami Beach"         → "Miami Beach"
   Returns null if no location is found. */
export function extractLocation(text) {
  if (!text) return null;

  const patterns = [
    /weather\s+(?:report\s+|forecast\s+)?(?:in|for|at|of|near|around)\s+([a-zA-Z][a-zA-Z\s.,'-]{1,60})/i,
    /(?:temperature|temp|humidity|forecast|conditions)\s+(?:in|for|at|of|near|around)\s+([a-zA-Z][a-zA-Z\s.,'-]{1,60})/i,
    /(?:raining|snowing|sunny|cloudy|hot|cold|warm)\s+in\s+([a-zA-Z][a-zA-Z\s.,'-]{1,60})/i,
    /how(?:'s| is)\s+(?:the\s+)?weather\s+(?:in|at|for)\s+([a-zA-Z][a-zA-Z\s.,'-]{1,60})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      /* Trim trailing punctuation, "right now", "today", question marks */
      return m[1]
        .replace(/[?!.]+$/, "")
        .replace(/\s+(right now|today|tonight|tomorrow|currently|please)\s*$/i, "")
        .trim();
    }
  }
  return null;
}

/* ── Geocode a location name to coordinates ─────────────────────────────── */
async function geocode(location) {
  const url = `${GEO_URL}?q=${encodeURIComponent(location)}&limit=1&appid=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Could not find location: ${location}`);
  }
  const { lat, lon, name, state, country } = data[0];
  const fullName = [name, state, country].filter(Boolean).join(", ");
  return { lat, lon, fullName };
}

/* ── Fetch current weather for a location ───────────────────────────────── */
export async function fetchWeather(location) {
  if (!API_KEY) {
    throw new Error("OPENWEATHER_API_KEY not configured");
  }
  if (!location || !location.trim()) {
    throw new Error("No location provided");
  }

  const { lat, lon, fullName } = await geocode(location.trim());
  const url = `${ONECALL}?lat=${lat}&lon=${lon}&units=imperial&appid=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather lookup failed: ${res.status}`);
  const w = await res.json();

  return {
    location:    fullName,
    description: w.weather?.[0]?.description ?? "unknown",
    main:        w.weather?.[0]?.main ?? "unknown",
    tempF:       Math.round(w.main?.temp ?? 0),
    feelsLikeF:  Math.round(w.main?.feels_like ?? 0),
    tempC:       Math.round(((w.main?.temp ?? 0) - 32) * (5 / 9)),
    humidity:    w.main?.humidity ?? 0,
    windMph:     Math.round(w.wind?.speed ?? 0),
    windDir:     degToCompass(w.wind?.deg ?? 0),
    cloudCover:  w.clouds?.all ?? 0,
    visibility:  w.visibility ? Math.round(w.visibility / 1609.34) : null, /* miles */
    sunrise:     w.sys?.sunrise ? new Date(w.sys.sunrise * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : null,
    sunset:      w.sys?.sunset  ? new Date(w.sys.sunset  * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : null,
    timestamp:   new Date().toISOString(),
  };
}

function degToCompass(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

/* ── Format a weather object into a context block for Athena ────────────── */
export function formatWeatherContext(w) {
  const parts = [
    `Location: ${w.location}`,
    `Conditions: ${w.description} (${w.main})`,
    `Temperature: ${w.tempF}°F (${w.tempC}°C), feels like ${w.feelsLikeF}°F`,
    `Humidity: ${w.humidity}%`,
    `Wind: ${w.windMph} mph from the ${w.windDir}`,
    `Cloud cover: ${w.cloudCover}%`,
  ];
  if (w.visibility !== null) parts.push(`Visibility: ${w.visibility} mi`);
  if (w.sunrise) parts.push(`Sunrise: ${w.sunrise}`);
  if (w.sunset)  parts.push(`Sunset: ${w.sunset}`);
  return `[LIVE WEATHER DATA — fetched just now]\n${parts.join("\n")}\n[END LIVE WEATHER DATA]\n\n`;
}
