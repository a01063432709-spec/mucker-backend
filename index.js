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

// Checks whether a Spotify playlist exists and is accessible (used for link validation)
app.get('/api/spotify/validate', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: 'id 쿼리 파라미터가 필요해요' });
  }

  let token;
  try {
    token = await getValidToken();
  } catch (err) {
    console.error('Token error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.' });
  }

  try {
    await axios.get(`https://api.spotify.com/v1/playlists/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      params: { fields: 'id' },
    });
    res.json({ exists: true });
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) {
      return res.json({ exists: false });
    }
    console.error('Playlist exists check error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    res.status(err.response?.status || 500).json({ error: 'Spotify API 오류' });
  }
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

// Checks whether an Apple Music playlist exists in the given storefront catalog
app.get('/api/apple/validate', async (req, res) => {
  const id = (req.query.id || '').trim();
  const storefront = (req.query.storefront || 'us').trim();
  if (!id) {
    return res.status(400).json({ error: 'id 쿼리 파라미터가 필요해요' });
  }

  let devToken;
  try {
    devToken = getAppleDeveloperToken();
  } catch (err) {
    return res.status(500).json({ error: 'Apple Music credentials not configured', detail: err.message });
  }

  try {
    await axios.get(`https://api.music.apple.com/v1/catalog/${storefront}/playlists/${id}`, {
      headers: { Authorization: `Bearer ${devToken}` },
      params: { fields: 'id' },
    });
    res.json({ exists: true });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ exists: false });
    }
    console.error('Apple validate error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
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

// Checks whether a Melon playlist exists by resolving the URL and checking for tracks
app.get('/api/melon/validate', async (req, res) => {
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
      return res.json({ exists: false });
    }

    const viewRes = await axios.get('https://www.melon.com/mymusic/dj/mymusicdjplaylistview_inform.htm', {
      params: { plylstSeq: match[1] },
      headers: MELON_HEADERS,
    });
    const tracks = parseMelonTracks(viewRes.data);
    res.json({ exists: tracks.length > 0 });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ exists: false });
    }
    console.error('Melon validate error:', err.response?.status, err.message);
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
  const trackList = data?.trackList || data?.track?.list || [];
  return trackList.map(track => ({
    title: track.name,
    artist: track.representationArtist?.name || track.artistList?.[0]?.name || '아티스트 미상',
  }));
}

// flomuz.io short links land on a share.music-flo.com page whose __NEXT_DATA__
// JSON embeds the real /detail/... playlist URL under data.webLink.
async function resolveFloUrl(inputUrl) {
  if (!inputUrl.includes('flomuz.io')) return inputUrl;

  const response = await axios.get(inputUrl, {
    headers: { 'User-Agent': FLO_HEADERS['User-Agent'] },
    maxRedirects: 5,
  });
  const $ = cheerio.load(response.data);
  const nextData = JSON.parse($('#__NEXT_DATA__').text() || '{}');
  const data = nextData?.props?.pageProps?.data;
  return data?.webLink || data?.mobileWebLink || inputUrl;
}

app.get('/api/flo/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('music-flo.com') && !inputUrl.includes('flomuz.io')) {
    return res.status(400).json({ error: 'FLO 링크만 지원해요' });
  }

  const resolvedUrl = await resolveFloUrl(inputUrl);
  const match = resolvedUrl.match(/\/detail\/(playlist|openplaylist|pri-playlist|pri_playlist)\/(\d+)/);
  if (!match) {
    return res.status(400).json({ error: '플레이리스트 ID를 찾을 수 없어요', resolvedUrl });
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

// Checks whether a FLO playlist exists by resolving the URL and querying its endpoints
app.get('/api/flo/validate', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('music-flo.com') && !inputUrl.includes('flomuz.io')) {
    return res.status(400).json({ error: 'FLO 링크만 지원해요' });
  }

  try {
    const resolvedUrl = await resolveFloUrl(inputUrl);
    const match = resolvedUrl.match(/\/detail\/(playlist|openplaylist|pri-playlist|pri_playlist)\/(\d+)/);
    if (!match) {
      return res.json({ exists: false });
    }
    const [, type, id] = match;

    const endpoints = type === 'playlist'
      ? [`https://www.music-flo.com/api/meta/v1/channel/${id}`, `https://www.music-flo.com/api/personal/v1/playlist/${id}`]
      : type === 'openplaylist'
        ? [`https://www.music-flo.com/api/personal/v1/playlist/${id}`, `https://www.music-flo.com/api/meta/v1/channel/${id}`]
        : [`https://www.music-flo.com/api/personal/v1/pri_playlist/${id}`];

    let exists = false;
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, { headers: FLO_HEADERS });
        if (response.data?.code === '2000000') {
          exists = true;
          break;
        }
      } catch (_) {}
    }

    res.json({ exists });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ exists: false });
    }
    console.error('FLO validate error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'FLO 스크래핑 오류', detail: err.message });
  }
});

// ── Genie ───────────────────────────────────────────────────────────────────

const GENIE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.genie.co.kr/',
};

function parseGenieTracks(html) {
  const $ = cheerio.load(html);
  const tracks = [];

  $('tr.list').each((_, el) => {
    const title = $(el).find('a.title').first().attr('title')?.trim();
    const artist = $(el).find('a.artist').first().text().trim();
    if (title) tracks.push({ title, artist: artist || '아티스트 미상' });
  });

  return tracks;
}

app.get('/api/genie/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('genie.co.kr')) {
    return res.status(400).json({ error: 'Genie 링크만 지원해요' });
  }

  try {
    // genie.co.kr short links redirect to the playlist detail page automatically
    const response = await axios.get(inputUrl, {
      headers: GENIE_HEADERS,
      maxRedirects: 5,
    });
    const finalUrl = response.request?.res?.responseUrl || inputUrl;

    const match = finalUrl.match(/pl[ym]Seq=(\d+)/);
    if (!match) {
      return res.status(400).json({ error: '플레이리스트 ID를 찾을 수 없어요', resolvedUrl: finalUrl });
    }

    const tracks = parseGenieTracks(response.data);
    if (tracks.length === 0) {
      return res.status(404).json({ error: '곡 목록을 찾을 수 없어요', plmSeq: match[1] });
    }

    res.json({ plmSeq: match[1], tracks });
  } catch (err) {
    console.error('Genie scrape error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'Genie 스크래핑 오류', detail: err.message });
  }
});

// Checks whether a Genie playlist exists by following the link and checking for tracks
app.get('/api/genie/validate', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('genie.co.kr')) {
    return res.status(400).json({ error: 'Genie 링크만 지원해요' });
  }

  try {
    const response = await axios.get(inputUrl, {
      headers: GENIE_HEADERS,
      maxRedirects: 5,
    });
    const finalUrl = response.request?.res?.responseUrl || inputUrl;

    const match = finalUrl.match(/pl[ym]Seq=(\d+)/);
    if (!match) {
      return res.json({ exists: false });
    }

    const tracks = parseGenieTracks(response.data);
    res.json({ exists: tracks.length > 0 });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ exists: false });
    }
    console.error('Genie validate error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'Genie 스크래핑 오류', detail: err.message });
  }
});

// ── YouTube ─────────────────────────────────────────────────────────────────

const YOUTUBE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// www.youtube.com/playlist pages embed a `var ytInitialData = {...};` JSON blob
// containing the video list as lockupViewModel items (newer layout) or
// playlistVideoRenderer items (older layout).
function parseYoutubeTracks(html) {
  const match = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (_) {
    return [];
  }

  const contents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.itemSectionRenderer?.contents || [];

  const tracks = [];
  for (const item of contents) {
    if (item.lockupViewModel) {
      const meta = item.lockupViewModel.metadata?.lockupMetadataViewModel;
      const title = meta?.title?.content;
      const artist = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content;
      if (title) tracks.push({ title, artist: artist || '아티스트 미상' });
      continue;
    }

    const r = item.playlistVideoRenderer;
    if (r) {
      const title = r.title?.runs?.[0]?.text || r.title?.simpleText;
      const artist = r.shortBylineText?.runs?.[0]?.text;
      if (title) tracks.push({ title, artist: artist || '아티스트 미상' });
    }
  }

  return tracks;
}

// music.youtube.com/playlist pages embed the playlist data as a JS-string-escaped
// JSON blob inside `initialData.push({path: '/browse', ..., data: '...'})`.
function parseYoutubeMusicTracks(html) {
  const match = html.match(/initialData\.push\(\{path:\s*'\\\/browse'.*?data:\s*'((?:[^'\\]|\\.)*)'\}\);/s);
  if (!match) return [];

  let data;
  try {
    let raw = match[1];
    raw = raw.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1');
    raw = raw.replace(/\\'/g, "'");
    const jsonText = JSON.parse(`"${raw}"`);
    data = JSON.parse(jsonText);
  } catch (_) {
    return [];
  }

  const shelf = data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
    ?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer;
  const items = shelf?.contents || [];

  const tracks = [];
  for (const item of items) {
    const r = item.musicResponsiveListItemRenderer;
    if (!r) continue;
    const title = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
    const artist = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(run => run.text).join('');
    if (title) tracks.push({ title, artist: artist || '아티스트 미상' });
  }

  return tracks;
}

app.get('/api/youtube/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();

  if (!inputUrl) {
    return res.status(400).json({ error: 'url 쿼리 파라미터가 필요해요' });
  }
  if (!inputUrl.includes('youtube.com')) {
    return res.status(400).json({ error: 'YouTube 링크만 지원해요' });
  }

  const match = inputUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (!match) {
    return res.status(400).json({ error: '플레이리스트 ID를 찾을 수 없어요' });
  }
  const listId = match[1];
  const isMusic = inputUrl.includes('music.youtube.com');

  try {
    const url = isMusic
      ? `https://music.youtube.com/playlist?list=${listId}`
      : `https://www.youtube.com/playlist?list=${listId}`;

    const response = await axios.get(url, { headers: YOUTUBE_HEADERS });
    const tracks = isMusic ? parseYoutubeMusicTracks(response.data) : parseYoutubeTracks(response.data);

    if (tracks.length === 0) {
      return res.status(404).json({ error: '곡 목록을 찾을 수 없어요', listId });
    }

    res.json({ listId, tracks });
  } catch (err) {
    console.error('YouTube scrape error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'YouTube 스크래핑 오류', detail: err.message });
  }
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Checks whether a YouTube playlist exists, using the Data API if a key is configured
// and falling back to scraping the playlist page otherwise
app.get('/api/youtube/validate', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: 'id 쿼리 파라미터가 필요해요' });
  }

  try {
    if (YOUTUBE_API_KEY) {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/playlists', {
        params: { part: 'id', id, key: YOUTUBE_API_KEY },
      });
      return res.json({ exists: (response.data.items || []).length > 0 });
    }

    const response = await axios.get(`https://www.youtube.com/playlist?list=${id}`, { headers: YOUTUBE_HEADERS });
    const tracks = parseYoutubeTracks(response.data);
    res.json({ exists: tracks.length > 0 });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.json({ exists: false });
    }
    console.error('YouTube validate error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({ error: 'YouTube API 오류', detail: err.message });
  }
});

// ── Auto-fill metadata ───────────────────────────────────────────────────────

// Given a playlist link on any supported platform, best-effort extract its
// display name so the create form can be pre-filled. Returns {} if unknown.
app.get('/api/meta/playlist', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();
  if (!inputUrl) return res.json({});

  try {
    if (inputUrl.includes('open.spotify.com')) {
      const m = inputUrl.match(/\/playlist\/([A-Za-z0-9]{22})/);
      if (!m) return res.json({});
      const token = await getValidToken();
      const resp = await axios.get(`https://api.spotify.com/v1/playlists/${m[1]}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'name' },
      });
      return res.json({ name: resp.data.name || '' });
    }

    if (inputUrl.includes('music.apple.com')) {
      const m = inputUrl.match(/music\.apple\.com\/(\w{2})\/playlist\/[^\/?]+\/(pl\.[\w.-]+)/);
      if (!m) return res.json({});
      const devToken = getAppleDeveloperToken();
      const resp = await axios.get(`https://api.music.apple.com/v1/catalog/${m[1]}/playlists/${m[2]}`, {
        headers: { Authorization: `Bearer ${devToken}` },
        params: { fields: 'name' },
      });
      return res.json({ name: resp.data.data?.[0]?.attributes?.name || '' });
    }

    if (inputUrl.includes('music.youtube.com') || inputUrl.includes('youtube.com/playlist')) {
      const m = inputUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
      if (!m) return res.json({});
      const resp = await axios.get('https://www.youtube.com/oembed', {
        params: { url: `https://www.youtube.com/playlist?list=${m[1]}`, format: 'json' },
      });
      return res.json({ name: resp.data.title || '' });
    }

    if (inputUrl.includes('melon.com') || inputUrl.includes('kko.to')) {
      const resolvedUrl = await resolveMelonUrl(inputUrl);
      const m = resolvedUrl.match(/plylstSeq=(\d+)/);
      if (!m) return res.json({});
      const viewRes = await axios.get('https://www.melon.com/mymusic/dj/mymusicdjplaylistview_inform.htm', {
        params: { plylstSeq: m[1] },
        headers: MELON_HEADERS,
      });
      if (parseMelonTracks(viewRes.data).length === 0) return res.json({});

      const $ = cheerio.load(viewRes.data);
      let name = $('meta[property="og:title"]').attr('content') || $('.tit_playlist').first().text().trim();
      name = (name || '').replace(/\s*-\s*멜론\s*$/, '').trim();
      if (!name || name === 'Melon') return res.json({});
      return res.json({ name });
    }

    if (inputUrl.includes('music-flo.com') || inputUrl.includes('flomuz.io')) {
      const resolvedUrl = await resolveFloUrl(inputUrl);
      const m = resolvedUrl.match(/\/detail\/(playlist|openplaylist|pri-playlist|pri_playlist)\/(\d+)/);
      if (!m) return res.json({});
      const [, type, id] = m;
      const endpoints = type === 'playlist'
        ? [`https://www.music-flo.com/api/meta/v1/channel/${id}`, `https://www.music-flo.com/api/personal/v1/playlist/${id}`]
        : type === 'openplaylist'
          ? [`https://www.music-flo.com/api/personal/v1/playlist/${id}`, `https://www.music-flo.com/api/meta/v1/channel/${id}`]
          : [`https://www.music-flo.com/api/personal/v1/pri_playlist/${id}`];

      for (const endpoint of endpoints) {
        try {
          const resp = await axios.get(endpoint, { headers: FLO_HEADERS });
          if (resp.data?.code === '2000000') {
            const name = resp.data.data?.name || resp.data.data?.title || '';
            if (name) return res.json({ name });
          }
        } catch (_) {}
      }
      return res.json({});
    }

    if (inputUrl.includes('genie.co.kr')) {
      const resp = await axios.get(inputUrl, { headers: GENIE_HEADERS, maxRedirects: 5 });
      const $ = cheerio.load(resp.data);
      const ogTitle = $('meta[property="og:title"]').attr('content') || '';
      const m = ogTitle.match(/^(.*)\s*-\s*genie$/i);
      if (!m) return res.json({});
      return res.json({ name: m[1].trim() });
    }

    return res.json({});
  } catch (err) {
    console.error('Meta playlist error:', err.response?.status, err.message);
    return res.json({});
  }
});

// Given a single-track link on any supported platform, best-effort extract its
// title and artist so the share form can be pre-filled. Returns {} if unknown.
app.get('/api/meta/song', async (req, res) => {
  const inputUrl = (req.query.url || '').trim();
  if (!inputUrl) return res.json({});

  try {
    if (inputUrl.includes('open.spotify.com')) {
      const m = inputUrl.match(/\/track\/([A-Za-z0-9]{22})/);
      if (!m) return res.json({});
      const token = await getValidToken();
      const resp = await axios.get(`https://api.spotify.com/v1/tracks/${m[1]}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json({ title: resp.data.name || '', artist: resp.data.artists?.[0]?.name || '' });
    }

    if (inputUrl.includes('music.apple.com')) {
      const m = inputUrl.match(/music\.apple\.com\/(\w{2})\/(?:song|album)\/[^\/?]+\/(\d+)/);
      const iMatch = inputUrl.match(/[?&]i=(\d+)/);
      const songId = iMatch ? iMatch[1] : m?.[2];
      if (!songId) return res.json({});
      const storefront = m?.[1] || 'us';
      const devToken = getAppleDeveloperToken();
      const resp = await axios.get(`https://api.music.apple.com/v1/catalog/${storefront}/songs/${songId}`, {
        headers: { Authorization: `Bearer ${devToken}` },
      });
      const attrs = resp.data.data?.[0]?.attributes;
      return res.json({ title: attrs?.name || '', artist: attrs?.artistName || '' });
    }

    if (inputUrl.includes('music.youtube.com') || inputUrl.includes('youtube.com') || inputUrl.includes('youtu.be')) {
      const m = inputUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/) || inputUrl.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
      if (!m) return res.json({});
      const resp = await axios.get('https://www.youtube.com/oembed', {
        params: { url: `https://www.youtube.com/watch?v=${m[1]}`, format: 'json' },
      });
      let title = resp.data.title || '';
      let artist = (resp.data.author_name || '').replace(/\s*-\s*Topic\s*$/i, '').trim();

      // Many official music videos format the page title as "Artist - Title"
      const dashMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
      if (dashMatch) {
        if (!artist) artist = dashMatch[1].trim();
        if (dashMatch[1].trim().toLowerCase() === artist.toLowerCase()) title = dashMatch[2].trim();
      }
      return res.json({ title, artist });
    }

    if (inputUrl.includes('melon.com')) {
      const m = inputUrl.match(/[?&]songId=(\d+)/);
      if (!m) return res.json({});
      const resp = await axios.get('https://www.melon.com/song/detail.htm', {
        params: { songId: m[1] },
        headers: MELON_HEADERS,
      });
      const $ = cheerio.load(resp.data);
      const ogTitle = $('meta[property="og:title"]').attr('content') || '';
      const [title, artist] = ogTitle.split(' - ').map(s => (s || '').trim());
      return res.json({ title: title || '', artist: artist || '' });
    }

    if (inputUrl.includes('music-flo.com') || inputUrl.includes('flomuz.io')) {
      const resolvedUrl = await resolveFloUrl(inputUrl);
      const m = resolvedUrl.match(/\/detail\/track\/(\d+)/);
      if (!m) return res.json({});
      const resp = await axios.get(`https://www.music-flo.com/api/meta/v1/track/${m[1]}`, { headers: FLO_HEADERS });
      const track = resp.data?.data;
      if (!track) return res.json({});
      return res.json({
        title: track.name || '',
        artist: track.representationArtist?.name || track.artistList?.[0]?.name || '',
      });
    }

    if (inputUrl.includes('genie.co.kr')) {
      const resp = await axios.get(inputUrl, { headers: GENIE_HEADERS, maxRedirects: 5 });
      const $ = cheerio.load(resp.data);
      const ogTitle = $('meta[property="og:title"]').attr('content') || '';
      const m = ogTitle.match(/^(.*)\s*-\s*genie$/i);
      if (!m) return res.json({});
      const [title, artist] = m[1].split(' / ').map(s => (s || '').trim());
      return res.json({ title: title || '', artist: artist || '' });
    }

    return res.json({});
  } catch (err) {
    console.error('Meta song error:', err.response?.status, err.message);
    return res.json({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
