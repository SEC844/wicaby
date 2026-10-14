// Generated photos for the photo file sources checks (photo-file-sources). Never real photos: every picture is a
// gradient drawn here, every EXIF value is made up, every position is a public landmark. Nothing binary is committed:
// exif-vectors.json holds the bytes as base64, rebuilt and compared by tools/checks/photo-files-check.mjs.
//   import { buildPhotoTree, exifVectors, tiff, jpeg, pngPhoto, webp, heic } from './photo-files-fixture.mjs';
//   node tools/mock-server/photo-files-fixture.mjs --vectors   (rewrites tools/checks/fixtures/photos/exif-vectors.json)
//   node tools/mock-server/photo-files-fixture.mjs <dir>       (writes the photo tree and prints its summary)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { png } from './cbz-fixture.mjs';

const VECTORS = path.resolve(import.meta.dirname, '..', 'checks', 'fixtures', 'photos', 'exif-vectors.json');

// ---- TIFF/EXIF writer ----
// f: { make, model, orientation, dateTime, original, offset, exposure: [n, d], fnumber: [n, d], iso, focal: [n, d],
// pixelW, pixelH, lens, gps: { latRef, lat: [[n, d] x3], lonRef, lon, altRef, alt: [n, d] } }. le: Intel byte order.
export function tiff(f, le = true) {
  const ifds = [];
  const ifd0 = [];
  const exif = [];
  const gps = [];
  const ascii = (s) => Buffer.from(`${s}\0`, 'latin1');
  if (f.make !== undefined) ifd0.push([0x010f, 2, ascii(f.make)]);
  if (f.model !== undefined) ifd0.push([0x0110, 2, ascii(f.model)]);
  if (f.orientation !== undefined) ifd0.push([0x0112, 3, [f.orientation]]);
  if (f.dateTime !== undefined) ifd0.push([0x0132, 2, ascii(f.dateTime)]);
  if (f.exposure) exif.push([0x829a, 5, [f.exposure]]);
  if (f.fnumber) exif.push([0x829d, 5, [f.fnumber]]);
  if (f.iso !== undefined) exif.push([0x8827, 3, [f.iso]]);
  if (f.original !== undefined) exif.push([0x9003, 2, ascii(f.original)]);
  if (f.offset !== undefined) exif.push([0x9011, 2, ascii(f.offset)]);
  if (f.focal) exif.push([0x920a, 5, [f.focal]]);
  if (f.pixelW !== undefined) exif.push([0xa002, 4, [f.pixelW]]);
  if (f.pixelH !== undefined) exif.push([0xa003, 4, [f.pixelH]]);
  if (f.lens !== undefined) exif.push([0xa434, 2, ascii(f.lens)]);
  if (f.gps) {
    const g = f.gps;
    if (g.latRef) gps.push([1, 2, ascii(g.latRef)]);
    if (g.lat) gps.push([2, 5, g.lat]);
    if (g.lonRef) gps.push([3, 2, ascii(g.lonRef)]);
    if (g.lon) gps.push([4, 5, g.lon]);
    if (g.altRef !== undefined) gps.push([5, 1, [g.altRef]]);
    if (g.alt) gps.push([6, 5, [g.alt]]);
  }
  if (exif.length) ifd0.push([0x8769, 4, [0]]);
  if (gps.length) ifd0.push([0x8825, 4, [0]]);
  ifds.push(ifd0);
  if (exif.length) ifds.push(exif);
  if (gps.length) ifds.push(gps);
  for (const l of ifds) l.sort((a, b) => a[0] - b[0]);

  const u16 = (n) => {
    const b = Buffer.alloc(2);
    le ? b.writeUInt16LE(n) : b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    le ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0);
    return b;
  };
  const valueBytes = (type, v) => {
    if (type === 2) return v;
    if (type === 1) return Buffer.from(v);
    if (type === 3) return Buffer.concat(v.map(u16));
    if (type === 4) return Buffer.concat(v.map(u32));
    return Buffer.concat(v.map(([n, d]) => Buffer.concat([u32(n), u32(d)])));
  };
  const count = (type, v) => (type === 2 ? v.length : v.length);
  // Layout: header (8), then each IFD followed by its out-of-line values.
  const sizes = ifds.map((l) => 2 + l.length * 12 + 4 + l.reduce((s, [, t, v]) => {
    const n = valueBytes(t, v).length;
    return s + (n > 4 ? n + (n & 1) : 0);
  }, 0));
  const starts = [];
  let at = 8;
  for (const s of sizes) (starts.push(at), (at += s));
  const exifStart = exif.length ? starts[1] : 0;
  const gpsStart = gps.length ? starts[exif.length ? 2 : 1] : 0;
  for (const e of ifd0) {
    if (e[0] === 0x8769) e[2] = [exifStart];
    if (e[0] === 0x8825) e[2] = [gpsStart];
  }
  const parts = [Buffer.from(le ? 'II' : 'MM', 'latin1'), u16(42), u32(8)];
  ifds.forEach((l, i) => {
    let extra = starts[i] + 2 + l.length * 12 + 4;
    const tail = [];
    parts.push(u16(l.length));
    for (const [tag, type, v] of l) {
      const bytes = valueBytes(type, v);
      parts.push(u16(tag), u16(type), u32(count(type, v)));
      if (bytes.length <= 4) parts.push(Buffer.concat([bytes, Buffer.alloc(4 - bytes.length)]));
      else {
        parts.push(u32(extra));
        const padded = bytes.length & 1 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
        tail.push(padded);
        extra += padded.length;
      }
    }
    parts.push(u32(0), ...tail);
  });
  return Buffer.concat(parts);
}

// ---- Containers ----
const be16 = (n) => Buffer.from([n >> 8, n & 255]);
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

// SOI, APP1 (when t), SOF0 with the size, EOI: a JPEG header as a camera lays it out (not decodable pixels).
export function jpeg(t, w, h) {
  const app1 = t ? Buffer.concat([Buffer.from([0xff, 0xe1]), be16(t.length + 8), Buffer.from('Exif\0\0', 'latin1'), t]) : Buffer.alloc(0);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

function pngChunk(type, data) {
  const head = Buffer.concat([be32(data.length), Buffer.from(type, 'latin1')]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
  return Buffer.concat([head, data, crc]);
}

// A real, decodable PNG (a gradient of `hue`) with an eXIf chunk after IHDR when t.
export function pngPhoto(t, w, h, hue = 200) {
  const rgb = (hh, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.7;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [r, g, b].map((v) => Math.round((v + m) * 255));
  };
  const img = png(w, h, (x, y) => rgb((hue + (x / w) * 40) % 360, 0.3 + (y / h) * 0.4));
  if (!t) return img;
  const ihdrEnd = 8 + 25;
  return Buffer.concat([img.subarray(0, ihdrEnd), pngChunk('eXIf', t), img.subarray(ihdrEnd)]);
}

const riff = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

// RIFF WEBP with VP8X (the canvas size) and an EXIF chunk (prefix: the "Exif\0\0" some writers add).
export function webp(t, w, h, prefix = false) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = t ? 0x08 : 0;
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), riff('VP8X', vp8x), t ? riff('EXIF', prefix ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]) : t) : Buffer.alloc(0)]);
  return riff('RIFF', body).subarray(0, 8 + body.length);
}

const isoBox = (type, ...parts) => {
  const data = Buffer.concat(parts);
  return Buffer.concat([be32(data.length + 8), Buffer.from(type, 'latin1'), data]);
};
const full = (type, version, ...parts) => isoBox(type, Buffer.from([version, 0, 0, 0]), ...parts);

// ftyp, meta (iinf with item 1 'hvc1' and item 2 'Exif', iloc, iprp/ipco/ispe), mdat. gap: bytes of mdat before the
// Exif item (past 64 KB, the reader asks for a second read).
export function heic(t, w, h, gap = 0) {
  const item = Buffer.concat([be32(6), Buffer.from('Exif\0\0', 'latin1'), t]);
  const infe = (id, type) => full('infe', 2, be16(id), be16(0), Buffer.from(type, 'latin1'), Buffer.from([0]));
  const iinf = full('iinf', 0, be16(2), infe(1, 'hvc1'), infe(2, 'Exif'));
  const ispe = (ww, hh) => full('ispe', 0, be32(ww), be32(hh));
  const iprp = isoBox('iprp', isoBox('ipco', ispe(512, 512), ispe(w, h)));
  const ftyp = isoBox('ftyp', Buffer.from('heic', 'latin1'), be32(0), Buffer.from('mif1heic', 'latin1'));
  // iloc v0, offset_size 4, length_size 4, base_offset_size 0; the offset is patched once the layout is known.
  const iloc = (off) => full('iloc', 0, Buffer.from([0x44, 0x00]), be16(1), be16(2), be16(0), be16(1), be32(off), be32(item.length));
  const hdlr = full('hdlr', 0, be32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from([0]));
  const meta = (off) => full('meta', 0, hdlr, iinf, iloc(off), iprp);
  const before = ftyp.length + meta(0).length + 8 + gap;
  return Buffer.concat([ftyp, meta(before), isoBox('mdat', Buffer.alloc(gap), item)]);
}

// ---- Shared vectors (TS and Kotlin readers) ----
const r = (n, d = 1) => [n, d];
const dms = (deg, min, sec100) => [r(deg), r(min), r(sec100, 100)];
const CAMERA = { make: 'ExampleCam', model: 'ExampleCam Z1', lens: 'Example 24-70mm F2.8', exposure: r(1, 250), fnumber: r(28, 10), iso: 400, focal: r(35) };

export function exifVectors() {
  const v = [];
  const add = (name, bytes, expected, head = undefined) => v.push({ name, b64: Buffer.from(bytes).toString('base64'), ...(head ? { head } : {}), expected });
  for (let o = 1; o <= 8; o++)
    add(`jpeg orientation ${o} (${o % 2 ? 'Intel' : 'Motorola'})`, jpeg(tiff({ orientation: o, original: '2021:07:14 09:05:00' }, o % 2 === 1), 4000, 3000), { takenAt: '2021-07-14T09:05:00', orientation: o, width: 4000, height: 3000 });
  add('DateTimeOriginal without an offset', jpeg(tiff({ original: '2019:10:12 14:30:05', dateTime: '2020:01:01 00:00:00' }), 6000, 4000), { takenAt: '2019-10-12T14:30:05', width: 6000, height: 4000 });
  add('DateTimeOriginal with OffsetTimeOriginal', jpeg(tiff({ original: '2019:10:12 14:30:05', offset: '+02:00' }, false), 6000, 4000), { takenAt: '2019-10-12T14:30:05', offset: '+02:00', width: 6000, height: 4000 });
  add('negative offset', jpeg(tiff({ original: '2018:03:01 23:59:59', offset: '-05:00' }), 640, 480), { takenAt: '2018-03-01T23:59:59', offset: '-05:00', width: 640, height: 480 });
  add('DateTime only (no DateTimeOriginal)', jpeg(tiff({ dateTime: '2017:06:01 08:00:00' }), 640, 480), { takenAt: '2017-06-01T08:00:00', width: 640, height: 480 });
  add('blank date is unknown, its offset dropped', jpeg(tiff({ original: '0000:00:00 00:00:00', offset: '+01:00' }), 640, 480), { width: 640, height: 480 });
  add(
    'GPS north east with altitude',
    jpeg(tiff({ original: '2022:08:01 12:00:00', gps: { latRef: 'N', lat: dms(48, 51, 3024), lonRef: 'E', lon: dms(2, 17, 4020), altRef: 0, alt: r(355, 10) } }), 4032, 3024),
    { takenAt: '2022-08-01T12:00:00', lat: 48.8584, lon: 2.2945, alt: 35.5, width: 4032, height: 3024 },
  );
  add(
    'GPS south west below sea level (Motorola)',
    jpeg(tiff({ gps: { latRef: 'S', lat: dms(33, 51, 3540), lonRef: 'W', lon: dms(70, 30, 0), altRef: 1, alt: r(12) } }, false), 100, 100),
    { lat: -(33 + 51 / 60 + 35.4 / 3600), lon: -70.5, alt: -12, width: 100, height: 100 },
  );
  add('GPS 0, 0 is no fix', jpeg(tiff({ gps: { latRef: 'N', lat: dms(0, 0, 0), lonRef: 'E', lon: dms(0, 0, 0) } }), 100, 100), { width: 100, height: 100 });
  add('camera, lens and exposure', jpeg(tiff({ ...CAMERA, orientation: 1, original: '2020:02:29 18:45:00' }), 5472, 3648), {
    takenAt: '2020-02-29T18:45:00',
    orientation: 1,
    make: 'ExampleCam',
    model: 'ExampleCam Z1',
    lens: 'Example 24-70mm F2.8',
    exposureS: 0.004,
    fNumber: 2.8,
    iso: 400,
    focalMm: 35,
    width: 5472,
    height: 3648,
  });
  add('stale PixelXDimension: the frame size wins', jpeg(tiff({ pixelW: 6000, pixelH: 4000 }), 1200, 800), { width: 1200, height: 800 });
  add('missing EXIF', jpeg(null, 800, 600), { width: 800, height: 600 });
  {
    const full = jpeg(tiff({ ...CAMERA, orientation: 6, original: '2016:05:05 05:05:05' }), 4000, 3000);
    add('truncated in the Exif IFD', full.subarray(0, 140), { orientation: 6, make: 'ExampleCam', model: 'ExampleCam Z1', iso: 400 });
    add('truncated before IFD0 ends', full.subarray(0, 30), {});
  }
  add('not an image', Buffer.from('WICABY TEST STUB: not a photo\n'), {});
  add('empty', Buffer.alloc(0), {});
  add('PNG eXIf', pngPhoto(tiff({ orientation: 8, original: '2015:12:24 20:00:00' }), 32, 24, 10), { takenAt: '2015-12-24T20:00:00', orientation: 8, width: 32, height: 24 });
  add('PNG without EXIF', pngPhoto(null, 16, 9), { width: 16, height: 9 });
  add('WebP EXIF chunk', webp(tiff({ orientation: 3, original: '2014:01:02 03:04:05' }), 1920, 1080), { takenAt: '2014-01-02T03:04:05', orientation: 3, width: 1920, height: 1080 });
  add('WebP EXIF chunk with an Exif prefix', webp(tiff({ original: '2014:01:02 03:04:05' }, false), 1080, 1920, true), { takenAt: '2014-01-02T03:04:05', width: 1080, height: 1920 });
  add('HEIC Exif item in the head', heic(tiff({ ...CAMERA, orientation: 6, original: '2023:04:01 10:00:00', offset: '+09:00' }, false), 4032, 3024), {
    takenAt: '2023-04-01T10:00:00',
    offset: '+09:00',
    orientation: 6,
    make: 'ExampleCam',
    model: 'ExampleCam Z1',
    lens: 'Example 24-70mm F2.8',
    exposureS: 0.004,
    fNumber: 2.8,
    iso: 400,
    focalMm: 35,
    width: 4032,
    height: 3024,
  });
  {
    // The item sits past the head: the reader names its range; `item` holds those bytes for the second read.
    const t = tiff({ original: '2023:04:02 11:00:00' }, false);
    const file = heic(t, 3024, 4032, 70_000);
    const head = file.subarray(0, 65536);
    const at = file.length - (t.length + 10);
    v.push({ name: 'HEIC Exif item past the head', b64: head.toString('base64'), expected: { width: 3024, height: 4032, more: { at, length: t.length + 10 } }, item: file.subarray(at).toString('base64'), itemExpected: { takenAt: '2023-04-02T11:00:00' } });
  }
  {
    // IFD0's next-IFD pointer and the Exif pointer both point back at IFD0: read once, no loop.
    const t = tiff({ orientation: 2, original: '2012:12:12 12:12:12' });
    const loop = Buffer.from(t);
    const n = loop.readUInt16LE(8);
    loop.writeUInt32LE(8, 10 + n * 12);
    for (let i = 0; i < n; i++) if (loop.readUInt16LE(10 + i * 12) === 0x8769) loop.writeUInt32LE(8, 10 + i * 12 + 8);
    add('IFD pointing at itself', jpeg(loop, 10, 10), { orientation: 2, width: 10, height: 10 });
  }
  return {
    comment: 'Photo file sources: EXIF/TIFF reader vectors. Desktop shared/files/exif.ts (tools/checks/photo-files-check.mjs) and Android core files/pure/ExifReader.kt (ExifReaderTest) read this file in place. Generated by tools/mock-server/photo-files-fixture.mjs --vectors: made-up values, gradient pixels, never a real photo. Numbers compare within 1e-6.',
    orientationNames: ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft', 'LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'],
    vectors: v,
  };
}

// ---- A photo folder tree ----
const LANDMARKS = [
  ['N', dms(48, 51, 3024), 'E', dms(2, 17, 4020)],
  ['N', dms(45, 45, 4428), 'E', dms(4, 49, 2172)],
  ['N', dms(64, 8, 3012), 'W', dms(21, 55, 3576)],
];
const pad = (n) => String(n).padStart(2, '0');

// Albums are folders. Returns { dir, photos: [{ rel, w, h, takenAt?, orientation?, mtimeOnly? }], videos, albums }.
// `today`: "YYYY-MM-DD" whose month and day some photos share in earlier years ("on this day"); `scale`: pixel size.
export function buildPhotoTree(dir, { today = '2026-10-14', count = 24, scale = 1 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const md = today.slice(5).replace('-', ':');
  const albums = ['Vacances 2019', 'Montagne', path.join('Famille', 'Anniversaires')];
  const photos = [];
  for (let i = 0; i < count; i++) {
    const album = i < 3 ? '' : albums[i % albums.length];
    const year = 2016 + (i % 9);
    const date = i % 6 === 0 ? `${year}:${md}` : `${year}:${pad(1 + (i % 12))}:${pad(1 + ((i * 7) % 27))}`;
    const original = `${date} ${pad(8 + (i % 12))}:${pad((i * 13) % 60)}:00`;
    const orientation = i % 7 === 3 ? 6 : 1;
    const [w, h] = (i % 5 === 2 ? [48, 64] : i % 9 === 4 ? [128, 32] : [72, 48]).map((x) => x * scale);
    const g = LANDMARKS[i % LANDMARKS.length];
    const noExif = i % 11 === 10;
    const t = noExif ? null : tiff({ make: 'ExampleCam', model: 'ExampleCam Z1', orientation, original, gps: { latRef: g[0], lat: g[1], lonRef: g[2], lon: g[3] } });
    const name = `IMG_${String(1000 + i)}.png`;
    const rel = album ? `${album.split(path.sep).join('/')}/${name}` : name;
    fs.mkdirSync(path.join(dir, album), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), pngPhoto(t, w, h, (i * 47) % 360));
    // A file without EXIF dates from its modification time.
    if (noExif) fs.utimesSync(path.join(dir, rel), new Date(Date.UTC(2020, 5, 15, 10)), new Date(Date.UTC(2020, 5, 15, 10)));
    photos.push({ rel, w, h, ...(noExif ? { mtimeOnly: true } : { takenAt: original.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T'), orientation }) });
  }
  fs.writeFileSync(path.join(dir, 'Vacances 2019', 'clip.mp4'), Buffer.from('WICABY TEST STUB: not a video\n'));
  fs.mkdirSync(path.join(dir, '@eaDir'), { recursive: true });
  fs.writeFileSync(path.join(dir, '@eaDir', 'IMG_9999.png'), pngPhoto(null, 8, 8));
  fs.writeFileSync(path.join(dir, '.hidden.png'), pngPhoto(null, 8, 8));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a photo\n');
  return { dir, photos, videos: ['Vacances 2019/clip.mp4'], albums: albums.map((a) => a.split(path.sep).join('/')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (process.argv[2] === '--vectors') {
    fs.writeFileSync(VECTORS, `${JSON.stringify(exifVectors(), null, 1)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), VECTORS)}`);
  } else if (process.argv[2]) {
    const t = buildPhotoTree(path.resolve(process.argv[2]));
    console.log(`${t.photos.length} photos, ${t.videos.length} video, albums: ${t.albums.join(', ')}`);
  } else console.log('usage: photo-files-fixture.mjs --vectors | <dir>');
}
