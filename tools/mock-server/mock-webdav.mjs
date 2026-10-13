// Mock WebDAV server for the file sources (file-sources-spec FS-02). Loopback only, Basic auth demo/demo,
// a folder tree served under /media (MOCK_DAV_ROOT, else a fresh files-fixture.mjs tree).
// - PROPFIND Depth 0 and 1 (multistatus with resourcetype, getcontentlength, getlastmodified), GET and HEAD
//   with Range, OPTIONS (DAV: 1). Depth: infinity is refused (403) and tagged.
// - GET /Mock/State: calls[] (method, path, depth, range, auth, status), authSeen, ranges[], tags[];
//   POST /Mock/Reset clears them; POST /Mock/RotateCert serves the second TEST ONLY pair (TLS only).
//   The credentials themselves never appear in the state: only whether an Authorization header came.
// - Tags: NO-AUTH (a request without Authorization), AUTH-IN-URL (credentials in the path or query),
//   DEPTH-INFINITY, HREF-ESCAPE (an evil href was served, MOCK_DAV_EVIL).
// Variables: PORT (8975), MOCK_DAV_TLS=1, MOCK_DAV_DIGEST=1 (Digest only), MOCK_DAV_EVIL=1, MOCK_DAV_SLOW=ms,
// MOCK_DAV_ENTRIES=n (a folder "Many" with n entries).
// Usage: node tools/mock-server/mock-webdav.mjs   or   import { startMockWebdav } from './mock-webdav.mjs'
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { buildFilesFixture } from './files-fixture.mjs';

const TLS_DIR = path.join(import.meta.dirname, 'fixtures', 'webdav-tls');
const BASE = '/media';
const USER = 'demo';
const PASS = 'demo';

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hrefOf = (rel, dir) => `${BASE}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${dir && rel ? '/' : rel ? '' : '/'}`;

function propEntry(href, st) {
  const dir = st.isDirectory();
  return `<D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>${
    dir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`
  }<D:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

export async function startMockWebdav(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const tls = env.MOCK_DAV_TLS === '1';
  const root = opts.root ?? env.MOCK_DAV_ROOT ?? buildFilesFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-dav-'))).dir;
  const slow = Number(env.MOCK_DAV_SLOW ?? 0);
  const many = Number(env.MOCK_DAV_ENTRIES ?? 0);
  const state = { calls: [], authSeen: false, ranges: [], tags: [] };
  const tag = (t) => state.tags.push(t);

  // Local path of a request path under BASE, or null when it leaves the root.
  const local = (p) => {
    let rel;
    try {
      rel = decodeURIComponent(p.slice(BASE.length)).replace(/^\/+|\/+$/g, '');
    } catch {
      return null;
    }
    const full = path.resolve(root, rel);
    return full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep) ? { rel, full } : null;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const auth = req.headers.authorization ?? '';
    const call = { method: req.method, path: url.pathname, depth: req.headers.depth, range: req.headers.range, auth: Boolean(auth), status: 0 };
    const end = (status, headers = {}, body) => {
      call.status = status;
      res.writeHead(status, headers);
      res.end(body);
    };
    if (url.pathname.startsWith('/Mock/')) {
      if (url.pathname === '/Mock/State') return end(200, { 'Content-Type': 'application/json' }, JSON.stringify(state));
      if (url.pathname === '/Mock/Reset' && req.method === 'POST') {
        Object.assign(state, { calls: [], authSeen: false, ranges: [], tags: [] });
        return end(204);
      }
      if (url.pathname === '/Mock/RotateCert' && req.method === 'POST' && tls) {
        server.setSecureContext({ key: fs.readFileSync(path.join(TLS_DIR, 'key2.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'cert2.pem')) });
        return end(204);
      }
      return end(404);
    }
    state.calls.push(call);
    if (/@|(pass(word)?|user|api_key)=/i.test(req.url)) tag('AUTH-IN-URL');
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (env.MOCK_DAV_DIGEST === '1') {
      if (!auth) tag('NO-AUTH');
      return end(401, { 'WWW-Authenticate': 'Digest realm="mock", qop="auth", nonce="0000", algorithm=MD5' });
    }
    if (!auth) {
      tag('NO-AUTH');
      return end(401, { 'WWW-Authenticate': 'Basic realm="mock"' });
    }
    state.authSeen = true;
    const m = /^Basic (.+)$/.exec(auth);
    const [u, p] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
    if (u !== USER || p !== PASS) return end(401, { 'WWW-Authenticate': 'Basic realm="mock"' });
    if (req.method === 'OPTIONS') return end(200, { DAV: '1', Allow: 'OPTIONS, PROPFIND, GET, HEAD' });
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return end(404);
    const loc = local(url.pathname);
    if (!loc) return end(400);

    if (req.method === 'PROPFIND') {
      const depth = req.headers.depth ?? 'infinity';
      if (depth !== '0' && depth !== '1') {
        tag('DEPTH-INFINITY');
        return end(403);
      }
      const parts = [];
      if (many && loc.rel === 'Many') {
        parts.push(`<D:response><D:href>${hrefOf('Many', true)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
        if (depth === '1')
          for (let i = 0; i < many; i++)
            parts.push(
              `<D:response><D:href>${hrefOf(`Many/Clip ${i}.mkv`)}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            );
      } else {
        let st;
        try {
          st = fs.statSync(loc.full);
        } catch {
          return end(404);
        }
        parts.push(propEntry(hrefOf(loc.rel, st.isDirectory()), st));
        if (depth === '1' && st.isDirectory()) {
          for (const name of fs.readdirSync(loc.full)) {
            const cst = fs.statSync(path.join(loc.full, name));
            parts.push(propEntry(hrefOf(loc.rel ? `${loc.rel}/${name}` : name, cst.isDirectory()), cst));
          }
          if (many && !loc.rel) parts.push(`<D:response><D:href>${hrefOf('Many', true)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
          if (env.MOCK_DAV_EVIL === '1' && !loc.rel) {
            tag('HREF-ESCAPE');
            const evil = ['http://evil.example/media/Other.mkv', `${BASE}/../etc/passwd`, `${BASE}/a%2Fb.mkv`, '/elsewhere/Escape.mkv', `${BASE}/Films/Deeper/Too.mkv`];
            for (const h of evil) parts.push(`<D:response><D:href>${xmlEsc(h)}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
          }
        }
      }
      return end(207, { 'Content-Type': 'application/xml; charset=utf-8' }, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      let st;
      try {
        st = fs.statSync(loc.full);
      } catch {
        return end(404);
      }
      if (st.isDirectory()) return end(405);
      const size = st.size;
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
      if (r && (r[1] || r[2])) {
        let start = r[1] ? Number(r[1]) : size - Number(r[2]);
        const last = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        start = Math.max(0, start);
        if (start > last) return end(416, { 'Content-Range': `bytes */${size}` });
        state.ranges.push({ path: url.pathname, start, end: last, status: 206 });
        call.status = 206;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${last}/${size}`, 'Content-Length': String(last - start + 1) });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(loc.full, { start, end: last }).pipe(res);
      }
      call.status = 200;
      res.writeHead(200, { ...headers, 'Content-Length': String(size) });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(loc.full).pipe(res);
    }
    return end(405);
  }

  const onRequest = (req, res) =>
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  const server = tls
    ? https.createServer({ key: fs.readFileSync(path.join(TLS_DIR, 'key1.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'cert1.pem')) }, onRequest)
    : http.createServer(onRequest);
  const port = opts.port ?? Number(env.PORT ?? 8975);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${actual}`;
  return { server, root, state, origin, base: `${origin}${BASE}`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const m = await startMockWebdav();
  console.log(`mock-webdav: ${m.base} (user demo, password demo), tree ${m.root}`);
}
