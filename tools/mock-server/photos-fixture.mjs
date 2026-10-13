// Generated demo photos for the mocks (photos spec PH-00). Never real photos: every item, EXIF value and position is
// made up from a seeded PRNG at start, and every image is rendered on the fly. Nothing binary is committed.
//   MOCK_PHOTOS        assets in "Photos de famille" (default 600; 0 turns the photo libraries off)
//   MOCK_PHOTOS_SEED   PRNG seed (default 1)
//   MOCK_TODAY         YYYY-MM-DD for the "on this day" assets (default: the mock's local start date)
//   MOCK_APERTURE      apex (default: Aperture/ShutterSpeed as APEX values, Jellyfin's TagLib case) or fnumber
//   MOCK_PHOTO_ROTATE  client (default: 90° assets come back unrotated) or server (pre-rotated pixels)
//   MOCK_NO_DOWNLOAD=1 /Items/{id}/Download answers 403 (the user lacks the download right)
//   MOCK_DEMO_LANG=en  English album names
// Positions cluster around public landmarks only. Never log them.
import { png } from './cbz-fixture.mjs';

const COUNT = Number(process.env.MOCK_PHOTOS ?? 600);
const SEED = Number(process.env.MOCK_PHOTOS_SEED ?? 1);
const APEX = process.env.MOCK_APERTURE !== 'fnumber';
const SERVER_ROTATE = process.env.MOCK_PHOTO_ROTATE === 'server';
const NO_DOWNLOAD = process.env.MOCK_NO_DOWNLOAD === '1';
const EN = (process.env.MOCK_DEMO_LANG ?? (process.env.MOCK_DATASET === 'demo' ? 'en' : 'fr')).toLowerCase().startsWith('en');
const LEGACY_COUNT = 40;
export const PHOTO_LIB = 'lib-photos';
export const LEGACY_LIB = 'lib-photos-legacy';

// [name, lat, lon, UTC offset in hours (fixed: fake data needs no DST), altitude range in metres]
const PLACES = [
  ['eiffel', 48.8584, 2.2945, 1, [30, 60]],
  ['fourviere', 45.7623, 4.8227, 1, [250, 300]],
  ['belem', 38.6916, -9.216, 0, [0, 20]],
  ['hallgrimskirkja', 64.1417, -21.9266, 0, [20, 80]],
  ['kiyomizu', 34.9949, 135.785, 9, [50, 120]],
  ['montblanc', 45.8326, 6.8652, 1, [1500, 2500]],
];
const ALBUMS = EN ? ['Holidays 2019', 'Mountains', 'Birthdays', 'Garden', 'City', 'Misc'] : ['Vacances 2019', 'Montagne', 'Anniversaires', 'Jardin', 'Ville', 'Divers'];
// [stored width, stored height, weight]: 3:2, 2:3, 4:3, 3:4, 16:9, 1:1 and 4:1 panoramas.
const SHAPES = [[6000, 4000, 30], [4000, 6000, 15], [4032, 3024, 20], [3024, 4032, 15], [3840, 2160, 10], [3000, 3000, 7], [8000, 2000, 3]];
const MODELS = ['Model A', 'Model B', 'Phone X'];
const EXPOSURES = [1 / 60, 1 / 250, 1 / 1000, 2];
const FNUMBERS = [1.8, 2.8, 4, 5.6, 8, 11];
const ISOS = [100, 200, 400, 800, 1600, 3200, 6400];
// Jellyfin sends a BlurHash per image; one fixed value per hue band is enough for placeholders.
const BLURHASHES = ['LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'LGF5]+Yk^6#M@-5c,1J5@[or[Q6.', 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH'];

// id -> { w, h, turn (0, 90 or 270: the clockwise turn that shows it upright), hue }
const meta = new Map();
const isPhoto = (id) => meta.has(id);
export const photoCount = () => (COUNT > 0 ? COUNT : 0);

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
// Spread neighbouring ids (photo-1, photo-2…) round the colour wheel.
const hueOf = (id) => (Math.imul(hash(id), 2654435761) >>> 0) % 360;
const pad = (n, w = 2) => String(n).padStart(w, '0');
// Wall-clock fields as both servers store an EXIF date (no zone).
const wallClock = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function today() {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(process.env.MOCK_TODAY ?? '');
  const d = new Date();
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

// Adds the libraries through mock-emby's own add() and ud(). Returns the number of assets added.
export function addPhotos({ add, ud }) {
  if (COUNT <= 0) return 0;
  const rnd = mulberry32(SEED);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const [ty, tm, td] = today();
  const start = Date.UTC(2014, 0, 1);
  const end = Date.UTC(ty, tm - 1, td);
  const tag = (id, w, h) => hash(`${id}:${w}x${h}`).toString(16).padStart(8, '0');

  add({ Id: PHOTO_LIB, Name: EN ? 'Family photos' : 'Photos de famille', Type: 'CollectionFolder', CollectionType: 'homevideos', IsFolder: true, ImageTags: { Primary: 't' } });
  add({ Id: LEGACY_LIB, Name: EN ? 'Old photos' : 'Anciennes photos', Type: 'CollectionFolder', CollectionType: 'photos', IsFolder: true, ImageTags: { Primary: 't' } });
  const albumIds = ALBUMS.map((name, k) => {
    const Id = `photo-album-${k}`;
    meta.set(Id, { w: 6000, h: 4000, turn: 0, hue: hueOf(Id) });
    add({ Id, Name: name, Type: 'PhotoAlbum', IsFolder: true, ParentId: PHOTO_LIB, Path: `/photos/${name}`, ImageTags: { Primary: tag(Id, 6000, 4000) }, ChildCount: 0, DateCreated: new Date(end).toISOString() });
    return Id;
  });

  const make = (Id, ParentId, i, opts = {}) => {
    const geo = rnd() < 0.6 ? pick(PLACES) : null;
    const offset = geo ? geo[3] : 1;
    // "On this day": about 10 assets on today's month and day 1, 3 and 7 years ago (first 30 of the library).
    const memYears = [1, 3, 7][Math.floor(i / 10)];
    const dayMs = opts.memories && memYears ? Date.UTC(ty - memYears, tm - 1, Math.min(td, new Date(Date.UTC(ty - memYears, tm, 0)).getUTCDate())) : start + Math.floor(rnd() * ((end - start) / 86_400_000)) * 86_400_000;
    const local = new Date(dayMs + Math.floor((7 + rnd() * 15) * 3_600_000));
    const taken = wallClock(local);
    const created = new Date(local.getTime() - offset * 3_600_000).toISOString().replace(/\.\d+Z$/, '.0000000Z');
    const video = opts.video ?? rnd() < 0.04;
    const r = rnd() * 100;
    let acc = 0;
    let [w, h] = SHAPES.find(([, , wt]) => (acc += wt) > r) ?? SHAPES[0];
    if (video) [w, h] = rnd() < 0.7 ? [1920, 1080] : [1080, 1920];
    // 8 % lie on their side: unrotated landscape pixels and a 90° orientation, as a phone held upright writes them.
    const sideways = !video && rnd() < 0.08;
    const orientation = sideways ? pick(['RightTop', 'LeftBottom']) : 'TopLeft';
    if (sideways) [w, h] = [4032, 3024];
    meta.set(Id, { w, h, turn: orientation === 'RightTop' ? 90 : orientation === 'LeftBottom' ? 270 : 0, hue: hueOf(Id) });
    const base = opts.base ?? `${video ? 'VID' : 'IMG'}_${pad(i + 1, 4)}`;
    const ext = opts.ext ?? (video ? 'MP4' : 'JPG');
    const item = {
      Id,
      Name: base,
      Type: video ? 'Video' : 'Photo',
      MediaType: video ? 'Video' : 'Photo',
      ParentId,
      Path: `/photos/${ParentId}/${base}.${ext}`,
      Container: ext.toLowerCase(),
      Width: w,
      Height: h,
      PrimaryImageAspectRatio: w / h,
      ImageTags: { Primary: tag(Id, w, h) },
      DateCreated: created,
      // 5 % carry no EXIF date: only the file date (DateCreated).
      PremiereDate: rnd() < 0.05 ? undefined : `${taken}.0000000Z`,
      ProductionYear: local.getUTCFullYear(),
    };
    if (video) item.RunTimeTicks = Math.round(5 + rnd() * 55) * 10_000_000;
    else {
      const t = pick(EXPOSURES);
      const f = pick(FNUMBERS);
      Object.assign(item, {
        CameraMake: 'Wicaby Test',
        CameraModel: pick(MODELS),
        Software: 'Wicaby Mock 1.0',
        ExposureTime: t,
        FocalLength: 24 + Math.floor(rnd() * 177),
        IsoSpeedRating: pick(ISOS),
        // APEX: Av = 2·log2(N), Tv = log2(1/t) (TagLib reads ApertureValue / ShutterSpeedValue).
        Aperture: APEX ? 2 * Math.log2(f) : f,
        ShutterSpeed: APEX ? Math.log2(1 / t) : t,
        ImageOrientation: orientation,
      });
    }
    if (geo) {
      const [, lat, lon, , [a0, a1]] = geo;
      Object.assign(item, { Latitude: lat + (rnd() - 0.5) * 0.1, Longitude: lon + (rnd() - 0.5) * 0.1, Altitude: Math.round(a0 + rnd() * (a1 - a0)) });
    }
    add(item);
    if (rnd() < 0.1) ud(Id).IsFavorite = true;
    return item;
  };

  for (let i = 0; i < COUNT; i++) {
    // 10 % at the library root, the rest in the six albums.
    const parent = rnd() < 0.1 ? PHOTO_LIB : albumIds[Math.floor(rnd() * albumIds.length)];
    make(`photo-${i}`, parent, i, { memories: true });
  }
  // Three live-photo pairs (PH-14): the same basename, folder and date, a HEIC still and a MOV clip.
  for (let k = 0; k < 3 && 41 + 2 * k < COUNT; k++) {
    const i = 40 + 2 * k;
    const still = make(`photo-${i}`, albumIds[0], i, { video: false, base: `IMG_${9001 + k}`, ext: 'HEIC' });
    const clip = make(`photo-${i + 1}`, albumIds[0], i + 1, { video: true, base: `IMG_${9001 + k}`, ext: 'MOV' });
    Object.assign(clip, { DateCreated: still.DateCreated, PremiereDate: still.PremiereDate, ProductionYear: still.ProductionYear });
  }
  for (let i = 0; i < LEGACY_COUNT; i++) make(`photo-legacy-${i}`, LEGACY_LIB, COUNT + i);
  return COUNT;
}

// Folder counts once every asset is placed.
export function countAlbums(items) {
  for (const it of items.values()) if (it.Type === 'PhotoAlbum') it.ChildCount = 0;
  for (const it of items.values()) if (isPhoto(it.Id) && items.get(it.ParentId)?.Type === 'PhotoAlbum') items.get(it.ParentId).ChildCount++;
}

// Jellyfin's shape of a photo: PremiereDate as written (wall-clock, no zone; DateCreated stays UTC) and a BlurHash.
export function jellyfinPhoto(out, item) {
  if (!isPhoto(item.Id)) return out;
  if (out.PremiereDate) out.PremiereDate = out.PremiereDate.replace(/Z$/, '');
  out.ImageBlurHashes = { Primary: { [item.ImageTags.Primary]: BLURHASHES[Math.floor(meta.get(item.Id).hue / 90)] } };
  return out;
}

function rgb(hue, s, l) {
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}

// The marker: 1 px of pure magenta along the picture's true top edge, wherever the stored pixels put it.
export const MARKER = [255, 0, 255];

// A horizon gradient, a sun disc and the top marker, at most 2048 px on the long side. `upright` renders the
// pixels as shown (server-rotated); otherwise as stored, so a 90° asset keeps its marker on a side edge.
export function photoPng(id, maxW, maxH, upright) {
  const m = meta.get(id);
  const turned = !upright && m.turn ? m.turn : 0;
  const [vw, vh] = m.turn ? [m.h, m.w] : [m.w, m.h];
  const [sw, sh] = turned ? [m.w, m.h] : [vw, vh];
  const scale = Math.min(1, (maxW || Infinity) / sw, (maxH || Infinity) / sh, 2048 / Math.max(sw, sh));
  const ow = Math.max(1, Math.round(sw * scale));
  const oh = Math.max(1, Math.round(sh * scale));
  const sky = rgb(m.hue, 0.55, 0.62);
  const ground = rgb((m.hue + 40) % 360, 0.45, 0.25);
  return png(ow, oh, (x, y) => {
    // (u, v): position in the upright picture, 0..1.
    const [u, v] = turned === 90 ? [1 - y / oh, x / ow] : turned === 270 ? [y / oh, 1 - x / ow] : [x / ow, y / oh];
    const top = turned === 90 ? x === 0 : turned === 270 ? x === ow - 1 : y === 0;
    if (top) return MARKER;
    const du = (u - 0.7) * (vw / vh);
    const dv = v - 0.3;
    if (du * du + dv * dv < 0.01) return [255, 236, 170];
    const c = v < 0.6 ? sky : ground;
    const f = v < 0.6 ? 1 - v * 0.6 : 1 - (v - 0.6);
    return c.map((n) => Math.min(254, Math.round(n * f)));
  });
}

const cache = new Map();
function cached(key, make) {
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const v = make();
  cache.set(key, v);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return v;
}

// Photo routes, answered before mock-emby's own: the image (anonymous, as for every item), the original
// download and /Years. flavour: 'emby' honours AutoOrient=true; Jellyfin has no such parameter.
// Returns true when it answered.
export function photoRoute({ req, res, parts, q, items, authed, flavour, send }) {
  if (parts[0] === 'Items' && parts[2] === 'Images' && isPhoto(parts[1])) {
    const upright = SERVER_ROTATE || (flavour === 'emby' && q.get('AutoOrient') === 'true');
    const w = Number(q.get('maxWidth') ?? q.get('MaxWidth') ?? 0);
    const h = Number(q.get('maxHeight') ?? q.get('MaxHeight') ?? 0);
    const data = cached(`${parts[1]}:${w}:${h}:${upright}`, () => photoPng(parts[1], w, h, upright));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'max-age=31536000' });
    res.end(data);
    return true;
  }
  if (parts[0] === 'Items' && parts[2] === 'Download' && isPhoto(parts[1])) {
    if (!authed) return send(res, 401, 'Unauthorized', 'text/plain'), true;
    if (NO_DOWNLOAD) return send(res, 403, 'Forbidden', 'text/plain'), true;
    const data = photoPng(parts[1], 0, 0, false);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${items.get(parts[1]).Name}.png"` });
    res.end(data);
    return true;
  }
  if (parts[0] === 'Years' && parts.length === 1 && req.method === 'GET') {
    if (!authed) return send(res, 401, 'Unauthorized', 'text/plain'), true;
    const parent = q.get('ParentId');
    const types = q.get('IncludeItemTypes')?.split(',');
    const years = new Set();
    for (const x of items.values()) {
      if (!x.ProductionYear || (types && !types.includes(x.Type))) continue;
      if (parent && x.ParentId !== parent && !(q.get('Recursive') === 'true' && items.get(x.ParentId)?.ParentId === parent)) continue;
      years.add(x.ProductionYear);
    }
    const arr = [...years].sort((a, b) => (q.get('SortOrder') === 'Descending' ? b - a : a - b));
    send(res, 200, { Items: arr.map((y) => ({ Name: String(y), Id: `year-${y}`, Type: 'Year', ProductionYear: y, IsFolder: true })), TotalRecordCount: arr.length, StartIndex: 0 });
    return true;
  }
  return false;
}
