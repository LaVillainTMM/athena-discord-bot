/* ──────────────────────────────────────────────────────
   NEARBY PLACES

   Find points of interest around a lat/lon. Tries Google
   Places (Text Search New) first if GOOGLE_PLACES_API_KEY is
   set, otherwise falls back to OpenStreetMap Overpass — free,
   no key, accredited open data, worldwide coverage.

   Returns a normalized list:
     { name, type, address, lat, lon, distance_m, rating?, mapsUrl }
────────────────────────────────────────────────────── */

const EARTH_R = 6371000; /* meters */

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.sqrt(a)));
}

function mapsUrl(name, lat, lon) {
  const q = encodeURIComponent(`${name} @${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/* ── Map free-text query → OSM Overpass amenity/shop tags ── */
function queryToOverpass(query) {
  const q = (query || "").toLowerCase().trim();
  /* Generic catch-all when the user doesn't specify */
  if (!q || /\b(anything|things to do|fun|interesting|around|nearby)\b/.test(q)) {
    return [
      'node["amenity"~"restaurant|cafe|bar|pub|fast_food"]',
      'node["tourism"~"attraction|museum|gallery|viewpoint"]',
      'node["leisure"~"park|stadium"]',
    ];
  }
  const map = {
    coffee:      ['node["amenity"="cafe"]'],
    cafe:        ['node["amenity"="cafe"]'],
    food:        ['node["amenity"~"restaurant|fast_food|food_court"]'],
    restaurant:  ['node["amenity"="restaurant"]'],
    bar:         ['node["amenity"~"bar|pub"]'],
    drink:       ['node["amenity"~"bar|pub|nightclub"]'],
    nightclub:   ['node["amenity"="nightclub"]'],
    gas:         ['node["amenity"="fuel"]'],
    fuel:        ['node["amenity"="fuel"]'],
    grocery:     ['node["shop"~"supermarket|convenience"]'],
    supermarket: ['node["shop"="supermarket"]'],
    pharmacy:    ['node["amenity"="pharmacy"]'],
    hospital:    ['node["amenity"~"hospital|clinic"]'],
    bank:        ['node["amenity"~"bank|atm"]'],
    atm:         ['node["amenity"="atm"]'],
    hotel:       ['node["tourism"~"hotel|hostel|motel"]'],
    park:        ['node["leisure"="park"]'],
    gym:         ['node["leisure"="fitness_centre"]'],
    museum:      ['node["tourism"="museum"]'],
    gallery:     ['node["tourism"="gallery"]'],
    landmark:    ['node["tourism"~"attraction|viewpoint"]'],
    school:      ['node["amenity"~"school|university|college"]'],
    library:     ['node["amenity"="library"]'],
    parking:     ['node["amenity"="parking"]'],
    studio:      ['node["amenity"="studio"]', 'node["studio"]'],
    music:       ['node["amenity"~"nightclub|music_venue"]', 'node["studio"="audio"]'],
  };
  for (const key of Object.keys(map)) {
    if (q.includes(key)) return map[key];
  }
  /* Free-text fallback — search by name */
  return [`node["name"~"${q.replace(/"/g, '')}",i]`];
}

/* ── Google Places (New) Text Search ── */
async function googlePlaces({ lat, lon, query, radiusMeters, limit }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("no key");
  const body = {
    textQuery: query || "places",
    locationBias: {
      circle: { center: { latitude: lat, longitude: lon }, radius: radiusMeters },
    },
    maxResultCount: Math.min(limit, 20),
  };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.location,places.rating,places.primaryType,places.userRatingCount",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Places HTTP ${res.status}`);
  const data = await res.json();
  const places = (data.places || []).map(p => {
    const plat = p.location?.latitude;
    const plon = p.location?.longitude;
    return {
      name: p.displayName?.text || "Unnamed",
      type: p.primaryType || "place",
      address: p.formattedAddress || "",
      lat: plat,
      lon: plon,
      distance_m: (plat != null && plon != null) ? haversine(lat, lon, plat, plon) : null,
      rating: p.rating ? `${p.rating} (${p.userRatingCount || 0})` : null,
      mapsUrl: mapsUrl(p.displayName?.text || "", plat, plon),
      provider: "google",
    };
  });
  places.sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
  return places.slice(0, limit);
}

/* ── OSM Overpass fallback ── */
async function overpassPlaces({ lat, lon, query, radiusMeters, limit }) {
  const filters = queryToOverpass(query);
  const body = `[out:json][timeout:15];(${filters.map(f => `${f}(around:${radiusMeters},${lat},${lon});`).join("")});out body ${limit * 3};`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(body)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  const places = (data.elements || [])
    .filter(e => e.tags?.name && e.lat && e.lon)
    .map(e => {
      const t = e.tags;
      const type = t.amenity || t.shop || t.tourism || t.leisure || "place";
      const addressParts = [t["addr:housenumber"], t["addr:street"], t["addr:city"]].filter(Boolean);
      return {
        name: t.name,
        type,
        address: addressParts.join(" ") || (t["addr:full"] || ""),
        lat: e.lat,
        lon: e.lon,
        distance_m: haversine(lat, lon, e.lat, e.lon),
        rating: null,
        mapsUrl: mapsUrl(t.name, e.lat, e.lon),
        provider: "osm",
      };
    });
  places.sort((a, b) => a.distance_m - b.distance_m);
  /* dedupe by name+approx-location */
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.name.toLowerCase()}|${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Public: nearbyPlaces({lat, lon, query, radiusMeters?, limit?}) ── */
export async function nearbyPlaces({ lat, lon, query = "", radiusMeters = 2000, limit = 8 }) {
  if (lat == null || lon == null) throw new Error("nearbyPlaces requires lat/lon");
  const args = { lat, lon, query, radiusMeters, limit };
  if (process.env.GOOGLE_PLACES_API_KEY) {
    try {
      const out = await googlePlaces(args);
      if (out.length) return { provider: "google", places: out };
      console.log("[Places] Google returned 0 results — falling back to Overpass");
    } catch (err) {
      console.warn(`[Places] Google failed (${err.message}) — falling back to Overpass`);
    }
  }
  const out = await overpassPlaces(args);
  return { provider: "osm", places: out };
}

/* ── Format places list as a Discord-friendly text block ── */
export function formatPlacesBlock({ provider, places, query, originLabel }) {
  if (!places || !places.length) {
    return `[NEARBY PLACES]\nNo "${query || "places"}" found near ${originLabel}. Try a wider search or a different keyword.\n[END NEARBY PLACES]\n\n`;
  }
  const lines = places.map((p, i) => {
    const dist = p.distance_m != null
      ? (p.distance_m < 1000 ? `${p.distance_m}m` : `${(p.distance_m / 1000).toFixed(1)}km`)
      : "?";
    const ratingPart = p.rating ? ` · ${p.rating}` : "";
    const addressPart = p.address ? ` — ${p.address}` : "";
    return `${i + 1}. **${p.name}** (${p.type}, ${dist}${ratingPart})${addressPart}\n   ${p.mapsUrl}`;
  }).join("\n");
  return (
    `[NEARBY PLACES — ${query || "general"} near ${originLabel}]\n` +
    `Source: ${provider === "google" ? "Google Places" : "OpenStreetMap"}.\n` +
    `Present these to the user with the maps links so they can tap to open.\n\n${lines}\n` +
    `[END NEARBY PLACES]\n\n`
  );
}

/* ── Detect a natural-language nearby request ──
   "what's near me", "any coffee around me", "find a gas station nearby", etc.
   Returns {query} or null. */
export function detectNearbyRequest(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const proximityRx = /\b(near ?me|around me|around here|nearby|close by|in (this|the) area|walking distance|in walking)\b/i;
  if (!proximityRx.test(lower)) return null;
  /* Try to extract the noun the user is hunting for */
  const m =
    lower.match(/\b(?:find|any|some|where['s]*|show|list|recommend|grab|get|hit up)\s+(?:a |some |the )?([\w\s\-']{2,40}?)\s+(?:near|around|close|nearby|in)/i) ||
    lower.match(/\b(coffee|cafe|food|restaurant|bar|pub|drink|nightclub|club|gas|fuel|grocery|supermarket|pharmacy|hospital|bank|atm|hotel|park|gym|museum|gallery|landmark|library|parking|studio|music|venue)s?\b/i);
  return { query: (m?.[1] || m?.[0] || "").trim() };
}
