// Fake qBittorrent Web API v2 for UI and flow testing. Nothing is downloaded:
// progress is simulated in memory.
//   node tools/mock-server/mock-qbittorrent.mjs [port=8250]
// Login: admin / adminadmin. MOCK_QBIT_VERSION=4.6.7 speaks the 4.x API
// (pause/resume, pausedDL), the default 5.0.4 speaks 2.11 (stop/start, stoppedDL).
// MOCK_QBIT_NOQUEUE=1 answers 409 to priority changes, like qBittorrent with queueing off.
// GET /mock/expire drops every session (tests the re-login on 403).
// MOCK_QBIT_TLS=<dir with key.pem + cert.pem> serves HTTPS (self-signed certificate flow).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 8250);
const VERSION = process.env.MOCK_QBIT_VERSION ?? '5.0.4';
const V5 = !VERSION.startsWith('4');
const API = V5 ? '2.11.4' : '2.9.3';
const STOP_DL = V5 ? 'stoppedDL' : 'pausedDL';
const STOP_UP = V5 ? 'stoppedUP' : 'pausedUP';
const GB = 1024 ** 3;

const sessions = new Set();
const categories = {
  films: { name: 'films', savePath: 'D:\\Media\\Films' },
  series: { name: 'series', savePath: 'D:\\Media\\Séries' },
  musique: { name: 'musique', savePath: 'D:\\Media\\Musique' },
};
const server = { dl_info_speed: 0, up_info_speed: 0, use_alt_speed_limits: false, free_space_on_disk: 812 * GB, connection_status: 'connected', dl_info_data: 0, up_info_data: 0 };
const torrents = new Map();

const hashOf = (s) => createHash('sha1').update(s).digest('hex');
function addTorrent(name, opts = {}) {
  const hash = opts.hash ?? hashOf(name);
  torrents.set(hash, {
    name,
    size: opts.size ?? 4 * GB,
    progress: opts.progress ?? 0,
    state: opts.state ?? 'downloading',
    dlspeed: 0,
    upspeed: 0,
    eta: 8640000,
    ratio: opts.ratio ?? 0,
    category: opts.category ?? '',
    num_seeds: 12,
    num_complete: 140,
    num_leechs: 3,
    num_incomplete: 22,
    added_on: Math.floor(Date.now() / 1000) - (opts.age ?? 0),
    completion_on: -1,
    save_path: categories[opts.category]?.savePath ?? 'D:\\Torrents',
    seq_dl: false,
    f_l_piece_prio: false,
    force_start: false,
    priority: 0,
    rate: opts.rate ?? 0.004,
  });
  renumber();
  return hash;
}

// Queue positions: 1..n for unfinished torrents, 0 for finished ones (qBittorrent uses 0 / -1).
function renumber() {
  let i = 0;
  for (const t of [...torrents.values()].sort((a, b) => (a.priority || 1e9) - (b.priority || 1e9))) t.priority = t.progress < 1 ? ++i : 0;
}

addTorrent('Néon.Fantôme.2024.1080p.WEB-DL.x265-MOCK', { category: 'films', progress: 0.9, rate: 0.006, size: 6.2 * GB, age: 3600 });
addTorrent('Les.Ombres.du.Port.S01.1080p.WEB.x264-MOCK', { category: 'series', progress: 0.35, rate: 0.003, size: 14.8 * GB, age: 7200 });
addTorrent('debian-13.1.0-amd64-netinst.iso', { progress: 1, state: 'uploading', size: 0.75 * GB, ratio: 2.41, age: 86400 * 3 });
addTorrent('Archive.Concert.2019.FLAC', { category: 'musique', progress: 0.12, state: 'stalledDL', size: 1.1 * GB, age: 600 });
addTorrent('Documentaire.Océans.2022.2160p.UHD.BluRay-MOCK', { category: 'films', progress: 0.48, state: STOP_DL, size: 38 * GB, age: 86400 });
addTorrent('Court.Métrage.2023.720p.WEB-MOCK', { category: 'films', progress: 0, state: 'queuedDL', size: 0.9 * GB, age: 60 });

const DOWN = /^(downloading|forcedDL|metaDL|forcedMetaDL)$/;
setInterval(() => {
  let down = 0;
  let up = 0;
  for (const t of torrents.values()) {
    if (t.state === 'metaDL') {
      t.state = 'downloading';
      continue;
    }
    if (DOWN.test(t.state)) {
      const step = t.rate * (server.use_alt_speed_limits ? 0.25 : 1) * (0.6 + Math.random() * 0.8);
      t.progress = Math.min(1, t.progress + step);
      t.dlspeed = Math.round(step * t.size);
      t.eta = t.dlspeed ? Math.round(((1 - t.progress) * t.size) / t.dlspeed) : 8640000;
      if (t.progress >= 1) {
        t.state = 'uploading';
        t.dlspeed = 0;
        t.eta = 8640000;
        t.completion_on = Math.floor(Date.now() / 1000);
        renumber();
      }
    } else t.dlspeed = 0;
    if (/^(uploading|forcedUP|stalledUP)$/.test(t.state)) {
      t.upspeed = Math.round(Math.random() * 600_000);
      t.ratio = +(t.ratio + t.upspeed / t.size).toFixed(3);
    } else t.upspeed = 0;
    if (t.state === 'checkingDL' || t.state === 'checkingUP') t.state = t.progress >= 1 ? 'stalledUP' : 'downloading';
    down += t.dlspeed;
    up += t.upspeed;
  }
  server.dl_info_speed = down;
  server.up_info_speed = up;
  server.dl_info_data += down;
  server.up_info_data += up;
}, 1000);

// ---- sync/maindata: snapshots per rid, answered as diffs ----
const view = (t) => {
  const { rate: _rate, ...rest } = t;
  return rest;
};
const snapshot = () => ({
  torrents: Object.fromEntries([...torrents].map(([h, t]) => [h, view(t)])),
  categories: structuredClone(categories),
  server: { ...server },
});
const history = new Map();
let rid = 0;
function maindata(since) {
  const now = snapshot();
  const prev = history.get(since);
  rid++;
  history.set(rid, now);
  for (const k of history.keys()) if (k < rid - 20) history.delete(k);
  if (!prev) return { rid, full_update: true, torrents: now.torrents, categories: now.categories, server_state: now.server, tags: [] };
  const out = { rid };
  const changed = (a = {}, b) => Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)));
  const t = {};
  for (const [h, v] of Object.entries(now.torrents)) {
    const d = changed(prev.torrents[h], v);
    if (Object.keys(d).length) t[h] = d;
  }
  if (Object.keys(t).length) out.torrents = t;
  const removed = Object.keys(prev.torrents).filter((h) => !now.torrents[h]);
  if (removed.length) out.torrents_removed = removed;
  const c = {};
  for (const [n, v] of Object.entries(now.categories)) if (JSON.stringify(prev.categories[n]) !== JSON.stringify(v)) c[n] = v;
  if (Object.keys(c).length) out.categories = c;
  const cr = Object.keys(prev.categories).filter((n) => !now.categories[n]);
  if (cr.length) out.categories_removed = cr;
  const s = changed(prev.server, now.server);
  if (Object.keys(s).length) out.server_state = s;
  return out;
}

// ---- HTTP plumbing ----
function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Fields of an urlencoded or multipart body; files come back as { filename, data }.
function parseForm(req, buf) {
  const type = req.headers['content-type'] ?? '';
  const fields = {};
  const files = [];
  const m = type.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!m) {
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) fields[k] = v;
    return { fields, files };
  }
  const raw = buf.toString('latin1');
  for (const part of raw.split(`--${m[1] ?? m[2]}`)) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    const content = part.slice(sep + 4).replace(/\r\n$/, '');
    const name = head.match(/name="([^"]*)"/)?.[1];
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    if (filename !== undefined) files.push({ filename: Buffer.from(filename, 'latin1').toString('utf8'), data: Buffer.from(content, 'latin1') });
    else fields[name] = Buffer.from(content, 'latin1').toString('utf8');
  }
  return { fields, files };
}

const send = (res, status, payload, type = 'text/plain; charset=UTF-8', headers = {}) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? type : 'application/json', ...headers });
  res.end(text);
};

const sid = (req) => (req.headers.cookie ?? '').match(/(?:^|;\s*)SID=([^;]+)/)?.[1];
const selected = (fields) => (fields.hashes === 'all' ? [...torrents.keys()] : String(fields.hashes ?? '').split('|').filter((h) => torrents.has(h)));
const truthy = (v) => v === 'true';

const TLS = process.env.MOCK_QBIT_TLS;
const createServer = (handler) =>
  TLS ? https.createServer({ key: fs.readFileSync(path.join(TLS, 'key.pem')), cert: fs.readFileSync(path.join(TLS, 'cert.pem')) }, handler) : http.createServer(handler);

createServer(async (req, res) => {
    const url = new URL(req.url, `${TLS ? 'https' : 'http'}://${req.headers.host}`);
    const p = url.pathname;
    const buf = await body(req);
    const { fields, files } = req.method === 'POST' ? parseForm(req, buf) : { fields: Object.fromEntries(url.searchParams), files: [] };
    console.log(`${req.method} ${p}${url.search} origin=${req.headers.origin ?? '-'} referer=${req.headers.referer ?? '-'} sid=${sid(req) ? 'yes' : 'no'}`);

    if (p === '/mock/expire') {
      sessions.clear();
      return send(res, 200, 'expired');
    }
    // CSRF check like qBittorrent: a present Origin/Referer must match the Host.
    for (const h of [req.headers.origin, req.headers.referer]) {
      if (h && new URL(h).host !== req.headers.host) return send(res, 401, 'Unauthorized');
    }
    if (p === '/api/v2/auth/login') {
      if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');
      if (fields.username !== 'admin' || fields.password !== 'adminadmin') return send(res, 200, 'Fails.');
      const id = randomBytes(16).toString('base64url');
      sessions.add(id);
      return send(res, 200, 'Ok.', undefined, { 'Set-Cookie': `SID=${id}; HttpOnly; SameSite=Strict; path=/` });
    }
    if (!sessions.has(sid(req))) return send(res, 403, 'Forbidden');

    const hs = selected(fields);
    const ok = () => send(res, 200, '');
    switch (p) {
      case '/api/v2/auth/logout':
        sessions.delete(sid(req));
        return ok();
      case '/api/v2/app/version':
        return send(res, 200, `v${VERSION}`);
      case '/api/v2/app/webapiVersion':
        return send(res, 200, API);
      case '/api/v2/app/defaultSavePath':
        return send(res, 200, 'D:\\Torrents');
      case '/api/v2/sync/maindata':
        return send(res, 200, maindata(Number(url.searchParams.get('rid') ?? 0)));
      case '/api/v2/torrents/categories':
        return send(res, 200, categories);
      case '/api/v2/transfer/toggleSpeedLimitsMode':
        server.use_alt_speed_limits = !server.use_alt_speed_limits;
        return ok();
      case '/api/v2/transfer/speedLimitsMode':
        return send(res, 200, server.use_alt_speed_limits ? '1' : '0');
      case '/api/v2/torrents/add': {
        const stopped = truthy(fields.stopped) || truthy(fields.paused);
        const added = [];
        for (const link of String(fields.urls ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
          const q = new URLSearchParams(link.replace(/^magnet:\?/, ''));
          const btih = q.get('xt')?.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
          added.push(addTorrent(q.get('dn') ?? btih ?? 'Torrent', { hash: btih, category: fields.category, state: stopped ? STOP_DL : 'metaDL', size: 2 * GB, rate: 0.02 }));
        }
        for (const f of files) {
          if (f.data[0] !== 0x64) return send(res, 415, 'Torrent file is not valid.');
          added.push(addTorrent(f.filename.replace(/\.torrent$/i, ''), { category: fields.category, state: stopped ? STOP_DL : 'downloading', size: 3 * GB, rate: 0.02 }));
        }
        if (!added.length) return send(res, 200, 'Fails.');
        for (const h of added) {
          const t = torrents.get(h);
          if (fields.savepath) t.save_path = fields.savepath;
          t.seq_dl = truthy(fields.sequentialDownload);
          t.f_l_piece_prio = truthy(fields.firstLastPiecePrio);
        }
        return send(res, 200, 'Ok.');
      }
      case '/api/v2/torrents/delete':
        for (const h of hs) torrents.delete(h);
        renumber();
        return ok();
      case '/api/v2/torrents/recheck':
        for (const h of hs) torrents.get(h).state = torrents.get(h).progress >= 1 ? 'checkingUP' : 'checkingDL';
        return ok();
      case '/api/v2/torrents/setForceStart':
        for (const h of hs) {
          const t = torrents.get(h);
          t.force_start = truthy(fields.value);
          if (t.force_start) t.state = t.progress >= 1 ? 'forcedUP' : 'forcedDL';
          else if (t.state === 'forcedDL' || t.state === 'forcedUP') t.state = t.progress >= 1 ? 'uploading' : 'downloading';
        }
        return ok();
      case '/api/v2/torrents/setCategory':
        if (fields.category && !categories[fields.category]) return send(res, 409, 'Incorrect category name');
        for (const h of hs) torrents.get(h).category = fields.category ?? '';
        return ok();
      case '/api/v2/torrents/toggleSequentialDownload':
        for (const h of hs) torrents.get(h).seq_dl = !torrents.get(h).seq_dl;
        return ok();
      case '/api/v2/torrents/toggleFirstLastPiecePrio':
        for (const h of hs) torrents.get(h).f_l_piece_prio = !torrents.get(h).f_l_piece_prio;
        return ok();
      case '/api/v2/torrents/increasePrio':
      case '/api/v2/torrents/decreasePrio': {
        if (process.env.MOCK_QBIT_NOQUEUE) return send(res, 409, 'Torrent queueing must be enabled');
        const dir = p.endsWith('increasePrio') ? -1.5 : 1.5;
        for (const h of hs) if (torrents.get(h).priority > 0) torrents.get(h).priority += dir;
        renumber();
        return ok();
      }
    }
    const stop = V5 ? '/api/v2/torrents/stop' : '/api/v2/torrents/pause';
    const start = V5 ? '/api/v2/torrents/start' : '/api/v2/torrents/resume';
    if (p === stop) {
      for (const h of hs) {
        const t = torrents.get(h);
        t.state = t.progress >= 1 ? STOP_UP : STOP_DL;
        t.force_start = false;
      }
      return ok();
    }
    if (p === start) {
      for (const h of hs) {
        const t = torrents.get(h);
        if (t.state === STOP_DL || t.state === STOP_UP) t.state = t.progress >= 1 ? 'stalledUP' : 'downloading';
      }
      return ok();
    }
    return send(res, 404, 'Not Found');
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock qBittorrent ${VERSION} (API ${API}) on ${TLS ? 'https' : 'http'}://127.0.0.1:${PORT}  admin / adminadmin`));
