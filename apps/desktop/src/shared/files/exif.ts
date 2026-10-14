// Photo sources on files (photo file sources): what a photo's first bytes say, for an index with no server behind
// it. A minimal EXIF/TIFF reader for the fields the timeline, the viewer's info panel and the opt-in map use, out of
// JPEG (APP1), PNG (eXIf), WebP (EXIF chunk) and HEIC (the Exif item), plus the pixel size from the container.
// Pure, no dependency, never throws: a damaged or cut header gives what was read before the damage. Kotlin twin:
// core files/pure/ExifReader.kt; both pass tools/checks/fixtures/photos/exif-vectors.json.

export interface PhotoHead {
  // DateTimeOriginal (else DateTime) as wall-clock "YYYY-MM-DDTHH:MM:SS"; offset: OffsetTimeOriginal "+HH:MM".
  takenAt?: string;
  offset?: string;
  // EXIF Orientation 1..8.
  orientation?: number;
  // Never logged; shown only with the map on (privacy).
  lat?: number;
  lon?: number;
  alt?: number;
  make?: string;
  model?: string;
  lens?: string;
  exposureS?: number;
  fNumber?: number;
  focalMm?: number;
  iso?: number;
  // Stored pixels, before the orientation.
  width?: number;
  height?: number;
  // HEIC whose Exif item lies past the bytes given: read [at, at + length) and pass it to heicExifItem.
  more?: { at: number; length: number };
}

// The first bytes the index reads of each file: EXIF sits in the first 64 KB (JPEG APP1 is at most that).
export const HEAD_BYTES = 65536;

const ORIENTATIONS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft', 'LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'];
// EXIF 1..8 as the Emby ImageOrientation name the photo UI reads (asset.ts quarterTurn).
export const orientationName = (o?: number): string | undefined => (o && o >= 1 && o <= 8 ? ORIENTATIONS[o - 1] : undefined);

const ascii = (b: Uint8Array, at: number, n: number): string => (at >= 0 && at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');
const u16be = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const u32be = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u32le = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u24le = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);

export function readPhotoHead(b: Uint8Array): PhotoHead {
  try {
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
    if (b.length >= 8 && u32be(b, 0) === 0x89504e47) return png(b);
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
    if (ascii(b, 4, 4) === 'ftyp') return heic(b);
  } catch {
    // unreachable by design (every read is bounds-checked); a parser bug must not stop an index
  }
  return {};
}

// The bytes of a HEIC Exif item (readPhotoHead's `more`): a 4-byte offset to the TIFF header, then the EXIF.
export function heicExifItem(item: Uint8Array): PhotoHead {
  if (item.length < 4) return {};
  return tiff(item, 4 + u32be(item, 0));
}

function jpeg(b: Uint8Array): PhotoHead {
  let out: PhotoHead = {};
  let exif = false;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) break;
    const m = b[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0xd9 || m === 0xda) break;
    const len = u16be(b, p + 2);
    if (len < 2) break;
    if (m === 0xe1 && !exif && ascii(b, p + 4, 6) === 'Exif\0\0') ((exif = true), (out = tiff(b.subarray(0, Math.min(b.length, p + 2 + len)), p + 10)));
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    // The frame's size wins over EXIF's PixelXDimension, which an editor may leave stale.
    if (sof && p + 9 <= b.length) {
      out.height = u16be(b, p + 5);
      out.width = u16be(b, p + 7);
      break;
    }
    p += 2 + len;
  }
  return out;
}

function png(b: Uint8Array): PhotoHead {
  let out: PhotoHead = {};
  let p = 8;
  while (p + 8 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    if (type === 'IHDR' && p + 16 <= b.length) ((out.width = u32be(b, p + 8)), (out.height = u32be(b, p + 12)));
    if (type === 'eXIf') out = { ...tiff(b.subarray(p + 8, Math.min(b.length, p + 8 + len)), 0), width: out.width, height: out.height };
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  return strip(out);
}

function webp(b: Uint8Array): PhotoHead {
  let out: PhotoHead = {};
  let size: [number, number] | undefined;
  let p = 12;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4);
    const len = u32le(b, p + 4);
    const d = p + 8;
    if (type === 'VP8X' && d + 10 <= b.length) size = [1 + u24le(b, d + 4), 1 + u24le(b, d + 7)];
    if (type === 'VP8L' && d + 5 <= b.length && !size) {
      const bits = u32le(b, d + 1);
      size = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (type === 'VP8 ' && d + 10 <= b.length && !size) size = [(b[d + 6] | (b[d + 7] << 8)) & 0x3fff, (b[d + 8] | (b[d + 9] << 8)) & 0x3fff];
    if (type === 'EXIF') {
      const chunk = b.subarray(d, Math.min(b.length, d + len));
      out = tiff(chunk, ascii(chunk, 0, 6) === 'Exif\0\0' ? 6 : 0);
    }
    p = d + len + (len & 1);
  }
  if (size) ((out.width = size[0]), (out.height = size[1]));
  return out;
}

// ISO BMFF: meta > iinf (the 'Exif' item's id), iloc (where it is), iprp > ipco > ispe (the largest is the image).
function heic(b: Uint8Array): PhotoHead {
  const box = (from: number, to: number, cb: (type: string, start: number, end: number) => void) => {
    let p = from;
    while (p + 8 <= to) {
      let size = u32be(b, p);
      let head = 8;
      if (size === 1 && p + 16 <= to) ((size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12)), (head = 16));
      if (size === 0) size = to - p;
      if (size < head) return;
      cb(ascii(b, p + 4, 4), p + head, Math.min(to, p + size));
      p += size;
    }
  };
  let exifId = -1;
  const locs = new Map<number, { at: number; length: number }>();
  let dims: [number, number] | undefined;
  box(0, b.length, (type, s, e) => {
    if (type !== 'meta') return;
    box(s + 4, e, (t2, s2, e2) => {
      if (t2 === 'iinf') {
        const v = b[s2];
        box(s2 + 4 + (v === 0 ? 2 : 4), e2, (t3, s3) => {
          if (t3 !== 'infe' || b[s3] < 2) return;
          const id = b[s3] === 2 ? u16be(b, s3 + 4) : u32be(b, s3 + 4);
          const at = s3 + 4 + (b[s3] === 2 ? 2 : 4) + 2;
          if (ascii(b, at, 4) === 'Exif') exifId = id;
        });
      }
      if (t2 === 'iloc') iloc(b, s2, e2, locs);
      if (t2 === 'iprp')
        box(s2, e2, (t3, s3, e3) => {
          if (t3 === 'ipco')
            box(s3, e3, (t4, s4) => {
              if (t4 !== 'ispe' || s4 + 12 > b.length) return;
              const w = u32be(b, s4 + 4);
              const h = u32be(b, s4 + 8);
              if (!dims || w * h > dims[0] * dims[1]) dims = [w, h];
            });
        });
    });
  });
  const loc = locs.get(exifId);
  let out: PhotoHead = {};
  if (loc && loc.length > 0) out = loc.at + loc.length <= b.length ? heicExifItem(b.subarray(loc.at, loc.at + loc.length)) : { more: loc };
  if (dims) ((out.width = dims[0]), (out.height = dims[1]));
  return out;
}

// One extent per item is all a camera writes for Exif; construction method 0 (file offsets) only.
function iloc(b: Uint8Array, s: number, e: number, out: Map<number, { at: number; length: number }>): void {
  const v = b[s];
  if (s + 8 > e) return;
  const offSize = b[s + 4] >> 4;
  const lenSize = b[s + 4] & 15;
  const baseSize = b[s + 5] >> 4;
  const idxSize = v === 1 || v === 2 ? b[s + 5] & 15 : 0;
  let p = s + 6;
  const read = (n: number): number => {
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + (b[p + i] ?? 0);
    p += n;
    return x;
  };
  const count = v < 2 ? read(2) : read(4);
  for (let i = 0; i < count && p < e; i++) {
    const id = v < 2 ? read(2) : read(4);
    const method = v === 1 || v === 2 ? read(2) & 15 : 0;
    read(2); // data_reference_index
    const base = read(baseSize);
    const extents = read(2);
    let first: { at: number; length: number } | undefined;
    for (let k = 0; k < extents && p < e; k++) {
      if (idxSize) read(idxSize);
      const off = read(offSize);
      const len = read(lenSize);
      first ??= { at: base + off, length: len };
    }
    if (first && method === 0 && extents === 1) out.set(id, first);
  }
}

// The TIFF structure at b[start]: IFD0, then the Exif and GPS IFDs it points to.
function tiff(b: Uint8Array, start: number): PhotoHead {
  const out: PhotoHead = {};
  if (start < 0 || start + 8 > b.length) return out;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return out;
  const u16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : u16be(b, p));
  const u32 = (p: number) => (le ? u32le(b, p) : u32be(b, p));
  const fits = (p: number, n: number) => p >= start && p + n <= b.length;
  if (u16(start + 2) !== 42) return out;
  const seen = new Set<number>();
  // The tag's values: their offset (inline when they fit in 4 bytes) and count, or null when cut off.
  type Entry = { type: number; count: number; at: number };
  const ifd = (rel: number, cb: (tag: number, e: Entry) => void) => {
    const p = start + rel;
    if (seen.has(rel) || !fits(p, 2)) return;
    seen.add(rel);
    const n = Math.min(u16(p), 512);
    const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
    for (let i = 0; i < n; i++) {
      const q = p + 2 + i * 12;
      if (!fits(q, 12)) return;
      const type = u16(q + 2);
      const count = u32(q + 4);
      const bytes = (SIZE[type] ?? 0) * count;
      if (!bytes || bytes > 65536) continue;
      const at = bytes <= 4 ? q + 8 : start + u32(q + 8);
      if (fits(at, bytes)) cb(u16(q), { type, count, at });
    }
  };
  const num = (e: Entry, i = 0): number | undefined => {
    const p = e.at + i * (e.type === 3 || e.type === 8 ? 2 : e.type === 5 || e.type === 10 ? 8 : 4);
    if (e.type === 3) return u16(p);
    if (e.type === 4) return u32(p);
    if (e.type === 9) return u32(p) | 0;
    if (e.type === 5 || e.type === 10) {
      const n = e.type === 10 ? u32(p) | 0 : u32(p);
      const d = e.type === 10 ? u32(p + 4) | 0 : u32(p + 4);
      return d ? n / d : undefined;
    }
    if (e.type === 1 || e.type === 7) return b[p];
    return undefined;
  };
  const text = (e: Entry): string | undefined => {
    if (e.type !== 2) return undefined;
    let s = '';
    for (let i = 0; i < e.count && b[e.at + i]; i++) s += String.fromCharCode(b[e.at + i]);
    s = s.trim();
    return s || undefined;
  };
  let exifAt = -1;
  let gpsAt = -1;
  let dateTime: string | undefined;
  ifd(u32(start + 4), (tag, e) => {
    if (tag === 0x010f) out.make = text(e);
    else if (tag === 0x0110) out.model = text(e);
    else if (tag === 0x0112) {
      const o = num(e);
      if (o && o >= 1 && o <= 8) out.orientation = o;
    } else if (tag === 0x0132) dateTime = text(e);
    else if (tag === 0x8769) exifAt = num(e) ?? -1;
    else if (tag === 0x8825) gpsAt = num(e) ?? -1;
  });
  let original: string | undefined;
  if (exifAt > 0)
    ifd(exifAt, (tag, e) => {
      if (tag === 0x9003) original = text(e);
      else if (tag === 0x9011) {
        const o = text(e);
        if (o && /^[+-]\d{2}:\d{2}$/.test(o)) out.offset = o;
      } else if (tag === 0x829a) out.exposureS = num(e);
      else if (tag === 0x829d) out.fNumber = num(e);
      else if (tag === 0x8827) out.iso = num(e);
      else if (tag === 0x920a) out.focalMm = num(e);
      else if (tag === 0xa002) out.width = num(e);
      else if (tag === 0xa003) out.height = num(e);
      else if (tag === 0xa434) out.lens = text(e);
    });
  const taken = exifDate(original) ?? exifDate(dateTime);
  if (taken) out.takenAt = taken;
  else delete out.offset;
  if (gpsAt > 0) {
    const g: Record<number, Entry> = {};
    ifd(gpsAt, (tag, e) => void (g[tag] = e));
    const dms = (e?: Entry) => (e && e.count >= 3 && (e.type === 5 || e.type === 10) ? [num(e, 0), num(e, 1), num(e, 2)] : null);
    const coord = (refTag: number, valTag: number, neg: string): number | undefined => {
      const v = dms(g[valTag]);
      const ref = g[refTag] ? text(g[refTag]) : undefined;
      if (!v || v.some((x) => x === undefined || !Number.isFinite(x))) return undefined;
      const x = v[0]! + v[1]! / 60 + v[2]! / 3600;
      return ref?.toUpperCase() === neg ? -x : x;
    };
    const lat = coord(1, 2, 'S');
    const lon = coord(3, 4, 'W');
    // 0, 0 is "no fix" written as numbers.
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
      out.lat = lat;
      out.lon = lon;
      const alt = g[6] ? num(g[6]) : undefined;
      if (alt !== undefined && Number.isFinite(alt)) out.alt = g[5] && num(g[5]) === 1 ? -alt : alt;
    }
  }
  return strip(out);
}

// "YYYY:MM:DD HH:MM:SS" (zeros and blanks are "unknown") as "YYYY-MM-DDTHH:MM:SS".
function exifDate(s?: string): string | undefined {
  const m = s ? /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s) : null;
  if (!m || Number(m[1]) < 1800 || m[2] === '00' || m[3] === '00') return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function strip(o: PhotoHead): PhotoHead {
  for (const k of Object.keys(o) as (keyof PhotoHead)[]) if (o[k] === undefined || (typeof o[k] === 'number' && !Number.isFinite(o[k] as number))) delete o[k];
  return o;
}
