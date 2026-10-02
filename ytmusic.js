// YouTube Music support: encrypted credential storage + fast parallel poller.
// Credentials never leave the server; the browser only ever sees feed cards.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PY = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
const SCRIPT = path.join(__dirname, 'ytm', 'history.py');
const POLL_MS = 5_000;       // server-side poll cadence
const PY_TIMEOUT = 25_000;  // 25s limit gives Python requests ample time to connect
const MAX_AUTH_FAILS = 20;  // consecutive *genuine auth* failures before marking expired
                             // ~100s of real 401/403s — network blips never count

const encSecret = process.env.YTM_ENC_KEY || 'sharify-default-ytm-encryption-secret-key-2026';
const enabled = true;
const key = crypto.createHash('sha256').update(encSecret).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(s) {
  const [iv, tag, enc] = s.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function runPy(payload) {
  return new Promise((resolve) => {
    const p = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'YT Music helper timed out (25s limit)' }); }, PY_TIMEOUT);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `Python spawn error (${PY}): ${e.message}` }); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const line = out.trim().split('\n').pop();
        if (!line) throw new Error('Empty response');
        resolve(JSON.parse(line));
      } catch (err) {
        const errorMsg = errOut.trim() || out.trim() || 'No valid response from YT Music helper';
        resolve({ ok: false, error: errorMsg });
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}

// userId -> { item, firstSeenAt, authFails, netFails, status, polling }
const cache = new Map();

function clean(item) {
  if (!item || !/^[\w-]{11}$/.test(item.videoId || '')) return null;
  return {
    ...item,
    albumArt: /^https:\/\//.test(item.albumArt || '') ? item.albumArt : '',
    durationSeconds: Number(item.durationSeconds) || 0,
  };
}

function record(userId, item) {
  const prev = cache.get(userId);
  const it = clean(item);
  let firstSeenAt = prev?.firstSeenAt ?? null;

  const isNewTrack = prev?.item && it && prev.item.videoId !== it.videoId;
  const isPlayedJustNow = it && (it.played === 'Just now' || (it.played || '').includes('second') || (it.played || '').includes('1 minute'));

  if (isNewTrack || (isPlayedJustNow && (!prev?.firstSeenAt || (prev.item && prev.item.played !== it.played)))) {
    firstSeenAt = Date.now();
  }

  cache.set(userId, { item: it, firstSeenAt, authFails: 0, netFails: 0, status: 'ok', polling: false });
}

// Validate pasted headers; returns { ok, authEnc, item } or { ok:false, error }
async function connect(rawHeaders) {
  const raw = String(rawHeaders || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 20_000);
  const r = await runPy({ raw });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, authEnc: encrypt(r.auth), item: r.item };
}

function seed(userId, item) { cache.delete(userId); record(userId, item); }
function forget(userId) { cache.delete(userId); }

function getCard(user) {
  const c = cache.get(user.spotifyId);
  const base = {
    spotifyId: user.spotifyId, name: user.name, avatarUrl: user.avatarUrl,
    friendCode: user.friendCode, statusMessage: user.statusMessage, statusEmoji: user.statusEmoji,
    source: 'ytmusic', playing: false,
  };
  if (!user.ytAuthEnc || c?.status === 'expired') return { ...base, lastPlayed: false, needsReconnect: true };
  if (!c || !c.item) return { ...base, lastPlayed: false };

  const it = c.item;
  const durationMs = (it.durationSeconds || 210) * 1000;
  const card = {
    ...base, track: it.title, artists: it.artists, album: it.album, albumArt: it.albumArt,
    spotifyUrl: `https://music.youtube.com/watch?v=${it.videoId}`, durationMs,
  };

  const isPlayedJustNow = it.played === 'Just now' || (it.played || '').includes('second') || (it.played || '').includes('1 minute');

  if (c.firstSeenAt && (isPlayedJustNow || Date.now() - c.firstSeenAt < durationMs + 30_000)) {
    const elapsed = Date.now() - c.firstSeenAt;
    const progressMs = Math.min(Math.max(0, elapsed), durationMs);
    return { ...card, playing: true, progressMs, timestamp: Date.now() };
  }

  return { ...card, lastPlayed: true, playedAt: c.firstSeenAt ? new Date(c.firstSeenAt).toISOString() : null, playedLabel: it.played || '' };
}

// Poll a single user — per-user lock so users don't block each other
async function pollUser(u, io) {
  const entry = cache.get(u.spotifyId);
  if (entry?.polling) return; // this user's previous call still in flight

  const prev = entry || { item: null, firstSeenAt: null, authFails: 0, netFails: 0, status: 'ok' };
  cache.set(u.spotifyId, { ...prev, polling: true });

  let r;
  try {
    const rawAuth = decrypt(u.ytAuthEnc);
    r = await runPy({ auth: rawAuth });
  } catch (err) {
    r = { ok: false, authError: true, error: `Decryption error (reconnect needed): ${err.message}` };
  }

  const now = cache.get(u.spotifyId) || { ...prev };
  if (r.ok) {
    const oldId = now.item?.videoId;
    record(u.spotifyId, r.item);
    const newId = cache.get(u.spotifyId)?.item?.videoId;
    // Push to clients immediately if song changed
    if (io && oldId !== newId && newId) {
      io.emit('yt_track_changed', { spotifyId: u.spotifyId });
    }
  } else {
    const authFails = (now.authFails || 0) + (r.authError ? 1 : 0);
    const netFails  = (now.netFails  || 0) + (r.authError ? 0 : 1);
    const expired   = authFails >= MAX_AUTH_FAILS;
    cache.set(u.spotifyId, { ...now, authFails, netFails, polling: false,
                             status: expired ? 'expired' : 'ok' });
    if (r.authError) {
      console.error(`YT auth failure for ${u.name} (${authFails}/${MAX_AUTH_FAILS}): ${r.error}`);
    } else if (r.error !== 'timeout') {
      // Network blip — debug level only, not a problem
      console.debug && console.debug(`YT net blip for ${u.name} (netFails=${netFails}): ${r.error}`);
    }
  }
}

function startPoller(getDbData, io) {
  if (!enabled) return console.warn('YT Music disabled: set YTM_ENC_KEY to enable.');

  const tick = async () => {
    try {
      const { users } = await getDbData();
      const ytUsers = users.filter((u) => u.source === 'ytmusic' && u.ytAuthEnc && cache.get(u.spotifyId)?.status !== 'expired');
      // Fire all user polls concurrently — per-user locks prevent pile-up
      await Promise.allSettled(ytUsers.map((u) => pollUser(u, io)));
    } catch (e) { console.error('YT poll tick error:', e.message); }
  };

  tick(); // immediate first poll
  setInterval(tick, POLL_MS);
}

module.exports = { enabled, connect, seed, forget, getCard, startPoller, runPy, encrypt, decrypt };
