require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const fs = require('fs');

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  REDIRECT_URI,
  PORT = 8888,
  SESSION_SECRET = 'change-me',
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

// Cloud storage helper functions using JSONbin.io
async function getFriends() {
  if (JSONBIN_BIN_ID && JSONBIN_API_KEY) {
    try {
      const res = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_API_KEY },
      });
      return res.data.record?.friends || [];
    } catch (err) {
      console.error('Failed to read from JSONbin, falling back:', err.response?.data || err.message);
    }
  }

  // Local fallback
  try {
    if (fs.existsSync(dbPath)) {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.friends || [];
    }
  } catch (err) {
    console.error('Failed to read local DB:', err.message);
  }
  return [];
}

async function saveFriends(friends) {
  if (JSONBIN_BIN_ID && JSONBIN_API_KEY) {
    try {
      await axios.put(
        `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`,
        { friends },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': JSONBIN_API_KEY,
          },
        }
      );
      return;
    } catch (err) {
      console.error('Failed to write to JSONbin, falling back to local:', err.response?.data || err.message);
    }
  }

  // Local fallback
  try {
    fs.writeFileSync(dbPath, JSON.stringify({ friends }, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write local DB:', err.message);
  }
}

const app = express();
app.use(
  cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 10 * 60 * 1000, // only needed to survive the OAuth redirect
  })
);
app.use(express.static(path.join(__dirname, 'public')));

const SCOPES = ['user-read-currently-playing', 'user-read-recently-played', 'user-read-email'].join(
  ' '
);

// Step 1: a friend clicks "Connect Spotify" -> here, then off to Spotify to approve.
app.get('/login', (req, res) => {
  const displayName = (req.query.name || '').trim();
  if (!displayName) {
    return res.status(400).send('Missing ?name=YourName in the link.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.pendingName = displayName;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Step 2: Spotify redirects back here with a code we exchange for tokens.
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Spotify error: ${error}`);
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('State mismatch — please try connecting again.');
  }

  const displayNameFromLogin = req.session.pendingName || 'Friend';

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
            'Basic ' +
            Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const spotifyId = profileRes.data.id;
    const spotifyProfileName = profileRes.data.display_name || displayNameFromLogin;
    const avatarUrl = profileRes.data.images?.[0]?.url || '';

    const record = {
      spotifyId,
      name: displayNameFromLogin || spotifyProfileName,
      spotifyProfileName,
      avatarUrl,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    };

    const friends = await getFriends();
    const index = friends.findIndex((f) => f.spotifyId === spotifyId);
    if (index > -1) {
      friends[index] = record;
    } else {
      friends.push(record);
    }
    await saveFriends(friends);

    res.redirect('/?connected=' + encodeURIComponent(record.name));
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Something went wrong connecting to Spotify. Check server logs.');
  }
});

// Refresh an access token using the stored refresh token.
async function ensureFreshToken(friend) {
  if (Date.now() < friend.expiresAt - 30_000) {
    return friend.accessToken; // still valid
  }
  const tokenRes = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: friend.refreshToken,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );
  const { access_token, expires_in } = tokenRes.data;
  const friends = await getFriends();
  const index = friends.findIndex((f) => f.spotifyId === friend.spotifyId);
  if (index > -1) {
    friends[index].accessToken = access_token;
    friends[index].expiresAt = Date.now() + expires_in * 1000;
    await saveFriends(friends);
  }
  return access_token;
}

// Step 3: dashboard polls this to see what everyone is playing right now.
app.get('/api/friends', async (req, res) => {
  const friends = await getFriends();

  const results = await Promise.all(
    friends.map(async (friend) => {
      try {
        const token = await ensureFreshToken(friend);
        const nowPlayingRes = await axios.get(
          'https://api.spotify.com/v1/me/player/currently-playing',
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: (s) => s === 200 || s === 204,
          }
        );

        if (nowPlayingRes.status === 204 || !nowPlayingRes.data?.item) {
          // Fallback to recently-played
          try {
            const recentlyPlayedRes = await axios.get(
              'https://api.spotify.com/v1/me/player/recently-played?limit=1',
              {
                headers: { Authorization: `Bearer ${token}` },
              }
            );
            const recentItem = recentlyPlayedRes.data?.items?.[0];
            if (recentItem && recentItem.track) {
              const track = recentItem.track;
              return {
                spotifyId: friend.spotifyId,
                name: friend.name,
                avatarUrl: friend.avatarUrl || '',
                playing: false,
                lastPlayed: true,
                playedAt: recentItem.played_at,
                track: track.name,
                artists: track.artists.map((a) => a.name).join(', '),
                album: track.album?.name,
                albumArt: track.album?.images?.[0]?.url,
                spotifyUrl: track.external_urls?.spotify,
              };
            }
          } catch (recentErr) {
            console.error(`Failed to fetch recently played for ${friend.name}:`, recentErr.response?.data || recentErr.message);
          }
          return {
            spotifyId: friend.spotifyId,
            name: friend.name,
            avatarUrl: friend.avatarUrl || '',
            playing: false,
            lastPlayed: false
          };
        }

        const item = nowPlayingRes.data.item;
        return {
          spotifyId: friend.spotifyId,
          name: friend.name,
          avatarUrl: friend.avatarUrl || '',
          playing: nowPlayingRes.data.is_playing,
          track: item.name,
          artists: item.artists.map((a) => a.name).join(', '),
          album: item.album?.name,
          albumArt: item.album?.images?.[0]?.url,
          progressMs: nowPlayingRes.data.progress_ms,
          durationMs: item.duration_ms,
          spotifyUrl: item.external_urls?.spotify,
          timestamp: Date.now()
        };
      } catch (err) {
        console.error(`Failed for ${friend.name}:`, err.response?.data || err.message);
        return {
          spotifyId: friend.spotifyId,
          name: friend.name,
          avatarUrl: friend.avatarUrl || '',
          playing: false,
          error: true
        };
      }
    })
  );

  res.json(results);
});

// Step 4: disconnect a friend
app.delete('/api/friends/:id', async (req, res) => {
  const { id } = req.params;
  const friends = await getFriends();
  const filtered = friends.filter((f) => f.spotifyId !== id);
  if (filtered.length === friends.length) {
    return res.status(404).send('Friend not found');
  }
  await saveFriends(filtered);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\nSpotify Friends app running at http://localhost:${PORT}`);
  console.log(`Send friends this link to connect: http://localhost:${PORT}/login?name=THEIR_NAME\n`);
});
