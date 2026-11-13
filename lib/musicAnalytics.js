/* ──────────────────────────────────────────────────────
   MUSIC ANALYTICS — Live data fetchers for the record label

   Pulls public streaming/social data so Athena can speak with
   real numbers, not vibes. Each provider is OPTIONAL — if its
   credentials are missing the function returns null rather
   than throwing, so the rest of the bot keeps working.

   Required (free) credentials:
     SPOTIFY_CLIENT_ID       — developer.spotify.com
     SPOTIFY_CLIENT_SECRET   — developer.spotify.com
     YOUTUBE_API_KEY         — Google Cloud Console (YouTube Data API v3)

   Optional:
     LASTFM_API_KEY          — last.fm/api  (cross-check listener counts)
     MUSIXMATCH_API_KEY      — musixmatch.com/admin/applications (lyrics/metadata)

   Storage:
     Per-artist roster lives in Firebase `label_roster/{artistId}`
     with shape: { name, spotifyId, appleId, youtubeChannelId,
                   tiktokHandle, instagramHandle, signedAt, role }
   Snapshots get appended to `label_metrics/{artistId}/snapshots`
   (one doc per pull) so we can chart growth over time.
────────────────────────────────────────────────────── */

import { db } from "../firebase.js";

/* ═══════════════════════════════════════════════════════
   SPOTIFY — Client Credentials flow (no user OAuth needed
   for public artist/track data; for monthly listeners and
   true Spotify-for-Artists data the artist must run their
   own OAuth flow — handled separately when configured).
   ═══════════════════════════════════════════════════════ */

let spotifyToken = null;
let spotifyTokenExpiresAt = 0;

async function getSpotifyToken() {
  const id     = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (spotifyToken && Date.now() < spotifyTokenExpiresAt - 60_000) {
    return spotifyToken;
  }
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res  = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    console.warn(`[MusicAnalytics:Spotify] Token fetch failed: HTTP ${res.status}`);
    return null;
  }
  const json = await res.json();
  spotifyToken         = json.access_token;
  spotifyTokenExpiresAt = Date.now() + (json.expires_in * 1000);
  return spotifyToken;
}

async function spotifyGet(path) {
  const token = await getSpotifyToken();
  if (!token) return null;
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`[MusicAnalytics:Spotify] ${path} → HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

/* Pull artist overview: name, followers, popularity (0-100),
   genres, top tracks, related artists. */
export async function getSpotifyArtist(artistId) {
  if (!artistId) return null;
  const [profile, top, related, albums] = await Promise.all([
    spotifyGet(`/artists/${artistId}`),
    spotifyGet(`/artists/${artistId}/top-tracks?market=US`),
    spotifyGet(`/artists/${artistId}/related-artists`),
    spotifyGet(`/artists/${artistId}/albums?include_groups=album,single&limit=20&market=US`),
  ]);
  if (!profile) return null;
  return {
    name:       profile.name,
    followers:  profile.followers?.total ?? null,
    popularity: profile.popularity ?? null,  /* 0-100, Spotify's algorithmic score */
    genres:     profile.genres ?? [],
    image:      profile.images?.[0]?.url ?? null,
    topTracks:  (top?.tracks ?? []).slice(0, 10).map(t => ({
      id:         t.id,
      name:       t.name,
      popularity: t.popularity,
      duration:   t.duration_ms,
      previewUrl: t.preview_url,
      album:      t.album?.name,
      releaseDate: t.album?.release_date,
    })),
    relatedArtists: (related?.artists ?? []).slice(0, 10).map(a => ({
      id:         a.id,
      name:       a.name,
      followers:  a.followers?.total,
      popularity: a.popularity,
    })),
    recentReleases: (albums?.items ?? []).slice(0, 10).map(a => ({
      id:          a.id,
      name:        a.name,
      type:        a.album_type,
      releaseDate: a.release_date,
      tracks:      a.total_tracks,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

/* Pull a single track's audio features + popularity. Audio features
   include: tempo, key, energy, danceability, valence, acousticness,
   instrumentalness, liveness, speechiness, loudness, time_signature.
   This is gold for analyzing why a track does or doesn't connect. */
export async function getSpotifyTrack(trackId) {
  if (!trackId) return null;
  const [track, features] = await Promise.all([
    spotifyGet(`/tracks/${trackId}?market=US`),
    spotifyGet(`/audio-features/${trackId}`),
  ]);
  if (!track) return null;
  return {
    id:         track.id,
    name:       track.name,
    artists:    track.artists?.map(a => ({ id: a.id, name: a.name })) ?? [],
    album:      track.album?.name,
    releaseDate: track.album?.release_date,
    popularity: track.popularity,
    duration:   track.duration_ms,
    explicit:   track.explicit,
    previewUrl: track.preview_url,
    audioFeatures: features ? {
      tempo:           features.tempo,
      key:             features.key,
      mode:            features.mode,
      timeSignature:   features.time_signature,
      energy:          features.energy,
      danceability:    features.danceability,
      valence:         features.valence,        /* musical positiveness */
      acousticness:    features.acousticness,
      instrumentalness: features.instrumentalness,
      liveness:        features.liveness,
      speechiness:     features.speechiness,
      loudness:        features.loudness,
    } : null,
    fetchedAt: new Date().toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════
   YOUTUBE — public Data API v3, key-only (no OAuth needed
   for public channel/video stats).
   ═══════════════════════════════════════════════════════ */

async function youtubeGet(path) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://www.googleapis.com/youtube/v3${path}${sep}key=${key}`);
  if (!res.ok) {
    console.warn(`[MusicAnalytics:YouTube] ${path} → HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

export async function getYouTubeChannel(channelId) {
  if (!channelId) return null;
  const data = await youtubeGet(`/channels?part=snippet,statistics&id=${channelId}`);
  const ch = data?.items?.[0];
  if (!ch) return null;
  return {
    id:           ch.id,
    title:        ch.snippet?.title,
    description:  ch.snippet?.description,
    country:      ch.snippet?.country,
    publishedAt:  ch.snippet?.publishedAt,
    thumbnail:    ch.snippet?.thumbnails?.high?.url,
    subscribers:  parseInt(ch.statistics?.subscriberCount ?? "0", 10),
    totalViews:   parseInt(ch.statistics?.viewCount ?? "0", 10),
    videoCount:   parseInt(ch.statistics?.videoCount ?? "0", 10),
    fetchedAt:    new Date().toISOString(),
  };
}

export async function getYouTubeRecentVideos(channelId, max = 10) {
  if (!channelId) return null;
  const search = await youtubeGet(
    `/search?part=snippet&channelId=${channelId}&order=date&maxResults=${max}&type=video`
  );
  const ids = (search?.items ?? []).map(i => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const stats = await youtubeGet(`/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
  return (stats?.items ?? []).map(v => ({
    id:           v.id,
    title:        v.snippet?.title,
    publishedAt:  v.snippet?.publishedAt,
    duration:     v.contentDetails?.duration, /* ISO-8601 PT#M#S */
    views:        parseInt(v.statistics?.viewCount ?? "0", 10),
    likes:        parseInt(v.statistics?.likeCount ?? "0", 10),
    comments:     parseInt(v.statistics?.commentCount ?? "0", 10),
    thumbnail:    v.snippet?.thumbnails?.high?.url,
  }));
}

/* ═══════════════════════════════════════════════════════
   ROSTER + SNAPSHOT STORAGE — persistent record per artist
   so Athena can chart growth and trigger her decision rules.
   ═══════════════════════════════════════════════════════ */

const ROSTER_COLL   = "label_roster";
const SNAPSHOT_COLL = "label_metrics";

export async function listRoster() {
  const snap = await db.collection(ROSTER_COLL).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function upsertArtist(artistId, data) {
  await db.collection(ROSTER_COLL).doc(artistId).set(
    { ...data, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

export async function removeArtist(artistId) {
  await db.collection(ROSTER_COLL).doc(artistId).delete();
}

/* Pull every available metric for one artist and persist a snapshot. */
export async function snapshotArtist(artistId) {
  const docRef = db.collection(ROSTER_COLL).doc(artistId);
  const doc    = await docRef.get();
  if (!doc.exists) throw new Error(`Artist '${artistId}' not in label_roster`);
  const a = doc.data();

  const [spotify, ytChannel, ytVideos] = await Promise.all([
    a.spotifyId        ? getSpotifyArtist(a.spotifyId)               : null,
    a.youtubeChannelId ? getYouTubeChannel(a.youtubeChannelId)       : null,
    a.youtubeChannelId ? getYouTubeRecentVideos(a.youtubeChannelId, 5) : null,
  ]);

  const snapshot = {
    artistId,
    name:       a.name,
    spotify,
    youtube:    ytChannel ? { ...ytChannel, recentVideos: ytVideos ?? [] } : null,
    capturedAt: new Date().toISOString(),
  };

  await db.collection(SNAPSHOT_COLL).doc(artistId)
    .collection("snapshots").add(snapshot);

  return snapshot;
}

/* Roll up every artist into one digest Athena can scan in a single tick. */
export async function snapshotAllArtists() {
  const roster = await listRoster();
  const out = [];
  for (const a of roster) {
    try {
      out.push(await snapshotArtist(a.id));
    } catch (err) {
      console.warn(`[MusicAnalytics] snapshot ${a.id}: ${err.message}`);
      out.push({ artistId: a.id, name: a.name, error: err.message });
    }
  }
  return out;
}

/* Compact textual digest for injection into Athena's context. */
export function formatRosterDigest(snapshots) {
  if (!snapshots?.length) return "";
  const lines = ["[LABEL ROSTER LIVE METRICS]"];
  for (const s of snapshots) {
    if (s.error) {
      lines.push(`• ${s.name}: snapshot error — ${s.error}`);
      continue;
    }
    const sp = s.spotify;
    const yt = s.youtube;
    const bits = [];
    if (sp) {
      bits.push(`Spotify ${sp.followers?.toLocaleString() ?? "?"} followers, popularity ${sp.popularity ?? "?"}/100`);
      if (sp.topTracks?.[0]) bits.push(`top: "${sp.topTracks[0].name}" (pop ${sp.topTracks[0].popularity})`);
    }
    if (yt) {
      bits.push(`YouTube ${yt.subscribers?.toLocaleString() ?? "?"} subs, ${yt.totalViews?.toLocaleString() ?? "?"} views`);
    }
    lines.push(`• ${s.name}: ${bits.join(" | ") || "no data sources configured"}`);
  }
  return lines.join("\n");
}

/* Provider availability — handy for !labelstatus diagnostics. */
export function providerStatus() {
  return {
    spotify: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    youtube: !!process.env.YOUTUBE_API_KEY,
  };
}
