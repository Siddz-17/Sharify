require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const fs = require('fs');
const QRCode = require('qrcode');

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  REDIRECT_URI,
  PORT = 8888,
  SESSION_SECRET: ENV_SESSION_SECRET,
} = process.env;
const SESSION_SECRET = ENV_SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!ENV_SESSION_SECRET) console.warn('SESSION_SECRET not set: using a random one (logins reset on every restart).');
const ytm = require('./ytmusic');

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !REDIRECT_URI) {
  console.error(
    '\nMissing required env vars. Copy .env.example to .env and fill in SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI.\n'
  );
  process.exit(1);
}

const {
  JSONBIN_BIN_ID,
  JSONBIN_API_KEY,
  DATABASE_PATH,
} = process.env;

const dbPath = DATABASE_PATH || path.join(__dirname, 'db.json');

// --- Helper for Unique Friend Codes ---
function generateFriendCode(name = '') {
  const prefix = (name.replace(/[^a-zA-Z]/g, '').slice(0, 4) || 'SHAR').toUpperCase();
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${randomDigits}`;
}

// --- Cloud / Local Data Storage Engine ---
async function getDbData() {
  let data = { users: [], messages: [], rooms: [] };

  if (JSONBIN_BIN_ID && JSONBIN_API_KEY) {
    try {
      const res = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY },
      });
      const record = res.data.record || {};
      data.users = record.users || record.friends || [];
      data.messages = record.messages || [];
      data.rooms = record.rooms || [];
    } catch (err) {
      console.error('Failed to read from JSONbin, falling back to local:', err.response?.data || err.message);
    }
  } else {
    try {
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        data.users = parsed.users || parsed.friends || [];
        data.messages = parsed.messages || [];
        data.rooms = parsed.rooms || [];
      }
    } catch (err) {
      console.error('Failed to read local DB:', err.message);
    }
  }

  // Ensure default rooms exist if empty
  if (!Array.isArray(data.rooms) || !data.rooms.length) {
    data.rooms = [{ id: 'group', name: 'Group Lounge', createdBy: 'system' }];
  }

  // Ensure default structure on every user record
  data.users = data.users.map((u) => ({
    spotifyId: u.spotifyId,
    name: u.name || 'User',
    spotifyProfileName: u.spotifyProfileName || u.name || 'User',
    avatarUrl: u.avatarUrl || '',
    hasCustomAvatar: u.hasCustomAvatar || false,
    friendCode: u.friendCode || generateFriendCode(u.name),
    friends: Array.isArray(u.friends) ? u.friends : [],
    friendRequestsReceived: Array.isArray(u.friendRequestsReceived) ? u.friendRequestsReceived : [],
    friendRequestsSent: Array.isArray(u.friendRequestsSent) ? u.friendRequestsSent : [],
    statusMessage: u.statusMessage || '',
    statusEmoji: u.statusEmoji || '\uD83C\uDFA7',
    accessToken: u.accessToken,
    refreshToken: u.refreshToken,
    expiresAt: u.expiresAt || 0,
    source: u.source || 'spotify',
    ytAuthEnc: u.ytAuthEnc || '',
    topArtists: u.topArtists || [],
    topGenres: u.topGenres || [],
    createdAt: u.createdAt || new Date().toISOString(),
    banned: u.banned || false,
  }));

  return data;
}

async function saveDbData(data) {
  if (JSONBIN_BIN_ID && JSONBIN_API_KEY) {
    try {
      await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, data, {
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_API_KEY,
        },
      });
      return;
    } catch (err) {
      console.error('Failed to write to JSONbin, falling back to local:', err.response?.data || err.message);
    }
  }

  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write local DB:', err.message);
  }
}

// --- App and Socket.IO Initialization ---
const app = express();
// Safari & Proxy Compatibility
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'], // Allow polling fallback for Safari
});

app.use(express.json());

// Safari ITP & HTTPS friendly cookie session
app.use(
  cookieSession({
    name: 'sharify_session',
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax', // Essential for OAuth redirects in Safari
    httpOnly: true,
  })
);

// Bypass Localtunnel reminder headers for Safari
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Extended Spotify Scopes
const SCOPES = [
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-top-read',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-email',
].join(' ');

// --- Spotify Token Refresh Helper ---
async function ensureFreshToken(user) {
  if (user.source === 'ytmusic') throw new Error('Not available for YT Music users');
  if (Date.now() < (user.expiresAt || 0) - 30_000 && user.accessToken) {
    return user.accessToken;
  }
  if (!user.refreshToken) {
    throw new Error('No refresh token available');
  }

  const tokenRes = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.refreshToken,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );

  const { access_token, expires_in, refresh_token: new_refresh } = tokenRes.data;
  const data = await getDbData();
  const idx = data.users.findIndex((u) => u.spotifyId === user.spotifyId);
  if (idx > -1) {
    data.users[idx].accessToken = access_token;
    data.users[idx].expiresAt = Date.now() + expires_in * 1000;
    if (new_refresh) {
      data.users[idx].refreshToken = new_refresh;
    }
    await saveDbData(data);
  }
  return access_token;
}

// Fetch and cache user top taste (top artists & genres)
async function fetchUserTaste(accessToken) {
  try {
    const res = await axios.get('https://api.spotify.com/v1/me/top/artists?limit=20&time_range=medium_term', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const items = res.data.items || [];
    const topArtists = items.map((a) => a.name);
    const genresSet = new Set();
    items.forEach((a) => {
      if (Array.isArray(a.genres)) {
        a.genres.forEach((g) => genresSet.add(g));
      }
    });
    return { topArtists, topGenres: Array.from(genresSet).slice(0, 20) };
  } catch (err) {
    console.error('Failed to fetch user top taste:', err.message);
    return { topArtists: [], topGenres: [] };
  }
}

// --- Auth Routes ---
app.get('/login', (req, res) => {
  const displayName = (req.query.name || '').trim();
  const ref = (req.query.ref || '').trim();
  const state = crypto.randomBytes(16).toString('hex');

  req.session.oauthState = state;
  req.session.pendingName = displayName;
  req.session.pendingRef = ref;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: 'true',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Spotify error: ${error}`);
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('State mismatch — please try connecting again.');
  }

  const displayNameFromLogin = req.session.pendingName || '';
  const refCode = req.session.pendingRef || '';

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const spotifyId = profileRes.data.id;
    const spotifyProfileName = profileRes.data.display_name || 'Spotify Friend';
    const avatarUrl = profileRes.data.images?.[0]?.url || '';

    // Fetch initial top taste
    const { topArtists, topGenres } = await fetchUserTaste(access_token);

    const data = await getDbData();
    let userIndex = data.users.findIndex((u) => u.spotifyId === spotifyId);

    let friendCode = generateFriendCode(displayNameFromLogin || spotifyProfileName);

    if (userIndex > -1) {
      const existing = data.users[userIndex];
      existing.name = displayNameFromLogin || existing.name || spotifyProfileName;
      existing.spotifyProfileName = spotifyProfileName;
      // Only update avatar from Spotify if the user hasn't set a custom one
      if (!existing.hasCustomAvatar) existing.avatarUrl = avatarUrl || existing.avatarUrl;
      existing.accessToken = access_token;
      if (refresh_token) existing.refreshToken = refresh_token;
      existing.expiresAt = Date.now() + expires_in * 1000;
      if (topArtists.length) existing.topArtists = topArtists;
      if (topGenres.length) existing.topGenres = topGenres;
      friendCode = existing.friendCode;
    } else {
      const newUser = {
        spotifyId,
        name: displayNameFromLogin || spotifyProfileName,
        spotifyProfileName,
        avatarUrl,
        friendCode,
        friends: [],
        friendRequestsReceived: [],
        friendRequestsSent: [],
        statusMessage: 'Just joined Sharify! 🎧',
        statusEmoji: '✨',
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
        topArtists,
        topGenres,
        createdAt: new Date().toISOString(),
      };
      data.users.push(newUser);
      userIndex = data.users.length - 1;
    }

    if (refCode) {
      const referringUser = data.users.find(
        (u) => u.friendCode.toLowerCase() === refCode.toLowerCase() || u.spotifyId === refCode
      );
      if (referringUser && referringUser.spotifyId !== spotifyId) {
        if (!referringUser.friends.includes(spotifyId)) {
          referringUser.friends.push(spotifyId);
        }
        if (!data.users[userIndex].friends.includes(referringUser.spotifyId)) {
          data.users[userIndex].friends.push(referringUser.spotifyId);
        }
      }
    }

    await saveDbData(data);

    // Ban check — prevent banned users from getting a session
    if (data.users[userIndex].banned) {
      return res.status(403).send('Your access to Sharify has been restricted. Contact the admin.');
    }

    req.session.spotifyId = spotifyId;
    req.session.displayName = data.users[userIndex].name;

    res.redirect(`/?connected=${encodeURIComponent(data.users[userIndex].name)}&userId=${encodeURIComponent(spotifyId)}`);
  } catch (err) {
    console.error('Error during Spotify Auth callback:', err.response?.data || err.message);
    res.status(500).json({ message: 'Something went wrong connecting to Spotify. Please try again.' });
  }
});

// --- Logout ---
app.get('/logout', (req, res) => {
  req.session = null; // cookie-session: setting to null clears the cookie
  res.redirect('/');
});

// Helper to get active user from session or header
async function getAuthenticatedUser(req) {
  const data = await getDbData();
  const sessionSpotifyId = req.session?.spotifyId;
  if (!sessionSpotifyId) return null;
  const user = data.users.find((u) => u.spotifyId === sessionSpotifyId) || null;
  if (user?.banned) return null; // banned users are treated as unauthenticated
  return user;
}

// --- Current User Profile & Friends Endpoint ---
app.get('/api/me', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const data = await getDbData();

    const friendsDetails = data.users
      .filter((u) => user.friends.includes(u.spotifyId))
      .map((u) => ({
        spotifyId: u.spotifyId,
        name: u.name,
        avatarUrl: u.avatarUrl,
        friendCode: u.friendCode,
        statusMessage: u.statusMessage,
        statusEmoji: u.statusEmoji,
      }));

    const receivedRequests = user.friendRequestsReceived.map((reqItem) => {
      const sender = data.users.find((u) => u.spotifyId === reqItem.fromSpotifyId);
      return {
        spotifyId: reqItem.fromSpotifyId,
        name: sender?.name || reqItem.fromName || 'User',
        avatarUrl: sender?.avatarUrl || reqItem.avatarUrl || '',
        friendCode: sender?.friendCode || '',
        timestamp: reqItem.timestamp,
      };
    });

    // Include linked YT Music account info if this is a Spotify session with a linked YT account
    const linkedYtId = req.session?.linkedYtId;
    let linkedYtAccount = null;
    if (linkedYtId) {
      const ytUser = data.users.find((u) => u.spotifyId === linkedYtId);
      if (ytUser) linkedYtAccount = {
        spotifyId: ytUser.spotifyId,
        name: ytUser.name,
        source: 'ytmusic',
        avatarUrl: ytUser.avatarUrl || '',
        friendCode: ytUser.friendCode || '',
        statusEmoji: ytUser.statusEmoji || '🎵',
        statusMessage: ytUser.statusMessage || '',
      };
    }

    res.json({
      spotifyId: user.spotifyId,
      name: user.name,
      spotifyProfileName: user.spotifyProfileName,
      avatarUrl: user.avatarUrl,
      friendCode: user.friendCode,
      statusMessage: user.statusMessage,
      statusEmoji: user.statusEmoji,
      source: user.source || 'spotify',
      friends: friendsDetails,
      friendRequestsReceived: receivedRequests,
      friendRequestsSent: user.friendRequestsSent,
      totalUsersCount: data.users.length,
      linkedYtAccount,
    });
  } catch (err) {
    console.error('Error fetching current user profile:', err);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update Status / Mood
app.put('/api/user/status', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { statusMessage, statusEmoji } = req.body;
    const data = await getDbData();
    const idx = data.users.findIndex((u) => u.spotifyId === user.spotifyId);
    if (idx > -1) {
      data.users[idx].statusMessage = (statusMessage || '').trim().slice(0, 100);
      data.users[idx].statusEmoji = (statusEmoji || '🎧').trim().slice(0, 10);
      await saveDbData(data);

      io.emit('user_status_changed', {
        spotifyId: user.spotifyId,
        statusMessage: data.users[idx].statusMessage,
        statusEmoji: data.users[idx].statusEmoji,
      });

      const { accessToken, refreshToken, ytAuthEnc, ...safeUser } = data.users[idx];
      return res.json({ success: true, user: safeUser });
    }
    res.status(404).json({ error: 'User not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Status for the linked YT Music account independently
app.put('/api/user/linked/status', async (req, res) => {
  try {
    const linkedYtId = req.session?.linkedYtId;
    if (!req.session?.spotifyId) return res.status(401).json({ error: 'Not authenticated' });
    if (!linkedYtId) return res.status(400).json({ error: 'No linked YT Music account' });

    const { statusMessage, statusEmoji } = req.body;
    const data = await getDbData();
    const idx = data.users.findIndex((u) => u.spotifyId === linkedYtId);
    if (idx === -1) return res.status(404).json({ error: 'Linked account not found' });

    data.users[idx].statusMessage = (statusMessage || '').trim().slice(0, 100);
    data.users[idx].statusEmoji = (statusEmoji || '🎵').trim().slice(0, 10);
    await saveDbData(data);

    io.emit('user_status_changed', {
      spotifyId: linkedYtId,
      statusMessage: data.users[idx].statusMessage,
      statusEmoji: data.users[idx].statusEmoji,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Update Avatar ---
app.post('/api/user/avatar', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { type, data: imgData, url } = req.body;
    let newAvatarUrl = '';

    if (type === 'url') {
      if (!/^https?:\/\/.+/i.test(url || '')) return res.status(400).json({ error: 'Invalid URL — must start with http(s)://' });
      newAvatarUrl = url.trim();
    } else if (type === 'upload') {
      // imgData is a base64 data URL: "data:image/jpeg;base64,..."
      const match = (imgData || '').match(/^data:(image\/(jpeg|png|gif|webp));base64,(.+)$/s);
      if (!match) return res.status(400).json({ error: 'Invalid image data.' });
      const mime = match[1], ext = match[2], b64 = match[3];
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 2_097_152) return res.status(400).json({ error: 'Image too large — max 2 MB.' });

      const uploadDir = path.join(__dirname, 'public', 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      // One file per user — overwrites old custom avatar automatically
      const filename = `avatar_${user.spotifyId.replace(/[^a-z0-9]/gi, '_')}.${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), buf);
      newAvatarUrl = `/uploads/${filename}`;
    } else {
      return res.status(400).json({ error: 'type must be "url" or "upload"' });
    }

    const dbData = await getDbData();
    const idx = dbData.users.findIndex((u) => u.spotifyId === user.spotifyId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    dbData.users[idx].avatarUrl = newAvatarUrl;
    dbData.users[idx].hasCustomAvatar = true;
    await saveDbData(dbData);

    res.json({ success: true, avatarUrl: newAvatarUrl });
  } catch (err) {
    console.error('Avatar update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Selective Friend Feed Endpoint ---
app.get('/api/feed', async (req, res) => {
  try {
    const data = await getDbData();
    const currentUser = await getAuthenticatedUser(req);

    let targetUsers = [];
    if (currentUser) {
      const friendIds = new Set(currentUser.friends);
      friendIds.add(currentUser.spotifyId);
      // Also show the linked YT Music account side-by-side in the same feed
      const linkedYtId = req.session?.linkedYtId;
      if (linkedYtId) friendIds.add(linkedYtId);
      targetUsers = data.users.filter((u) => friendIds.has(u.spotifyId));
    } else {
      targetUsers = data.users.slice(0, 10);
    }

    const feedResults = await Promise.all(
      targetUsers.map(async (user) => {
        if (user.source === 'ytmusic') return ytm.getCard(user);
        try {
          const token = await ensureFreshToken(user);
          const nowPlayingRes = await axios.get(
            'https://api.spotify.com/v1/me/player/currently-playing',
            {
              headers: { Authorization: `Bearer ${token}` },
              validateStatus: (s) => s === 200 || s === 204,
            }
          );

          if (nowPlayingRes.status === 204 || !nowPlayingRes.data?.item) {
            try {
              const recentRes = await axios.get(
                'https://api.spotify.com/v1/me/player/recently-played?limit=1',
                { headers: { Authorization: `Bearer ${token}` } }
              );
              const recentItem = recentRes.data?.items?.[0];
              if (recentItem && recentItem.track) {
                const track = recentItem.track;
                return {
                  spotifyId: user.spotifyId,
                  name: user.name,
                  avatarUrl: user.avatarUrl,
                  friendCode: user.friendCode,
                  statusMessage: user.statusMessage,
                  statusEmoji: user.statusEmoji,
                  playing: false,
                  lastPlayed: true,
                  playedAt: recentItem.played_at,
                  track: track.name,
                  artists: track.artists.map((a) => a.name).join(', '),
                  album: track.album?.name,
                  albumArt: track.album?.images?.[0]?.url,
                  spotifyUrl: track.external_urls?.spotify,
                  uri: track.uri,
                  previewUrl: track.preview_url,
                };
              }
            } catch (recentErr) {
              // Ignore
            }

            return {
              spotifyId: user.spotifyId,
              name: user.name,
              avatarUrl: user.avatarUrl,
              friendCode: user.friendCode,
              statusMessage: user.statusMessage,
              statusEmoji: user.statusEmoji,
              playing: false,
              lastPlayed: false,
            };
          }

          const item = nowPlayingRes.data.item;
          return {
            spotifyId: user.spotifyId,
            name: user.name,
            avatarUrl: user.avatarUrl,
            friendCode: user.friendCode,
            statusMessage: user.statusMessage,
            statusEmoji: user.statusEmoji,
            playing: nowPlayingRes.data.is_playing,
            track: item.name,
            artists: item.artists.map((a) => a.name).join(', '),
            album: item.album?.name,
            albumArt: item.album?.images?.[0]?.url,
            progressMs: nowPlayingRes.data.progress_ms,
            durationMs: item.duration_ms,
            spotifyUrl: item.external_urls?.spotify,
            uri: item.uri,
            previewUrl: item.preview_url,
            timestamp: Date.now(),
          };
        } catch (err) {
          console.error(`Feed fetch error for ${user.name}:`, err.message);
          return {
            spotifyId: user.spotifyId,
            name: user.name,
            avatarUrl: user.avatarUrl,
            friendCode: user.friendCode,
            statusMessage: user.statusMessage,
            statusEmoji: user.statusEmoji,
            playing: false,
            error: true,
          };
        }
      })
    );

    res.json(feedResults);
  } catch (err) {
    console.error('Error constructing selective feed:', err);
    res.status(500).json({ error: 'Failed to generate feed' });
  }
});


// --- Device Sign-in Token Store (in-memory, single-use, 10-min TTL) ---
const deviceTokens = new Map(); // token -> { spotifyId, expiresAt }

// Issue a one-time device sign-in token for the currently logged-in session
app.post('/api/auth/device-token', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Clean up expired tokens
    const now = Date.now();
    for (const [tok, val] of deviceTokens) {
      if (val.expiresAt < now) deviceTokens.delete(tok);
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes
    deviceTokens.set(token, { spotifyId: user.spotifyId, expiresAt });

    const link = `${req.protocol}://${req.get('host')}/auth/device?token=${token}`;
    res.json({ token, link, expiresAt });
  } catch (err) {
    console.error('Device token error:', err.message);
    res.status(500).json({ error: 'Failed to generate device token' });
  }
});

// Redeem a device sign-in token — called by the phone/new browser
app.get('/auth/device', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token.');

    const record = deviceTokens.get(token);
    if (!record) return res.status(410).send('This sign-in link has already been used or has expired. Ask for a new one from the logged-in device.');
    if (record.expiresAt < Date.now()) {
      deviceTokens.delete(token);
      return res.status(410).send('This sign-in link has expired (10-minute limit). Ask for a new one from the logged-in device.');
    }

    // Consume the token (single-use)
    deviceTokens.delete(token);

    const data = await getDbData();
    const user = data.users.find((u) => u.spotifyId === record.spotifyId);
    if (!user) return res.status(404).send('Account not found. The original session may have been deleted.');

    req.session.spotifyId = user.spotifyId;
    req.session.displayName = user.name;

    res.redirect(`/?connected=${encodeURIComponent(user.name)}&userId=${encodeURIComponent(user.spotifyId)}`);
  } catch (err) {
    console.error('Device auth error:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// --- YouTube Music: connect / reconnect / disconnect ---
const ytAttempts = new Map();
function ytRateLimited(ip) {
  const now = Date.now();
  const hits = (ytAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  ytAttempts.set(ip, hits);
  return hits.length > 5;
}

app.post('/api/ytmusic/connect', async (req, res) => {
  try {
    if (!ytm.enabled) return res.status(503).json({ error: 'YT Music is not enabled on this server.' });
    if (ytRateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });

    const name = String(req.body.name || '').trim().slice(0, 30);
    const ref = String(req.body.ref || '').trim();
    const result = await ytm.connect(req.body.headers);
    if (!result.ok) {
      return res.status(400).json({ error: "Couldn't log in to YT Music with those headers. Copy a fresh request from music.youtube.com while logged in." });
    }

    const data = await getDbData();
    const sessionId = req.session?.spotifyId;
    const sessionUser = sessionId ? data.users.find((u) => u.spotifyId === sessionId) : null;

    // --- Case A: Already logged in as a Spotify user → link YT as a second account ---
    if (sessionUser && sessionUser.source === 'spotify') {
      const linkedYtId = req.session.linkedYtId;

      // Find existing linked YT account (reconnect) or by name (duplicate guard)
      let ytIdx = linkedYtId ? data.users.findIndex((u) => u.spotifyId === linkedYtId) : -1;
      if (ytIdx === -1 && name) {
        ytIdx = data.users.findIndex(
          (u) => u.source === 'ytmusic' && u.name.toLowerCase() === name.toLowerCase()
        );
      }

      if (ytIdx > -1) {
        data.users[ytIdx].ytAuthEnc = result.authEnc;
      } else {
        if (!name) return res.status(400).json({ error: 'Please enter a display name for your YT Music account.' });
        const id = 'yt_' + crypto.randomBytes(8).toString('hex');
        data.users.push({
          spotifyId: id, name, spotifyProfileName: name, avatarUrl: '',
          friendCode: generateFriendCode(name), friends: [], friendRequestsReceived: [], friendRequestsSent: [],
          statusMessage: 'Also on YT Music 🎧', statusEmoji: '🎶',
          source: 'ytmusic', ytAuthEnc: result.authEnc, topArtists: [], topGenres: [],
          createdAt: new Date().toISOString(),
        });
        ytIdx = data.users.length - 1;
      }

      await saveDbData(data);
      const ytUser = data.users[ytIdx];
      ytm.seed(ytUser.spotifyId, result.item);
      // Keep the Spotify session intact; just add the YT account as secondary
      req.session.linkedYtId = ytUser.spotifyId;
      return res.json({ success: true, linked: true, userId: ytUser.spotifyId, ytName: ytUser.name });
    }

    // --- Case B: Not logged in, or already a YT-only session ---
    // Priority 1: Existing YT Music user from session (reconnect credentials)
    let idx = data.users.findIndex((u) => u.spotifyId === sessionId && u.source === 'ytmusic');

    if (idx > -1) {
      // Reconnect: update credentials only
      data.users[idx].ytAuthEnc = result.authEnc;
    } else {
      // New standalone YT Music user — name is required
      if (!name) return res.status(400).json({ error: 'Please enter your name.' });

      // Duplicate-login guard
      const dupIdx = data.users.findIndex(
        (u) => u.source === 'ytmusic' && u.name.toLowerCase() === name.toLowerCase()
      );
      if (dupIdx > -1) {
        data.users[dupIdx].ytAuthEnc = result.authEnc;
        idx = dupIdx;
      } else {
        const id = 'yt_' + crypto.randomBytes(8).toString('hex');
        data.users.push({
          spotifyId: id, name, spotifyProfileName: name, avatarUrl: '',
          friendCode: generateFriendCode(name), friends: [], friendRequestsReceived: [], friendRequestsSent: [],
          statusMessage: 'Just joined Sharify! 🎧', statusEmoji: '✨',
          source: 'ytmusic', ytAuthEnc: result.authEnc, topArtists: [], topGenres: [],
          createdAt: new Date().toISOString(),
        });
        idx = data.users.length - 1;
        if (ref) {
          const referrer = data.users.find((u) => u.friendCode.toLowerCase() === ref.toLowerCase() || u.spotifyId === ref);
          if (referrer) {
            if (!referrer.friends.includes(data.users[idx].spotifyId)) referrer.friends.push(data.users[idx].spotifyId);
            data.users[idx].friends.push(referrer.spotifyId);
          }
        }
      }
    }

    await saveDbData(data);
    const user = data.users[idx];
    ytm.seed(user.spotifyId, result.item);
    req.session.spotifyId = user.spotifyId;
    req.session.displayName = user.name;
    res.json({ success: true, userId: user.spotifyId });
  } catch (err) {
    console.error('YT connect error:', err.message);
    res.status(500).json({ error: 'Something went wrong connecting YT Music.' });
  }
});

// Unlink the secondary YT Music account from a Spotify session
app.delete('/api/ytmusic/unlink', async (req, res) => {
  const linkedYtId = req.session?.linkedYtId;
  if (!linkedYtId) return res.status(400).json({ error: 'No linked YT Music account.' });
  // Wipe the credentials so the YT poller stops for this account
  const data = await getDbData();
  const u = data.users.find((x) => x.spotifyId === linkedYtId);
  if (u) { u.ytAuthEnc = ''; await saveDbData(data); }
  ytm.forget(linkedYtId);
  req.session.linkedYtId = null;
  res.json({ success: true });
});

app.delete('/api/ytmusic/credentials', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user || user.source !== 'ytmusic') return res.status(401).json({ error: 'Not authenticated' });
  const data = await getDbData();
  const u = data.users.find((x) => x.spotifyId === user.spotifyId);
  u.ytAuthEnc = '';
  await saveDbData(data);
  ytm.forget(user.spotifyId);
  res.json({ success: true });
});

app.get('/api/friends', (req, res) => {
  res.redirect('/api/feed');
});

// --- Friend Request & Search Management ---
app.get('/api/friends/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim().toLowerCase();
    if (!query) return res.json([]);

    const currentUser = await getAuthenticatedUser(req);
    const data = await getDbData();

    const matches = data.users
      .filter((u) => {
        if (currentUser && u.spotifyId === currentUser.spotifyId) return false;
        return (
          u.name.toLowerCase().includes(query) ||
          u.friendCode.toLowerCase() === query ||
          u.spotifyProfileName.toLowerCase().includes(query)
        );
      })
      .map((u) => {
        let friendshipStatus = 'none';
        if (currentUser) {
          if (currentUser.friends.includes(u.spotifyId)) {
            friendshipStatus = 'friend';
          } else if (currentUser.friendRequestsSent.includes(u.spotifyId)) {
            friendshipStatus = 'pending_sent';
          } else if (currentUser.friendRequestsReceived.some((r) => r.fromSpotifyId === u.spotifyId)) {
            friendshipStatus = 'pending_received';
          }
        }
        return {
          spotifyId: u.spotifyId,
          name: u.name,
          avatarUrl: u.avatarUrl,
          friendCode: u.friendCode,
          statusMessage: u.statusMessage,
          statusEmoji: u.statusEmoji,
          friendshipStatus,
        };
      });

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send Friend Request
app.post('/api/friends/request', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { targetSpotifyId, friendCode } = req.body;
    const data = await getDbData();

    const targetUser = data.users.find(
      (u) =>
        (targetSpotifyId && u.spotifyId === targetSpotifyId) ||
        (friendCode && u.friendCode.toLowerCase() === friendCode.toLowerCase())
    );

    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.spotifyId === currentUser.spotifyId) {
      return res.status(400).json({ error: 'You cannot add yourself as a friend' });
    }

    const currentIdx = data.users.findIndex((u) => u.spotifyId === currentUser.spotifyId);
    const targetIdx = data.users.findIndex((u) => u.spotifyId === targetUser.spotifyId);

    if (data.users[currentIdx].friends.includes(targetUser.spotifyId)) {
      return res.status(400).json({ error: 'Already friends' });
    }

    if (!data.users[currentIdx].friendRequestsSent.includes(targetUser.spotifyId)) {
      data.users[currentIdx].friendRequestsSent.push(targetUser.spotifyId);
    }

    const exists = data.users[targetIdx].friendRequestsReceived.some(
      (r) => r.fromSpotifyId === currentUser.spotifyId
    );
    if (!exists) {
      data.users[targetIdx].friendRequestsReceived.push({
        fromSpotifyId: currentUser.spotifyId,
        fromName: currentUser.name,
        avatarUrl: currentUser.avatarUrl,
        timestamp: new Date().toISOString(),
      });
    }

    await saveDbData(data);

    io.emit(`friend_request_${targetUser.spotifyId}`, {
      fromSpotifyId: currentUser.spotifyId,
      fromName: currentUser.name,
      avatarUrl: currentUser.avatarUrl,
    });

    res.json({ success: true, message: `Friend request sent to ${targetUser.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept Friend Request
app.post('/api/friends/accept', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { targetSpotifyId } = req.body;
    const data = await getDbData();

    const currentIdx = data.users.findIndex((u) => u.spotifyId === currentUser.spotifyId);
    const targetIdx = data.users.findIndex((u) => u.spotifyId === targetSpotifyId);

    if (targetIdx === -1) return res.status(404).json({ error: 'Target user not found' });

    if (!data.users[currentIdx].friends.includes(targetSpotifyId)) {
      data.users[currentIdx].friends.push(targetSpotifyId);
    }
    if (!data.users[targetIdx].friends.includes(currentUser.spotifyId)) {
      data.users[targetIdx].friends.push(currentUser.spotifyId);
    }

    data.users[currentIdx].friendRequestsReceived = data.users[currentIdx].friendRequestsReceived.filter(
      (r) => r.fromSpotifyId !== targetSpotifyId
    );
    data.users[targetIdx].friendRequestsSent = data.users[targetIdx].friendRequestsSent.filter(
      (id) => id !== currentUser.spotifyId
    );

    await saveDbData(data);

    io.emit(`friend_accepted_${targetSpotifyId}`, { newFriendId: currentUser.spotifyId, name: currentUser.name });
    io.emit(`friend_accepted_${currentUser.spotifyId}`, { newFriendId: targetSpotifyId, name: data.users[targetIdx].name });

    res.json({ success: true, message: `Now friends with ${data.users[targetIdx].name}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject / Cancel Friend Request
app.post('/api/friends/reject', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { targetSpotifyId } = req.body;
    const data = await getDbData();

    const currentIdx = data.users.findIndex((u) => u.spotifyId === currentUser.spotifyId);
    const targetIdx = data.users.findIndex((u) => u.spotifyId === targetSpotifyId);

    if (currentIdx > -1) {
      data.users[currentIdx].friendRequestsReceived = data.users[currentIdx].friendRequestsReceived.filter(
        (r) => r.fromSpotifyId !== targetSpotifyId
      );
    }
    if (targetIdx > -1) {
      data.users[targetIdx].friendRequestsSent = data.users[targetIdx].friendRequestsSent.filter(
        (id) => id !== currentUser.spotifyId
      );
    }

    await saveDbData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect / Remove Friend Connection
app.delete('/api/friends/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const currentUser = await getAuthenticatedUser(req);
    const data = await getDbData();

    const adminKeyHeader = req.headers['x-admin-key'];
    const expectedAdminKey = process.env.ADMIN_KEY || 'siddharth-admin-default';
    const isSuperAdmin = adminKeyHeader === expectedAdminKey;

    if (isSuperAdmin) {
      data.users = data.users.filter((u) => u.spotifyId !== id);
      data.users.forEach((u) => {
        u.friends = u.friends.filter((fId) => fId !== id);
        u.friendRequestsSent = u.friendRequestsSent.filter((fId) => fId !== id);
        u.friendRequestsReceived = u.friendRequestsReceived.filter((r) => r.fromSpotifyId !== id);
      });
      await saveDbData(data);
      return res.json({ success: true, message: 'User removed by Super Admin' });
    }

    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const currentIdx = data.users.findIndex((u) => u.spotifyId === currentUser.spotifyId);
    const targetIdx = data.users.findIndex((u) => u.spotifyId === id);

    if (currentIdx > -1) {
      data.users[currentIdx].friends = data.users[currentIdx].friends.filter((fId) => fId !== id);
    }
    if (targetIdx > -1) {
      data.users[targetIdx].friends = data.users[targetIdx].friends.filter((fId) => fId !== currentUser.spotifyId);
    }

    await saveDbData(data);
    res.json({ success: true, message: 'Friend removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Listen Along & Playback Remote Controls ---
app.post('/api/playback/sync', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { targetSpotifyId } = req.body;
    const data = await getDbData();
    const targetUser = data.users.find((u) => u.spotifyId === targetSpotifyId);

    if (!targetUser) return res.status(404).json({ error: 'Friend not found' });

    const targetToken = await ensureFreshToken(targetUser);
    const targetPlayingRes = await axios.get(
      'https://api.spotify.com/v1/me/player/currently-playing',
      {
        headers: { Authorization: `Bearer ${targetToken}` },
        validateStatus: (s) => s === 200 || s === 204,
      }
    );

    if (targetPlayingRes.status === 204 || !targetPlayingRes.data?.item) {
      return res.status(400).json({ error: `${targetUser.name} is not currently playing anything.` });
    }

    const targetItem = targetPlayingRes.data.item;
    const positionMs = targetPlayingRes.data.progress_ms || 0;
    const trackUri = targetItem.uri;

    const userToken = await ensureFreshToken(currentUser);
    try {
      await axios.put(
        'https://api.spotify.com/v1/me/player/play',
        {
          uris: [trackUri],
          position_ms: positionMs,
        },
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return res.json({
        success: true,
        message: `Now syncing and playing "${targetItem.name}" with ${targetUser.name}!`,
        track: targetItem.name,
      });
    } catch (playErr) {
      if (playErr.response?.status === 404) {
        return res.status(404).json({
          error: 'No active Spotify device found. Please open Spotify on your phone/PC and hit play once!',
        });
      }
      if (playErr.response?.status === 403) {
        return res.status(403).json({
          error: 'Spotify Premium is required for remote playback control.',
        });
      }
      throw playErr;
    }
  } catch (err) {
    console.error('Error during playback sync:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Add Track to Spotify Queue
app.post('/api/playback/queue', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'Track URI required' });

    const userToken = await ensureFreshToken(currentUser);
    try {
      await axios.post(
        `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
        null,
        {
          headers: { Authorization: `Bearer ${userToken}` },
        }
      );
      res.json({ success: true, message: 'Track added to your Spotify queue!' });
    } catch (queueErr) {
      if (queueErr.response?.status === 404) {
        return res.status(404).json({
          error: 'No active Spotify player found. Open Spotify first!',
        });
      }
      throw queueErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// --- QR Code Generator Endpoint ---
app.get('/api/qr', async (req, res) => {
  try {
    const text = req.query.text || `${req.protocol}://${req.get('host')}`;
    const qrDataUrl = await QRCode.toDataURL(text, {
      margin: 2,
      width: 280,
      color: {
        dark: '#1db954',
        light: '#090b0f',
      },
    });
    res.json({ dataUrl: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Taste Match & Blend Endpoints ---
app.get('/api/taste-match/:friendId', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { friendId } = req.params;
    const data = await getDbData();
    const friend = data.users.find((u) => u.spotifyId === friendId);
    if (!friend) return res.status(404).json({ error: 'Friend not found' });

    if (!currentUser.topArtists.length) {
      const token = await ensureFreshToken(currentUser);
      const taste = await fetchUserTaste(token);
      currentUser.topArtists = taste.topArtists;
      currentUser.topGenres = taste.topGenres;
    }
    if (!friend.topArtists.length) {
      const token = await ensureFreshToken(friend);
      const taste = await fetchUserTaste(token);
      friend.topArtists = taste.topArtists;
      friend.topGenres = taste.topGenres;
    }

    const myArtists = new Set((currentUser.topArtists || []).map((a) => a.toLowerCase()));
    const friendArtists = new Set((friend.topArtists || []).map((a) => a.toLowerCase()));

    const sharedArtists = (currentUser.topArtists || []).filter((a) =>
      friendArtists.has(a.toLowerCase())
    );

    const myGenres = new Set((currentUser.topGenres || []).map((g) => g.toLowerCase()));
    const friendGenres = new Set((friend.topGenres || []).map((g) => g.toLowerCase()));

    const sharedGenres = (currentUser.topGenres || []).filter((g) =>
      friendGenres.has(g.toLowerCase())
    );

    const allUnique = new Set([...myArtists, ...friendArtists]);
    const artistScore = allUnique.size > 0 ? (sharedArtists.length / allUnique.size) * 100 : 50;

    const allUniqueGenres = new Set([...myGenres, ...friendGenres]);
    const genreScore = allUniqueGenres.size > 0 ? (sharedGenres.length / allUniqueGenres.size) * 100 : 50;

    const finalMatchPercent = Math.min(
      99,
      Math.max(42, Math.round(artistScore * 0.6 + genreScore * 0.4 + (sharedArtists.length > 0 ? 15 : 0)))
    );

    res.json({
      matchScore: finalMatchPercent,
      sharedArtists,
      sharedGenres,
      friendName: friend.name,
      friendAvatar: friend.avatarUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-create Spotify Blend Playlist
app.post('/api/blend/create', async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const { friendId } = req.body;
    const data = await getDbData();
    const friend = data.users.find((u) => u.spotifyId === friendId);
    if (!friend) return res.status(404).json({ error: 'Friend not found' });

    const userToken = await ensureFreshToken(currentUser);
    const friendToken = await ensureFreshToken(friend);

    const [userTracksRes, friendTracksRes] = await Promise.all([
      axios.get('https://api.spotify.com/v1/me/top/tracks?limit=10', {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
      axios.get('https://api.spotify.com/v1/me/top/tracks?limit=10', {
        headers: { Authorization: `Bearer ${friendToken}` },
      }),
    ]);

    const userTracks = userTracksRes.data?.items || [];
    const friendTracks = friendTracksRes.data?.items || [];

    const blendedUris = [];
    const maxLen = Math.max(userTracks.length, friendTracks.length);
    for (let i = 0; i < maxLen; i++) {
      if (userTracks[i]) blendedUris.push(userTracks[i].uri);
      if (friendTracks[i]) blendedUris.push(friendTracks[i].uri);
    }

    if (!blendedUris.length) {
      return res.status(400).json({ error: 'No tracks available to create blend' });
    }

    const createPlaylistRes = await axios.post(
      `https://api.spotify.com/v1/users/${currentUser.spotifyId}/playlists`,
      {
        name: `Sharify Blend: ${currentUser.name} + ${friend.name}`,
        description: `Generated by Sharify! A harmonious musical blend created on ${new Date().toLocaleDateString()}.`,
        public: true,
      },
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const playlist = createPlaylistRes.data;

    await axios.post(
      `https://api.spotify.com/v1/playlists/${playlist.id}/tracks`,
      { uris: blendedUris },
      {
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      success: true,
      playlistUrl: playlist.external_urls?.spotify,
      playlistName: playlist.name,
    });
  } catch (err) {
    console.error('Error creating Spotify Blend:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// --- Chat REST Fallback Endpoints ---
app.get('/api/chat/messages', async (req, res) => {
  try {
    const { roomId = 'group' } = req.query;
    const data = await getDbData();
    const roomMessages = (data.messages || [])
      .filter((m) => m.roomId === roomId || (!m.roomId && roomId === 'group'))
      .slice(-60);
    res.json(roomMessages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Custom Chat Rooms Endpoints ---
app.get('/api/rooms', async (req, res) => {
  try {
    const data = await getDbData();
    res.json(data.rooms || [{ id: 'group', name: 'Group Lounge', createdBy: 'system' }]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required' });

    const currentUser = await getAuthenticatedUser(req);
    if (!currentUser) return res.status(401).json({ error: 'Not authenticated' });

    const data = await getDbData();
    if (!data.rooms) data.rooms = [];

    const newRoom = {
      id: 'room_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      name: name.trim(),
      createdBy: currentUser.spotifyId,
      createdAt: new Date().toISOString()
    };

    data.rooms.push(newRoom);
    await saveDbData(data);

    // Broadcast new room creation to all connected sockets
    io.emit('new_room', newRoom);

    res.json(newRoom);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Socket.IO Real-time Engine ---
io.on('connection', (socket) => {
  socket.on('join_room', (roomId = 'group') => {
    socket.join(roomId);
  });

  socket.on('leave_room', (roomId = 'group') => {
    socket.leave(roomId);
  });

  socket.on('chat_message', async (msg) => {
    try {
      const { roomId = 'group', senderId, senderName, senderAvatar, text, sharedTrack } = msg;
      if (!senderId || (!text && !sharedTrack)) return;

      const messageRecord = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        roomId,
        senderId,
        senderName: senderName || 'Friend',
        senderAvatar: senderAvatar || '',
        text: (text || '').trim(),
        sharedTrack: sharedTrack || null,
        reactions: {},
        timestamp: new Date().toISOString(),
      };

      const data = await getDbData();
      if (!data.messages) data.messages = [];
      data.messages.push(messageRecord);
      if (data.messages.length > 500) {
        data.messages = data.messages.slice(-400);
      }
      await saveDbData(data);

      io.to(roomId).emit('new_message', messageRecord);
    } catch (err) {
      console.error('Socket chat error:', err);
    }
  });

  socket.on('typing_start', ({ roomId = 'group', senderName }) => {
    socket.to(roomId).emit('user_typing', { senderName, isTyping: true });
  });
  socket.on('typing_stop', ({ roomId = 'group', senderName }) => {
    socket.to(roomId).emit('user_typing', { senderName, isTyping: false });
  });

  socket.on('live_reaction', ({ targetSpotifyId, emoji, fromName }) => {
    io.emit('floating_reaction', {
      targetSpotifyId,
      emoji: emoji || '🔥',
      fromName: fromName || 'A friend',
      id: 'react_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
    });
  });
});

// ============================================================
// ADMIN DASHBOARD — gated by ADMIN_KEY
// ============================================================
const ADMIN_KEY = process.env.ADMIN_KEY || 'siddharth-admin-default';

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  const err = req.query.error ? '<p style="color:#f87171;font-size:0.85rem;margin-bottom:12px;">// INCORRECT KEY — TRY AGAIN</p>' : '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sharify Admin</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#fff;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;background-image:radial-gradient(rgba(255,255,255,0.04) 1px,transparent 1px);background-size:20px 20px}.box{border:1px solid #2a2a2a;padding:40px;max-width:360px;width:100%}h1{font-size:1rem;letter-spacing:.2em;margin-bottom:8px;text-transform:uppercase}p.sub{color:#555;font-size:.75rem;margin-bottom:28px;letter-spacing:.1em}input{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;color:#fff;padding:10px 14px;font-family:inherit;font-size:.85rem;letter-spacing:.1em;margin-bottom:14px;outline:none}input:focus{border-color:#fff}button{width:100%;background:#fff;color:#000;border:none;padding:11px;font-family:inherit;font-size:.8rem;font-weight:600;letter-spacing:.15em;text-transform:uppercase;cursor:pointer}button:hover{background:#e0e0e0}</style></head>
<body><div class="box"><h1>// SHARIFY ADMIN</h1><p class="sub">RESTRICTED ACCESS — AUTHORISED PERSONNEL ONLY</p>
${err}<form method="POST" action="/admin/login"><input type="password" name="key" placeholder="ENTER ADMIN KEY" autofocus /><button type="submit">[ AUTHENTICATE ]</button></form></div></body></html>`);
});

app.use('/admin/login', express.urlencoded({ extended: false }));
app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  if ((req.body.key || '').trim() === ADMIN_KEY) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// --- Admin API ---
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const data = await getDbData();
  res.json(data.users.map((u) => ({
    spotifyId: u.spotifyId,
    name: u.name,
    source: u.source || 'spotify',
    avatarUrl: u.avatarUrl || '',
    friendCode: u.friendCode,
    friendCount: u.friends?.length || 0,
    createdAt: u.createdAt,
    banned: u.banned || false,
    statusMessage: u.statusMessage,
    statusEmoji: u.statusEmoji,
  })));
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const data = await getDbData();
  const u = data.users.find((x) => x.spotifyId === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  u.banned = true;
  await saveDbData(data);
  res.json({ success: true, name: u.name });
});

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  const data = await getDbData();
  const u = data.users.find((x) => x.spotifyId === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  u.banned = false;
  await saveDbData(data);
  res.json({ success: true, name: u.name });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const data = await getDbData();
  const idx = data.users.findIndex((x) => x.spotifyId === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const name = data.users[idx].name;
  data.users.splice(idx, 1);
  // Remove all references to this user
  data.users.forEach((u) => {
    u.friends = u.friends.filter((id) => id !== req.params.id);
    u.friendRequestsSent = u.friendRequestsSent.filter((id) => id !== req.params.id);
    u.friendRequestsReceived = u.friendRequestsReceived.filter((r) => r.fromSpotifyId !== req.params.id);
  });
  await saveDbData(data);
  res.json({ success: true, name });
});

// --- Admin Dashboard Page ---
app.get('/admin', requireAdmin, async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sharify // Admin Console</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:'Inter',-apple-system,sans-serif;min-height:100vh;background-image:radial-gradient(rgba(255,255,255,0.03) 1px,transparent 1px);background-size:20px 20px}
.mono{font-family:'JetBrains Mono',monospace}
header{border-bottom:1px solid #1a1a1a;padding:16px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#000;z-index:10}
.logo{font-family:'JetBrains Mono',monospace;font-size:.9rem;letter-spacing:.25em;text-transform:uppercase;color:#fff}
.logo span{color:#555}
.header-actions{display:flex;align-items:center;gap:12px}
.badge{background:#111;border:1px solid #2a2a2a;padding:4px 10px;font-family:'JetBrains Mono',monospace;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:#888}
.btn-sm{background:transparent;border:1px solid #2a2a2a;color:#888;padding:5px 12px;font-family:'JetBrains Mono',monospace;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .15s}
.btn-sm:hover{border-color:#fff;color:#fff}
.btn-danger{border-color:#7f1d1d;color:#f87171}
.btn-danger:hover{background:#7f1d1d;color:#fff;border-color:#7f1d1d}
.btn-warn{border-color:#78350f;color:#fbbf24}
.btn-warn:hover{background:#78350f;color:#fff;border-color:#78350f}
.btn-ok{border-color:#14532d;color:#4ade80}
.btn-ok:hover{background:#14532d;color:#fff;border-color:#14532d}
main{padding:28px;max-width:1200px;margin:0 auto}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px}
.stat-card{border:1px solid #1a1a1a;padding:18px;background:#050505}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:2rem;font-weight:700;margin-bottom:4px}
.stat-label{font-size:.72rem;color:#555;text-transform:uppercase;letter-spacing:.12em;font-family:'JetBrains Mono',monospace}
.stat-card.spotify .stat-val{color:#1db954}
.stat-card.yt .stat-val{color:#ff0000}
.stat-card.banned .stat-val{color:#f87171}
.section-title{font-family:'JetBrains Mono',monospace;font-size:.75rem;letter-spacing:.2em;text-transform:uppercase;color:#444;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #111}
.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
input.search{background:#0a0a0a;border:1px solid #1a1a1a;color:#fff;padding:8px 14px;font-family:'JetBrains Mono',monospace;font-size:.8rem;letter-spacing:.08em;outline:none;flex:1;min-width:200px}
input.search:focus{border-color:#333}
select.filter{background:#0a0a0a;border:1px solid #1a1a1a;color:#888;padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:.78rem;letter-spacing:.08em;outline:none;cursor:pointer}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-family:'JetBrains Mono',monospace;font-size:.68rem;letter-spacing:.15em;text-transform:uppercase;color:#444;padding:10px 14px;border-bottom:1px solid #111;white-space:nowrap}
td{padding:12px 14px;border-bottom:1px solid #0d0d0d;vertical-align:middle;font-size:.85rem}
tr:hover td{background:#050505}
.avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid #1a1a1a;background:#111;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem;vertical-align:middle;margin-right:8px}
.name-cell{display:flex;align-items:center;gap:0}
.source-badge{font-family:'JetBrains Mono',monospace;font-size:.62rem;padding:2px 7px;letter-spacing:.1em;text-transform:uppercase;border:1px solid;display:inline-block}
.source-spotify{color:#1db954;border-color:#14532d}
.source-yt{color:#f87171;border-color:#7f1d1d}
.ban-badge{font-family:'JetBrains Mono',monospace;font-size:.62rem;padding:2px 7px;letter-spacing:.1em;text-transform:uppercase;border:1px solid #7f1d1d;color:#f87171;display:inline-block}
.active-badge{font-family:'JetBrains Mono',monospace;font-size:.62rem;padding:2px 7px;letter-spacing:.1em;text-transform:uppercase;border:1px solid #14532d;color:#4ade80;display:inline-block}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.empty{text-align:center;padding:48px;color:#333;font-family:'JetBrains Mono',monospace;font-size:.8rem;letter-spacing:.12em}
.toast{position:fixed;bottom:24px;right:24px;background:#fff;color:#000;padding:10px 18px;font-family:'JetBrains Mono',monospace;font-size:.78rem;letter-spacing:.1em;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
.toast.show{opacity:1}
@media(max-width:700px){th:nth-child(4),td:nth-child(4),th:nth-child(5),td:nth-child(5){display:none}}
</style>
</head>
<body>
<header>
  <div class="logo">SHARIFY <span>//</span> ADMIN CONSOLE</div>
  <div class="header-actions">
    <span class="badge" id="totalBadge">LOADING...</span>
    <a href="/" class="btn-sm">[ BACK TO APP ]</a>
    <a href="/admin/logout" class="btn-sm">[ LOGOUT ]</a>
  </div>
</header>
<main>
  <div class="stats-row">
    <div class="stat-card"><div class="stat-val" id="statTotal">—</div><div class="stat-label">Total Users</div></div>
    <div class="stat-card spotify"><div class="stat-val" id="statSpotify">—</div><div class="stat-label">Spotify</div></div>
    <div class="stat-card yt"><div class="stat-val" id="statYt">—</div><div class="stat-label">YT Music</div></div>
    <div class="stat-card banned"><div class="stat-val" id="statBanned">—</div><div class="stat-label">Banned</div></div>
  </div>

  <div class="section-title">// USER REGISTRY</div>
  <div class="toolbar">
    <input class="search" id="searchInput" placeholder="FILTER BY NAME OR CODE..." oninput="renderTable()" />
    <select class="filter" id="filterSource" onchange="renderTable()">
      <option value="">ALL SOURCES</option>
      <option value="spotify">SPOTIFY</option>
      <option value="ytmusic">YT MUSIC</option>
    </select>
    <select class="filter" id="filterStatus" onchange="renderTable()">
      <option value="">ALL STATUS</option>
      <option value="active">ACTIVE</option>
      <option value="banned">BANNED</option>
    </select>
    <button class="btn-sm" onclick="loadUsers()">[ REFRESH ]</button>
  </div>
  <table>
    <thead><tr>
      <th>User</th><th>Source</th><th>Friends</th><th>Joined</th><th>Status</th><th>Actions</th>
    </tr></thead>
    <tbody id="userTableBody"><tr><td colspan="6" class="empty">// LOADING REGISTRY...</td></tr></tbody>
  </table>
</main>
<div class="toast" id="toast"></div>

<script>
let allUsers = [];

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) { location.href = '/admin/login'; return; }
    allUsers = await res.json();
    updateStats();
    renderTable();
  } catch(e) { showToast('Failed to load users'); }
}

function updateStats() {
  document.getElementById('statTotal').textContent = allUsers.length;
  document.getElementById('statSpotify').textContent = allUsers.filter(u => u.source === 'spotify').length;
  document.getElementById('statYt').textContent = allUsers.filter(u => u.source === 'ytmusic').length;
  document.getElementById('statBanned').textContent = allUsers.filter(u => u.banned).length;
  document.getElementById('totalBadge').textContent = allUsers.length + ' USERS';
}

function renderTable() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const srcFilter = document.getElementById('filterSource').value;
  const statusFilter = document.getElementById('filterStatus').value;

  let filtered = allUsers.filter(u => {
    if (q && !u.name.toLowerCase().includes(q) && !u.friendCode.toLowerCase().includes(q)) return false;
    if (srcFilter && u.source !== srcFilter) return false;
    if (statusFilter === 'banned' && !u.banned) return false;
    if (statusFilter === 'active' && u.banned) return false;
    return true;
  });

  const tbody = document.getElementById('userTableBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">// NO USERS MATCH FILTER</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    const avatar = u.avatarUrl
      ? \`<img class="avatar" src="\${u.avatarUrl}" alt="" />\`
      : \`<span class="avatar">\${u.name.slice(0,1).toUpperCase()}</span>\`;
    const srcBadge = u.source === 'ytmusic'
      ? '<span class="source-badge source-yt">YT</span>'
      : '<span class="source-badge source-spotify">SPOTIFY</span>';
    const statusBadge = u.banned
      ? '<span class="ban-badge">BANNED</span>'
      : '<span class="active-badge">ACTIVE</span>';
    const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) : '—';
    const banBtn = u.banned
      ? \`<button class="btn-sm btn-ok" onclick="unbanUser('\${u.spotifyId}','\${esc(u.name)}')">[ UNBAN ]</button>\`
      : \`<button class="btn-sm btn-warn" onclick="banUser('\${u.spotifyId}','\${esc(u.name)}')">[ BAN ]</button>\`;
    return \`<tr id="row-\${u.spotifyId}">
      <td><div class="name-cell">\${avatar}<span style="font-weight:500">\${esc(u.name)}</span><span style="color:#333;font-size:.72rem;margin-left:8px;font-family:monospace">\${u.friendCode}</span></div></td>
      <td>\${srcBadge}</td>
      <td style="font-family:monospace;color:#555">\${u.friendCount}</td>
      <td style="font-family:monospace;color:#555;font-size:.8rem">\${joined}</td>
      <td>\${statusBadge}</td>
      <td><div class="actions">
        \${banBtn}
        <button class="btn-sm btn-danger" onclick="removeUser('\${u.spotifyId}','\${esc(u.name)}')">[ REMOVE ]</button>
      </div></td>
    </tr>\`;
  }).join('');
}

function esc(s) { return String(s).replace(/'/g,"&#39;").replace(/"/g,'&quot;'); }

async function banUser(id, name) {
  if (!confirm('Ban ' + name + '? They will lose app access immediately.')) return;
  const res = await fetch('/api/admin/users/' + id + '/ban', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) return showToast(d.error || 'Error');
  showToast(name + ' banned.');
  allUsers = allUsers.map(u => u.spotifyId === id ? {...u, banned: true} : u);
  updateStats(); renderTable();
}

async function unbanUser(id, name) {
  if (!confirm('Unban ' + name + '? They will regain access.')) return;
  const res = await fetch('/api/admin/users/' + id + '/unban', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) return showToast(d.error || 'Error');
  showToast(name + ' unbanned.');
  allUsers = allUsers.map(u => u.spotifyId === id ? {...u, banned: false} : u);
  updateStats(); renderTable();
}

async function removeUser(id, name) {
  if (!confirm('Permanently remove ' + name + '? This cannot be undone.')) return;
  const res = await fetch('/api/admin/users/' + id, { method: 'DELETE' });
  const d = await res.json();
  if (!res.ok) return showToast(d.error || 'Error');
  showToast(name + ' removed.');
  allUsers = allUsers.filter(u => u.spotifyId !== id);
  updateStats(); renderTable();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

loadUsers();
setInterval(loadUsers, 30000); // auto-refresh every 30s
</script>
</body></html>`);
});

// Start HTTP + WebSocket Server
server.listen(PORT, () => {
  ytm.startPoller(getDbData);
  console.log(`\n========================================================`);
  console.log(`🎵 Sharify Realtime Server running at http://localhost:${PORT}`);
  console.log(`========================================================\n`);
});
