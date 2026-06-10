require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPES = 'playlist-read-private';

// Module-level token cache — persists across warm serverless invocations
const tokenStore = {
  accessToken: null,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || null,
  expiresAt: null,
};

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error('No refresh token available');
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    `grant_type=refresh_token&refresh_token=${tokenStore.refreshToken}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` } }
  );
  tokenStore.accessToken = response.data.access_token;
  tokenStore.expiresAt = Date.now() + response.data.expires_in * 1000;
  if (response.data.refresh_token) {
    tokenStore.refreshToken = response.data.refresh_token;
  }
}

async function getValidToken() {
  if (!tokenStore.accessToken || Date.now() >= tokenStore.expiresAt - 60_000) {
    await refreshAccessToken();
  }
  return tokenStore.accessToken;
}

// Step 1: redirect user to Spotify login
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// Step 2: Spotify redirects here with ?code=...
// After first auth, copy the logged refresh_token to SPOTIFY_REFRESH_TOKEN in Vercel env vars
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.status(400).json({ error: error || 'No code returned' });
  }

  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` } }
    );

    tokenStore.accessToken = response.data.access_token;
    tokenStore.refreshToken = response.data.refresh_token;
    tokenStore.expiresAt = Date.now() + response.data.expires_in * 1000;

    console.log('SPOTIFY_REFRESH_TOKEN:', tokenStore.refreshToken);

    res.json({
      message: 'Authenticated. Copy the refresh_token from server logs into your Vercel env vars as SPOTIFY_REFRESH_TOKEN.',
      refresh_token: tokenStore.refreshToken,
    });
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!tokenStore.refreshToken,
    hasAccessToken: !!tokenStore.accessToken,
  });
});

app.get('/api/test', (req, res) => {
  res.json([
    { title: "Blinding Lights", artist: "The Weeknd" },
    { title: "Shape of You", artist: "Ed Sheeran" },
    { title: "Perfect", artist: "Ed Sheeran" }
  ]);
});

app.get('/api/playlist/:id', async (req, res) => {
  let token;
  try {
    token = await getValidToken();
  } catch (err) {
    console.error('Token error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.', detail: err.response?.data || err.message });
  }

  try {
    // Try the tracks sub-endpoint first; fall back to inline tracks from playlist object
    const playlistRes = await axios.get(
      `https://api.spotify.com/v1/playlists/${req.params.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    let rawTracks = [];
    try {
      const tracksRes = await axios.get(
        `https://api.spotify.com/v1/playlists/${req.params.id}/tracks`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      rawTracks = tracksRes.data.items;
    } catch (tracksErr) {
      // Spotify dev-mode restriction: tracks sub-endpoint blocked
      // Fall back to tracks embedded in the playlist object if present
      console.warn('Tracks sub-endpoint blocked:', tracksErr.response?.status, '— using fallback');
      rawTracks = playlistRes.data.tracks?.items || [];
    }

    const tracks = rawTracks
      .filter(item => item.track)
      .map(item => ({
        title: item.track.name,
        artist: item.track.artists[0]?.name ?? 'Unknown',
        spotifyUrl: item.track.external_urls.spotify,
      }));

    res.json({
      name: playlistRes.data.name,
      description: playlistRes.data.description,
      tracks,
    });
  } catch (err) {
    console.error('Playlist error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Spotify API 오류',
      status: err.response?.status,
      detail: err.response?.data || err.message,
    });
  }
});

// ── Apple Music ─────────────────────────────────────────────────────────────

const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const APPLE_KEY_ID  = process.env.APPLE_KEY_ID;
// Private key stored as single-line PEM with literal \n in the env var
const APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Cached token — valid up to 6 months, we regenerate every 12 hours
let appleDeveloperToken = null;
let appleTokenExpiresAt = 0;

function getAppleDeveloperToken() {
  if (appleDeveloperToken && Date.now() < appleTokenExpiresAt) return appleDeveloperToken;
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
    throw new Error('Apple Music credentials not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { iss: APPLE_TEAM_ID, iat: now, exp: now + 43200 }, // 12 hours
    APPLE_PRIVATE_KEY,
    { algorithm: 'ES256', keyid: APPLE_KEY_ID }
  );
  appleDeveloperToken = token;
  appleTokenExpiresAt = (now + 43200) * 1000;
  return token;
}

app.get('/api/apple/playlist/:id', async (req, res) => {
  let devToken;
  try {
    devToken = getAppleDeveloperToken();
  } catch (err) {
    return res.status(500).json({ error: 'Apple Music credentials not configured', detail: err.message });
  }

  const storefront = req.query.storefront || 'us';

  try {
    const response = await axios.get(
      `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${req.params.id}`,
      { headers: { Authorization: `Bearer ${devToken}` } }
    );

    const data = response.data.data[0];
    const tracks = (data.relationships?.tracks?.data || []).map(track => ({
      title: track.attributes.name,
      artist: track.attributes.artistName,
      appleUrl: track.attributes.url,
    }));

    res.json({
      name: data.attributes.name,
      description: data.attributes.description?.standard || '',
      tracks,
    });
  } catch (err) {
    console.error('Apple Music error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    res.status(err.response?.status || 500).json({ error: 'Apple Music API 오류' });
  }
});

// ── Melon ───────────────────────────────────────────────────────────────────

const MELON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.melon.com/',
};

// kko.to short links redirect through an into.melon.com gate page (which embeds
// the real destination in a `landingUrl` query param) before reaching the
// final melon.com playlist URL — follow the chain until it settles.
async function resolveMelonUrl(inputUrl) {
  if (!inputUrl.includes('kko.to')) return inputUrl;

  let url = inputUrl;

  for (let i = 0; i < 3; i++) {
    const response = await axios.get(url, {
      headers: MELON_HEADERS,
      maxRedirects: 5,
    });
    const finalUrl = response.request?.res?.responseUrl || url;

    let landingUrl;
    try {
      landingUrl = new URL(finalUrl).searchParams.get('landingUrl');
    } catch (_) {}

    if (!landingUrl) return finalUrl;
    url = decodeURIComponent(landingUrl);
  }

  return url;
}

function parseMelonTracks(html) {
  const $ = cheerio.load(html);
  const tracks = [];

  $('tr').each((_, el) => {
    const title = $(el).find('.ellipsis.rank01 a[title]').first().text().trim();
    const artist = $(el).find('.ellipsis.rank02 a').first().text().trim();
    if (title) tracks.push({ title, artist: artist || '아티스트 미상' });
  });

  return tracks;
}

app.get('/api/melon/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('melon.com') && !inputUrl.includes('kko.to')) {
    return res.status(400).json({ error: 'Melon 또는 kko.to 링크만 지원해요' });
  }

  try {
    const resolvedUrl = await resolveMelonUrl(inputUrl);
    const match = resolvedUrl.match(/plylstSeq=(\d+)/);
    if (!match) {
      return res.status(400).json({ error: '플레이리스트 ID를 찾을 수 없어요', resolvedUrl });
    }
    const plylstSeq = match[1];

    const viewRes = await axios.get('https://www.melon.com/mymusic/dj/mymusicdjplaylistview_inform.htm', {
      params: { plylstSeq },
      headers: MELON_HEADERS,
    });
    const tracks = parseMelonTracks(viewRes.data);

    if (tracks.length === 0) {
      return res.status(404).json({ error: '곡 목록을 찾을 수 없어요', plylstSeq });
    }

    res.json({ plylstSeq, tracks });
  } catch (err) {
    console.error('Melon scrape error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'Melon 스크래핑 오류', detail: err.message });
  }
});

// ── FLO ─────────────────────────────────────────────────────────────────────

const FLO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.music-flo.com/',
};

function parseFloTracks(data) {
  const trackList = data?.trackList || [];
  return trackList.map(track => ({
    title: track.name,
    artist: track.representationArtist?.name || track.artistList?.[0]?.name || '아티스트 미상',
  }));
}

app.get('/api/flo/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('music-flo.com')) {
    return res.status(400).json({ error: 'FLO 링크만 지원해요' });
  }

  const match = inputUrl.match(/\/detail\/(playlist|openplaylist|pri-playlist|pri_playlist)\/(\d+)/);
  if (!match) {
    return res.status(400).json({ error: '플레이리스트 ID를 찾을 수 없어요' });
  }
  const [, type, id] = match;

  const endpoints = type === 'playlist'
    ? [`https://www.music-flo.com/api/meta/v1/channel/${id}`, `https://www.music-flo.com/api/personal/v1/playlist/${id}`]
    : type === 'openplaylist'
      ? [`https://www.music-flo.com/api/personal/v1/playlist/${id}`, `https://www.music-flo.com/api/meta/v1/channel/${id}`]
      : [`https://www.music-flo.com/api/personal/v1/pri_playlist/${id}`];

  try {
    let tracks = [];
    let lastError;

    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, { headers: FLO_HEADERS });
        if (response.data?.code !== '2000000') {
          lastError = response.data?.message;
          continue;
        }
        tracks = parseFloTracks(response.data.data);
        if (tracks.length > 0) break;
      } catch (err) {
        lastError = err.message;
      }
    }

    if (tracks.length === 0) {
      return res.status(404).json({ error: '곡 목록을 찾을 수 없어요', detail: lastError });
    }

    res.json({ id, tracks });
  } catch (err) {
    console.error('FLO scrape error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'FLO 스크래핑 오류', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
