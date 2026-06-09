require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');

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
    const [playlistRes, tracksRes] = await Promise.all([
      axios.get(`https://api.spotify.com/v1/playlists/${req.params.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }),
      axios.get(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
    ]);

    const tracks = tracksRes.data.items
      .filter(item => item.track)
      .map(item => ({
        title: item.track.name,
        artist: item.track.artists[0]?.name ?? 'Unknown',
        spotifyUrl: item.track.external_urls.spotify
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

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
