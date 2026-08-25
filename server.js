require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

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

// --- tiny JSON "database" of friends (one row per connected friend) ---
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);
db.defaults({ friends: [] }).write();

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

    const existing = db.get('friends').find({ spotifyId }).value();
    const record = {
      spotifyId,
      name: displayNameFromLogin || spotifyProfileName,
      spotifyProfileName,
      avatarUrl,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    };

    if (existing) {
      db.get('friends').find({ spotifyId }).assign(record).write();
    } else {
      db.get('friends').push(record).write();
    }

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
  db.get('friends')
    .find({ spotifyId: friend.spotifyId })
    .assign({ accessToken: access_token, expiresAt: Date.now() + expires_in * 1000 })
    .write();
  return access_token;
}

// Step 3: dashboard polls this to see what everyone is playing right now.
app.get('/api/friends', async (req, res) => {
  const friends = db.get('friends').value();

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
app.delete('/api/friends/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.get('friends').find({ spotifyId: id }).value();
  if (!existing) {
    return res.status(404).send('Friend not found');
  }
  db.get('friends').remove({ spotifyId: id }).write();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\nSpotify Friends app running at http://localhost:${PORT}`);
  console.log(`Send friends this link to connect: http://localhost:${PORT}/login?name=THEIR_NAME\n`);
});
