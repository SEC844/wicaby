// Fake Trakt API v2 for the desktop's client-side scrobbling (apps/desktop/src/main/features/trakt.ts).
//   node tools/mock-server/mock-trakt.mjs [port=8260]
// then start an unpackaged Wicaby with WICABY_TRAKT_URL=http://127.0.0.1:<port>.
// Any client id works; the client secret must be "mock-secret-123" (MOCK_TRAKT_SECRET).
// A device code is approved after MOCK_TRAKT_APPROVE polls (default 2); MOCK_TRAKT_DENY=1 answers 418 instead.
// Access tokens live MOCK_TRAKT_TTL seconds (default 86400), to exercise the refresh.
// Also POST /sync/history and /sync/history/remove (Android TV's watched marks), GET /search/{imdb|tmdb|tvdb}/{id}
// and GET /sync/history/{movies|episodes}/{trakt id} (an "unwatched" mark removes the latest play by its history id).
// Mock-only: GET /mock/state (scrobbles, history, live tokens), POST /mock/expire (revokes every access token: next call gets 401).
import { randomBytes } from 'node:crypto';
import http from 'node:http';

// Port 0 picks a free one; the startup line gives the real address.
let PORT = Number(process.argv[2] ?? 8260);
const SECRET = process.env.MOCK_TRAKT_SECRET ?? 'mock-secret-123';
const APPROVE_AFTER = Number(process.env.MOCK_TRAKT_APPROVE ?? 2);
const DENY = process.env.MOCK_TRAKT_DENY === '1';
const TTL = Number(process.env.MOCK_TRAKT_TTL ?? 86400);

const codes = new Map(); // device_code -> { user_code, polls, used, expiresAt }
const access = new Set();
const refresh = new Set();
const scrobbles = [];
const history = [];
const traktIds = new Map(); // "imdb:tt0111161" -> trakt id, made up on first sight
const traktId = (ids) => {
  const [k, v] = Object.entries(ids ?? {})[0] ?? [];
  if (!traktIds.has(`${k}:${v}`)) traktIds.set(`${k}:${v}`, 1000 + traktIds.size);
  return traktIds.get(`${k}:${v}`);
};
const id = (n = 16) => randomBytes(n).toString('hex');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function tokens() {
  const t = { access_token: id(), refresh_token: id(), token_type: 'bearer', expires_in: TTL, scope: 'public', created_at: Math.floor(Date.now() / 1000) };
  access.add(t.access_token);
  refresh.add(t.refresh_token);
  return t;
}

async function route(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const M = req.method;
  console.log(`${M} ${p}`);

  if (p === '/mock/state') return send(res, 200, { scrobbles, history, accessTokens: access.size });
  if (p === '/mock/expire' && M === 'POST') {
    access.clear();
    return send(res, 204);
  }
  if (p === '/activate') return send(res, 200, { hint: 'Device codes are approved automatically by this mock.' });

  // Every API call carries the app's client id and the API version (Trakt answers 403 / 412 otherwise).
  if (!req.headers['trakt-api-key']) return send(res, 403, { error: 'missing trakt-api-key' });
  if (req.headers['trakt-api-version'] !== '2') return send(res, 412, { error: 'trakt-api-version must be 2' });

  if (p === '/oauth/device/code' && M === 'POST') {
    const b = await body(req);
    if (!b.client_id) return send(res, 401, { error: 'invalid_client' });
    const device_code = id(20);
    const user_code = id(4).toUpperCase();
    codes.set(device_code, { user_code, polls: 0, used: false, expiresAt: Date.now() + 600_000 });
    return send(res, 200, { device_code, user_code, verification_url: `http://127.0.0.1:${PORT}/activate`, expires_in: 600, interval: 1 });
  }
  if (p === '/oauth/device/token' && M === 'POST') {
    const b = await body(req);
    const c = codes.get(b.code);
    if (!c) return send(res, 404);
    if (b.client_secret !== SECRET) return send(res, 401, { error: 'invalid_client' });
    if (c.used) return send(res, 409);
    if (Date.now() > c.expiresAt) return send(res, 410);
    if (++c.polls < APPROVE_AFTER) return send(res, 400);
    if (DENY) return send(res, 418);
    c.used = true;
    return send(res, 200, tokens());
  }
  if (p === '/oauth/token' && M === 'POST') {
    const b = await body(req);
    if (b.grant_type !== 'refresh_token' || b.client_secret !== SECRET || !refresh.delete(b.refresh_token)) return send(res, 401, { error: 'invalid_grant' });
    return send(res, 200, tokens());
  }
  if (p === '/oauth/revoke' && M === 'POST') {
    const b = await body(req);
    access.delete(b.token);
    return send(res, 200, {});
  }

  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  if (!bearer || !access.has(bearer)) return send(res, 401, { error: 'invalid_token' });

  if (p === '/users/settings' && M === 'GET') return send(res, 200, { user: { username: 'wika', private: false, name: 'Wika' } });
  const action = /^\/scrobble\/(start|pause|stop)$/.exec(p)?.[1];
  if (action && M === 'POST') {
    const b = await body(req);
    const media = b.movie ? 'movie' : b.episode ? 'episode' : null;
    if (!media || typeof b.progress !== 'number' || !Object.keys(b[media].ids ?? {}).length) return send(res, 422, { error: 'movie or episode with ids, and progress, are required' });
    const s = { action, progress: b.progress, [media]: b[media], at: new Date().toISOString() };
    scrobbles.push(s);
    console.log(`SCROBBLE ${action} ${media} ${JSON.stringify(b[media].ids)} ${b.progress}%`);
    // A stop at 80 % or more is a watch ("scrobble"); below, Trakt keeps it as paused.
    return send(res, 201, { id: scrobbles.length, action: action === 'stop' && b.progress >= 80 ? 'scrobble' : action, progress: b.progress, [media]: b[media] });
  }
  const found = /^\/search\/(imdb|tmdb|tvdb)\/([^/]+)$/.exec(p);
  if (found && M === 'GET') {
    const type = url.searchParams.get('type') ?? 'movie';
    return send(res, 200, [{ type, score: 1000, [type]: { ids: { trakt: traktId({ [found[1]]: found[1] === 'imdb' ? found[2] : Number(found[2]) }), [found[1]]: found[2] } } }]);
  }
  const plays = /^\/sync\/history\/(movies|episodes)\/(\d+)$/.exec(p);
  if (plays && M === 'GET') {
    const gone = new Set(history.filter((h) => h.action === 'remove').map((h) => h.historyId));
    const list = history.filter((h) => h.action === 'add' && h.media === plays[1] && h.trakt === Number(plays[2]) && !gone.has(h.historyId));
    return send(res, 200, list.reverse().slice(0, Number(url.searchParams.get('limit') ?? 10)).map((h) => ({ id: h.historyId, watched_at: h.at, action: 'watch' })));
  }
  // Android TV (core/trakt): a watched mark set or cleared by hand goes to the history.
  if ((p === '/sync/history' || p === '/sync/history/remove') && M === 'POST') {
    const b = await body(req);
    const removed = p.endsWith('/remove');
    const counts = { movies: 0, episodes: 0 };
    for (const k of Object.keys(counts)) {
      for (const e of Array.isArray(b[k]) ? b[k] : []) {
        if (!Object.keys(e?.ids ?? {}).length) continue;
        history.push({ action: removed ? 'remove' : 'add', media: k, ids: e.ids, trakt: traktId(e.ids), historyId: history.length + 1, at: new Date().toISOString() });
        counts[k]++;
      }
    }
    // Single plays by history id (raw ids from GET /sync/history/{type}/{id}).
    for (const hid of removed && Array.isArray(b.ids) ? b.ids : []) {
      const play = history.find((h) => h.action === 'add' && h.historyId === hid);
      if (!play) continue;
      history.push({ action: 'remove', media: play.media, ids: play.ids, trakt: play.trakt, historyId: hid, at: new Date().toISOString() });
      counts[play.media]++;
    }
    console.log(`HISTORY ${removed ? 'remove' : 'add'} ${JSON.stringify(counts)}`);
    return send(res, removed ? 200 : 201, removed ? { deleted: counts, not_found: { movies: [], episodes: [] } } : { added: counts, not_found: { movies: [], episodes: [] } });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.log('ERROR', err);
    if (!res.headersSent) send(res, 500, { error: String(err) });
  });
});
server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  console.log(`Mock Trakt on http://127.0.0.1:${PORT} (client secret ${SECRET})`);
});
