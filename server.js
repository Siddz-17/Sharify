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
  SESSION_SECRET = 'sharify-super-secret-key-2026',
} = process.env;

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
  let data = { users: [], messages: [] };

  if (JSONBIN_BIN_ID && JSONBIN_API_KEY) {
    try {
      const res = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY },
      });
      const record = res.data.record || {};
      data.users = record.users || record.friends || [];
      data.messages = record.messages || [];
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
      }
    } catch (err) {
      console.error('Failed to read local DB:', err.message);
    }
  }

  // Ensure default structure on every user record
  data.users = data.users.map((u) => ({
    spotifyId: u.spotifyId,
    name: u.name || 'User',
    spotifyProfileName: u.spotifyProfileName || u.name || 'User',
    avatarUrl: u.avatarUrl || '',
    friendCode: u.friendCode || generateFriendCode(u.name),
    friends: Array.isArray(u.friends) ? u.friends : [],
    friendRequestsReceived: Array.isArray(u.friendRequestsReceived) ? u.friendRequestsReceived : [],
    friendRequestsSent: Array.isArray(u.friendRequestsSent) ? u.friendRequestsSent : [],
    statusMessage: u.statusMessage || '',
    statusEmoji: u.statusEmoji || '🎧',
    accessToken: u.accessToken,
    refreshToken: u.refreshToken,
    expiresAt: u.expiresAt || 0,
    topArtists: u.topArtists || [],
    topGenres: u.topGenres || [],
    createdAt: u.createdAt || new Date().toISOString(),
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
      existing.avatarUrl = avatarUrl || existing.avatarUrl;
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

    req.session.spotifyId = spotifyId;
    req.session.displayName = data.users[userIndex].name;

    res.redirect(`/?connected=${encodeURIComponent(data.users[userIndex].name)}&userId=${encodeURIComponent(spotifyId)}`);
  } catch (err) {
    console.error('Error during Spotify Auth callback:', err.response?.data || err.message);
    res.status(500).send('Something went wrong connecting to Spotify. Check server logs.');
  }
});

// Helper to get active user from session or header
async function getAuthenticatedUser(req) {
  const data = await getDbData();
  const sessionSpotifyId = req.session?.spotifyId || req.headers['x-spotify-user-id'] || req.query.currentUserId;
  if (!sessionSpotifyId) return null;
  return data.users.find((u) => u.spotifyId === sessionSpotifyId) || null;
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

    res.json({
      spotifyId: user.spotifyId,
      name: user.name,
      spotifyProfileName: user.spotifyProfileName,
      avatarUrl: user.avatarUrl,
      friendCode: user.friendCode,
      statusMessage: user.statusMessage,
      statusEmoji: user.statusEmoji,
      friends: friendsDetails,
      friendRequestsReceived: receivedRequests,
      friendRequestsSent: user.friendRequestsSent,
      totalUsersCount: data.users.length,
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

      return res.json({ success: true, user: data.users[idx] });
    }
    res.status(404).json({ error: 'User not found' });
  } catch (err) {
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
      targetUsers = data.users.filter((u) => friendIds.has(u.spotifyId));
    } else {
      targetUsers = data.users.slice(0, 10);
    }

    const feedResults = await Promise.all(
      targetUsers.map(async (user) => {
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

// Start HTTP + WebSocket Server
server.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🎵 Sharify Realtime Server running at http://localhost:${PORT}`);
  console.log(`========================================================\n`);
});
