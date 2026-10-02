// YouTube Music support: encrypted credential storage + fast parallel poller.
// Credentials never leave the server; the browser only ever sees feed cards.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PY = process.env.PYTHON_BIN || 'python3';
const SCRIPT = path.join(__dirname, 'ytm', 'history.py');
const POLL_MS = 5_000;       // server-side poll cadence
const PY_TIMEOUT = 8_000;   // kill Python if no response in 8s (well under poll interval)
const MAX_FAILS = 5;         // more headroom before marking expired

const enabled = !!process.env.YTM_ENC_KEY;
const key = enabled ? crypto.createHash('sha256').update(process.env.YTM_ENC_KEY).digest() : null;

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
    const p = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'timeout' }); }, PY_TIMEOUT);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: 'No valid response from YT Music helper' }); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}

// userId -> { item, firstSeenAt, fails, status, polling }
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
  // Only set firstSeenAt when a KNOWN previous song changes to a new one.
  // If prev.item is null/undefined (first boot or first poll), never claim "live" —
  // the song may have started arbitrarily long ago.
  if (prev?.item && it && prev.item.videoId !== it.videoId) firstSeenAt = Date.now();
  cache.set(userId, { item: it, firstSeenAt, fails: 0, status: 'ok', polling: false });
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
  const card = {
    ...base, track: it.title, artists: it.artists, album: it.album, albumArt: it.albumArt,
    spotifyUrl: `https://music.youtube.com/watch?v=${it.videoId}`, durationMs: it.durationSeconds * 1000,
  };
  const elapsed = c.firstSeenAt ? Date.now() - c.firstSeenAt : Infinity;
  if (it.durationSeconds && elapsed < card.durationMs + 30_000) {
    return { ...card, playing: true, progressMs: Math.min(elapsed, card.durationMs), timestamp: Date.now() };
  }
  return { ...card, lastPlayed: true, playedAt: c.firstSeenAt ? new Date(c.firstSeenAt).toISOString() : null, playedLabel: it.played || '' };
}

// Poll a single user — per-user lock so users don't block each other
async function pollUser(u, io) {
  const entry = cache.get(u.spotifyId);
  if (entry?.polling) return; // this user's previous call still in flight

  const prev = entry || { item: null, firstSeenAt: null, fails: 0, status: 'ok' };
  cache.set(u.spotifyId, { ...prev, polling: true });

  let r;
  try { r = await runPy({ auth: decrypt(u.ytAuthEnc) }); } catch { r = { ok: false }; }

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
    const fails = (now.fails || 0) + 1;
    cache.set(u.spotifyId, { ...now, fails, polling: false, status: fails >= MAX_FAILS ? 'expired' : 'ok' });
    if (r.error !== 'timeout') console.error(`YT poll failed for ${u.name} (${fails}/${MAX_FAILS}): ${r.error}`);
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
