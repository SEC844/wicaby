// Mock Immich server (photos spec PH-11), loopback only. Written by hand from the published HTTP API reference
// (paths, parameters, JSON field names, permission scopes); no file, string or structure comes from the Immich
// repository. The photos are the generated PH-00 set (photos-fixture.mjs): rendered on the fly, EXIF and GPS made up
// around public landmarks. Never log a coordinate.
//
//   PORT (argv[2])               default 2283
//   MOCK_IMMICH_KEY              the one valid API key (default "mock-immich-key"; a test value, not a secret)
//   MOCK_IMMICH_SCOPES           comma list of the key's permissions (default: every scope below)
//   MOCK_IMMICH_VERSION          the version /api/server/version reports (default 3.3.0)
//   MOCK_IMMICH_TIMELINE=broken  /api/timeline/bucket answers rows instead of columns (tests the client fallback)
//   MOCK_IMMICH_VIDEO=<file>     the bytes every /video/playback serves (with Range); without it, 404
//   MOCK_PHOTOS, MOCK_PHOTOS_SEED, MOCK_TODAY  as in photos-fixture.mjs (the same assets as the Emby mock)
// Tags (a run's log reads as a bug list): KEY-IN-URL (a key in a query string), NO-KEY, BAD-KEY, SCOPE (a 403),
// FLAT-FIELDS (search/smart without the filter object), UNMAPPED.
// Mock routes (no auth): GET /Mock/State (calls and tags), POST /Mock/Reset.
// Usage: node tools/mock-server/mock-immich.mjs [port]   or   import { startMockImmich } from './mock-immich.mjs'
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { png } from './cbz-fixture.mjs';
import { addPhotos, photoPng } from './photos-fixture.mjs';

export const IMMICH_KEY = process.env.MOCK_IMMICH_KEY || 'mock-immich-key';
export const SCOPES = ['asset.read', 'asset.view', 'asset.download', 'asset.update', 'album.read', 'person.read', 'map.read', 'memory.read', 'partner.read'];
const VERSION = process.env.MOCK_IMMICH_VERSION || '3.3.0';
const BROKEN = process.env.MOCK_IMMICH_TIMELINE === 'broken';
const APEX = process.env.MOCK_APERTURE !== 'fnumber';
const VIDEO = process.env.MOCK_IMMICH_VIDEO || '';
const granted = new Set((process.env.MOCK_IMMICH_SCOPES ?? SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean));

// Public landmarks the fixture's positions cluster around, for the place names Immich derives on its own server.
const PLACES = [
  ['Paris', 'Île-de-France', 'France', 48.8584, 2.2945],
  ['Lyon', 'Auvergne-Rhône-Alpes', 'France', 45.7623, 4.8227],
  ['Lisbon', 'Lisbon', 'Portugal', 38.6916, -9.216],
  ['Reykjavík', 'Capital Region', 'Iceland', 64.1417, -21.9266],
  ['Kyoto', 'Kyoto', 'Japan', 34.9949, 135.785],
  ['Chamonix-Mont-Blanc', 'Auvergne-Rhône-Alpes', 'France', 45.8326, 6.8652],
];
const PEOPLE = ['Alex', 'Camille', 'Sam', 'Noa'];

const uuid = (s) => {
  const h = crypto.createHash('sha1').update(`immich-mock:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (ms) => `${Math.floor(ms / 3_600_000)}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.000000`;

// ---- Dataset: the PH-00 photos as Immich assets ----
const source = new Map();
const favs = new Set();
addPhotos({ add: (it) => source.set(it.Id, it), ud: (id) => ({ set IsFavorite(v) { if (v) favs.add(id); } }) });

const assets = [];
const byId = new Map();
const albums = [];
let k = 0;
for (const it of source.values()) {
  if (it.Type === 'PhotoAlbum') {
    albums.push({ src: it.Id, id: uuid(it.Id), albumName: it.Name, assets: [], shared: albums.length === 0 });
    continue;
  }
  if (it.Type !== 'Photo' && it.Type !== 'Video') continue;
  const created = Date.parse(it.DateCreated);
  const wall = it.PremiereDate ? Date.parse(it.PremiereDate.replace(/\.\d+Z$/, 'Z')) : created;
  const offset = Math.round((wall - created) / 3_600_000);
  const turn = it.ImageOrientation === 'RightTop' || it.ImageOrientation === 'LeftBottom';
  const near = it.Latitude == null ? null : PLACES.reduce((b, p) => (Math.hypot(p[3] - it.Latitude, p[4] - it.Longitude) < Math.hypot(b[3] - it.Latitude, b[4] - it.Longitude) ? p : b));
  const n = k++;
  const a = {
    src: it.Id,
    id: uuid(it.Id),
    type: it.Type === 'Video' ? 'VIDEO' : 'IMAGE',
    originalFileName: `${it.Name}.${it.Container ?? 'jpg'}`,
    fileCreatedAt: new Date(created).toISOString(),
    localDateTime: new Date(wall).toISOString(),
    offset,
    ratio: turn ? it.Height / it.Width : it.Width / it.Height,
    durationMs: it.RunTimeTicks ? it.RunTimeTicks / 10_000 : 0,
    // About 3 % archived: never on the timeline (spec PH-12 AC 6).
    visibility: n % 33 === 5 ? 'archive' : 'timeline',
    album: it.ParentId,
    people: PEOPLE.map((_, p) => p).filter((p) => (n * 7 + p * 3) % 11 === 0),
    exif: {
      make: it.CameraMake ?? null,
      model: it.CameraModel ?? null,
      exifImageWidth: it.Width,
      exifImageHeight: it.Height,
      orientation: it.ImageOrientation === 'RightTop' ? '6' : it.ImageOrientation === 'LeftBottom' ? '8' : '1',
      dateTimeOriginal: new Date(created).toISOString(),
      exposureTime: it.ExposureTime ? (it.ExposureTime >= 1 ? String(it.ExposureTime) : `1/${Math.round(1 / it.ExposureTime)}`) : null,
      // The fixture writes APEX (Av = 2·log2 N) unless MOCK_APERTURE=fnumber; Immich reports the f-number.
      fNumber: it.Aperture ? Math.round((APEX ? 2 ** (it.Aperture / 2) : it.Aperture) * 10) / 10 : null,
      focalLength: it.FocalLength ?? null,
      iso: it.IsoSpeedRating ?? null,
      latitude: it.Latitude ?? null,
      longitude: it.Longitude ?? null,
      city: near?.[0] ?? null,
      state: near?.[1] ?? null,
      country: near?.[2] ?? null,
    },
  };
  assets.push(a);
  byId.set(a.id, a);
}
for (const a of assets) albums.find((al) => al.src === a.album)?.assets.push(a);
const people = PEOPLE.map((name, p) => ({ id: uuid(`person-${p}`), name, p }));
const personById = new Map(people.map((x) => [x.id, x]));
const newestFirst = (a, b) => (a.localDateTime < b.localDateTime ? 1 : a.localDateTime > b.localDateTime ? -1 : 0);
assets.sort(newestFirst);

// ---- Shapes ----
const assetDto = (a) => ({
  id: a.id,
  type: a.type,
  originalFileName: a.originalFileName,
  fileCreatedAt: a.fileCreatedAt,
  localDateTime: a.localDateTime,
  isFavorite: favs.has(a.src),
  visibility: a.visibility,
  isTrashed: false,
  duration: hms(a.durationMs),
  livePhotoVideoId: null,
  thumbhash: null,
  exifInfo: a.exif,
  people: a.people.map((p) => ({ id: people[p].id, name: people[p].name })),
});
const albumDto = (al) => ({
  id: al.id,
  albumName: al.albumName,
  albumThumbnailAssetId: al.assets[0]?.id ?? null,
  assetCount: al.assets.length,
  // v3 renamed shared to isShared.
  ...(Number(VERSION.split('.')[0]) >= 3 ? { isShared: al.shared } : { shared: al.shared }),
  owner: { name: al.shared ? 'Camille' : 'Wika' },
  startDate: al.assets.at(-1)?.localDateTime ?? null,
  endDate: al.assets[0]?.localDateTime ?? null,
});

// The filters the timeline and search routes share.
function filtered(f) {
  return assets.filter((a) => {
    if (f.visibility && a.visibility !== f.visibility) return false;
    if (f.isFavorite !== undefined && favs.has(a.src) !== f.isFavorite) return false;
    if (f.albumId && albums.find((al) => al.id === f.albumId)?.src !== a.album) return false;
    if (f.personId && !a.people.includes(personById.get(f.personId)?.p ?? -1)) return false;
    return true;
  });
}
const queryFilter = (q) => ({
  visibility: q.get('visibility') || undefined,
  isFavorite: q.has('isFavorite') ? q.get('isFavorite') === 'true' : undefined,
  albumId: q.get('albumId') || undefined,
  personId: q.get('personId') || undefined,
});
const bucketOf = (a) => `${a.localDateTime.slice(0, 7)}-01`;

// ---- Server ----
const state = { calls: [], tags: [] };
const tag = (name, detail) => (state.tags.push({ tag: name, detail }), console.log(`[immich] ${name} ${detail}`));
const SCOPE_OF = [
  [/^GET \/api\/timeline\/buckets?$/, 'asset.read'],
  [/^GET \/api\/assets\/[0-9a-f-]{36}$/, 'asset.read'],
  [/^POST \/api\/search\/(metadata|smart)$/, 'asset.read'],
  [/^GET \/api\/assets\/[0-9a-f-]{36}\/(thumbnail|video\/playback)$/, 'asset.view'],
  [/^GET \/api\/assets\/[0-9a-f-]{36}\/original$/, 'asset.download'],
  [/^PUT \/api\/assets$/, 'asset.update'],
  [/^GET \/api\/albums(\/[0-9a-f-]{36})?$/, 'album.read'],
  [/^GET \/api\/people(\/[0-9a-f-]{36}\/thumbnail)?$/, 'person.read'],
  [/^GET \/api\/map\/markers$/, 'map.read'],
  [/^GET \/api\/memories$/, 'memory.read'],
  [/^GET \/api\/partners$/, 'partner.read'],
];

function send(res, status, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(type === 'application/json' ? JSON.stringify(body) : String(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
}
const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
  });

function image(res, a, size) {
  const [w, h] = size === 'thumbnail' ? [0, 250] : size === 'fullsize' || size === 'original' ? [0, 0] : [1440, 1440];
  const data = photoPng(a.src, w, h, true);
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400' });
  res.end(data);
}

// A face-like placeholder: a head and shoulders on a plain background, one colour per person.
const BACKS = [[196, 120, 90], [90, 140, 196], [110, 170, 120], [170, 110, 180]];
const face = (p) => png(160, 160, (x, y) => ((x - 80) ** 2 + (y - 70) ** 2 < 45 ** 2 ? [235, 200, 170] : (x - 80) ** 2 + (y - 190) ** 2 < 85 ** 2 ? [60, 70, 90] : BACKS[p]));

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const q = url.searchParams;
  const key = req.headers['x-api-key'];
  state.calls.push({ method: req.method, path: p, query: url.search, key: key === IMMICH_KEY });
  if (state.calls.length > 2000) state.calls.shift();
  for (const name of q.keys()) if (/^(api_?key|key|apiKey|x-api-key)$/i.test(name)) tag('KEY-IN-URL', p);

  if (p === '/Mock/State') return send(res, 200, state);
  if (p === '/Mock/Reset' && req.method === 'POST') return (state.calls = []), (state.tags = []), send(res, 204, '');
  if (p === '/api/server/version' && req.method === 'GET') {
    const [major, minor, patch] = VERSION.split('.').map(Number);
    return send(res, 200, { major, minor, patch });
  }
  if (!p.startsWith('/api/')) return tag('UNMAPPED', `${req.method} ${p}`), send(res, 404, { message: 'Not found', statusCode: 404 });
  if (!key) return tag('NO-KEY', p), send(res, 401, { message: 'Authentication required', statusCode: 401 });
  if (key !== IMMICH_KEY) return tag('BAD-KEY', p), send(res, 401, { message: 'Invalid API key', statusCode: 401 });
  const scope = SCOPE_OF.find(([re]) => re.test(`${req.method} ${p}`))?.[1];
  if (!scope) return tag('UNMAPPED', `${req.method} ${p}`), send(res, 404, { message: 'Not found', statusCode: 404 });
  if (!granted.has(scope)) return tag('SCOPE', scope), send(res, 403, { message: `Missing required permission: ${scope}`, statusCode: 403 });

  const parts = p.split('/').slice(2);
  if (parts[0] === 'timeline' && parts[1] === 'buckets') {
    const counts = new Map();
    for (const a of filtered(queryFilter(q))) counts.set(bucketOf(a), (counts.get(bucketOf(a)) ?? 0) + 1);
    return send(res, 200, [...counts].map(([timeBucket, count]) => ({ timeBucket, count })));
  }
  if (parts[0] === 'timeline' && parts[1] === 'bucket') {
    const tb = (q.get('timeBucket') ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(tb)) return send(res, 400, { message: ['timeBucket must be a date'], statusCode: 400 });
    const list = filtered(queryFilter(q)).filter((a) => a.localDateTime.startsWith(tb));
    if (BROKEN) return send(res, 200, { bucket: tb, assets: list.map((a) => ({ assetId: a.id, takenAt: a.localDateTime })) });
    const col = (f) => list.map(f);
    return send(res, 200, {
      id: col((a) => a.id),
      ownerId: col(() => uuid('owner')),
      ratio: col((a) => a.ratio),
      isFavorite: col((a) => favs.has(a.src)),
      visibility: col((a) => a.visibility),
      isTrashed: col(() => false),
      isImage: col((a) => a.type === 'IMAGE'),
      thumbhash: col(() => null),
      fileCreatedAt: col((a) => a.fileCreatedAt),
      localOffsetHours: col((a) => a.offset),
      duration: col((a) => (a.type === 'VIDEO' ? hms(a.durationMs) : null)),
      projectionType: col(() => null),
      livePhotoVideoId: col(() => null),
      city: col((a) => a.exif.city),
      country: col((a) => a.exif.country),
      latitude: col((a) => a.exif.latitude),
      longitude: col((a) => a.exif.longitude),
    });
  }
  if (parts[0] === 'assets' && parts.length === 1 && req.method === 'PUT') {
    const b = await body(req).catch(() => null);
    if (!b || !Array.isArray(b.ids) || typeof b.isFavorite !== 'boolean') return send(res, 400, { message: 'Bad request', statusCode: 400 });
    for (const id of b.ids) {
      const a = byId.get(id);
      if (a) b.isFavorite ? favs.add(a.src) : favs.delete(a.src);
    }
    return send(res, 204, '');
  }
  if (parts[0] === 'assets') {
    const a = byId.get(parts[1]);
    if (!a) return send(res, 404, { message: 'Asset not found', statusCode: 404 });
    if (parts.length === 2) return send(res, 200, assetDto(a));
    if (parts[2] === 'thumbnail') return image(res, a, q.get('size') ?? 'thumbnail');
    if (parts[2] === 'original') return image(res, a, 'original');
    if (parts[2] === 'video') {
      if (a.type !== 'VIDEO' || !VIDEO || !fs.existsSync(VIDEO)) return send(res, 404, { message: 'No video', statusCode: 404 });
      const size = fs.statSync(VIDEO).size;
      const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = r ? Number(r[1]) : 0;
      const end = r && r[2] ? Number(r[2]) : size - 1;
      res.writeHead(r ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      return fs.createReadStream(VIDEO, { start, end }).pipe(res);
    }
  }
  if (parts[0] === 'albums') {
    if (parts[1]) {
      const al = albums.find((x) => x.id === parts[1]);
      return al ? send(res, 200, albumDto(al)) : send(res, 404, { message: 'Album not found', statusCode: 404 });
    }
    return send(res, 200, albums.filter((al) => q.get('shared') !== 'true' || al.shared).map(albumDto));
  }
  if (parts[0] === 'people') {
    if (parts[2] === 'thumbnail') {
      const x = personById.get(parts[1]);
      if (!x) return send(res, 404, { message: 'Person not found', statusCode: 404 });
      const data = face(x.p);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
      return res.end(data);
    }
    return send(res, 200, { total: people.length, hidden: 0, people: people.map((x) => ({ id: x.id, name: x.name, isHidden: false, thumbnailPath: `/upload/thumbs/${x.id}.jpeg` })) });
  }
  if (parts[0] === 'map') {
    const visible = assets.filter((a) => a.exif.latitude != null && (q.get('isArchived') === 'true' || a.visibility === 'timeline'));
    return send(res, 200, visible.map((a) => ({ id: a.id, lat: a.exif.latitude, lon: a.exif.longitude, city: a.exif.city, state: a.exif.state, country: a.exif.country })));
  }
  if (parts[0] === 'memories') {
    const today = (q.get('for') ?? process.env.MOCK_TODAY ?? new Date().toISOString()).slice(0, 10);
    const md = today.slice(5, 10);
    const year = Number(today.slice(0, 4));
    const byYear = new Map();
    for (const a of assets) {
      if (a.visibility !== 'timeline' || a.localDateTime.slice(5, 10) !== md || Number(a.localDateTime.slice(0, 4)) >= year) continue;
      const y = Number(a.localDateTime.slice(0, 4));
      byYear.set(y, [...(byYear.get(y) ?? []), a]);
    }
    return send(res, 200, [...byYear].sort((x, y) => y[0] - x[0]).map(([y, list]) => ({ id: uuid(`memory-${y}`), type: 'on_this_day', data: { year: y }, memoryAt: `${y}-${md}T00:00:00.000Z`, isSaved: false, assets: list.map(assetDto) })));
  }
  if (parts[0] === 'partners') return send(res, 200, []);
  if (parts[0] === 'search') {
    const b = await body(req).catch(() => null);
    if (!b || typeof b !== 'object') return send(res, 400, { message: 'Bad request', statusCode: 400 });
    if (parts[1] === 'smart') {
      // v3.2: the filters go in a filter object; the old flat fields are refused here.
      const flat = Object.keys(b).filter((x) => !['query', 'filter', 'page', 'size'].includes(x));
      if (flat.length || (b.filter !== undefined && (typeof b.filter !== 'object' || Array.isArray(b.filter)))) return tag('FLAT-FIELDS', flat.join(',')), send(res, 400, { message: `Use the filter object: ${flat.join(', ')}`, statusCode: 400 });
      const words = String(b.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const f = b.filter ?? {};
      const hits = filtered({ visibility: f.visibility ?? 'timeline', isFavorite: f.isFavorite }).filter((a) => words.every((w) => [a.type === 'VIDEO' ? 'video' : 'photo', a.exif.city, a.exif.country].some((s) => s?.toLowerCase().includes(w))));
      return send(res, 200, { assets: { total: hits.length, count: Math.min(hits.length, 100), items: hits.slice(0, 100).map(assetDto), nextPage: null, facets: [] }, albums: { total: 0, count: 0, items: [], facets: [] } });
    }
    // metadata: page / size paging, newest first unless order=asc.
    const size = Math.min(1000, Math.max(1, Number(b.size) || 250));
    const page = Math.max(1, Number(b.page) || 1);
    let list = filtered({ visibility: b.visibility, isFavorite: b.isFavorite, albumId: b.albumIds?.[0], personId: b.personIds?.[0] });
    if (b.order === 'asc') list = [...list].reverse();
    const items = list.slice((page - 1) * size, page * size);
    return send(res, 200, {
      assets: { total: list.length, count: items.length, items: items.map(assetDto), nextPage: page * size < list.length ? String(page + 1) : null, facets: [] },
      albums: { total: 0, count: 0, items: [], facets: [] },
    });
  }
  return tag('UNMAPPED', `${req.method} ${p}`), send(res, 404, { message: 'Not found', statusCode: 404 });
}

// Starts on 127.0.0.1 (port 0: a free one). Resolves { port, close, assets, albums, people }.
export function startMockImmich(opts = {}) {
  const srv = http.createServer((req, res) =>
    handle(req, res).catch((err) => {
      console.error('[immich] handler failed', err);
      if (!res.headersSent) send(res, 500, { message: 'Internal error', statusCode: 500 });
    }),
  );
  return new Promise((resolve) =>
    srv.listen(opts.port ?? 2283, '127.0.0.1', () =>
      resolve({ port: srv.address().port, close: () => new Promise((r) => (srv.closeAllConnections(), srv.close(() => r()))), assets, albums, people, favs }),
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { port } = await startMockImmich({ port: Number(process.argv[2] ?? process.env.PORT ?? 2283) });
  console.log(`mock-immich ${VERSION}: ${assets.length} assets, ${albums.length} albums, ${people.length} people on http://127.0.0.1:${port}`);
}
