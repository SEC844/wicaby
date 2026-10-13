// Minimal ZIP reader for comic archives: central directory, stored and
// deflate entries, ZIP64. Kept dependency-free and erasable-syntax only so
// tools/checks/zip-check.mjs can run it directly under Node.
import { open, type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const inflateRaw = promisify(zlib.inflateRaw);

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// About 200 000 entries: far beyond any comic, and a forged size in a huge file is not allocated.
export const MAX_CD_SIZE = 16 * 1024 * 1024;

// Where the archive's bytes come from: a local file, or HTTP Range requests (comic covers, cover.ts).
export interface ZipSource {
  size: number;
  read(position: number, length: number): Promise<Buffer>;
}

function fileSource(fh: FileHandle, size: number): ZipSource {
  return {
    size,
    async read(position, length) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    },
  };
}

async function withFile<T>(file: string, use: (src: ZipSource) => Promise<T>): Promise<T> {
  const fh = await open(file, 'r');
  try {
    return await use(fileSource(fh, (await fh.stat()).size));
  } finally {
    await fh.close();
  }
}

// Reads never go past the end of the file: lengths and offsets come from the
// archive itself, and a 100-byte file must not make us allocate 4 GiB.
async function readAt(src: ZipSource, position: number, length: number): Promise<Buffer> {
  length = Math.min(length, src.size - position);
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length <= 0) return Buffer.alloc(0);
  return src.read(position, length);
}

export function listEntries(file: string): Promise<ZipEntry[]> {
  return withFile(file, listEntriesFrom);
}

export async function listEntriesFrom(src: ZipSource): Promise<ZipEntry[]> {
  const size = src.size;
  // The end record sits in the last 22 bytes plus an optional comment of up to 64 KiB.
  const tailLen = Math.min(size, 22 + 0xffff);
  const tailStart = size - tailLen;
  const tail = await readAt(src, tailStart, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new Error('Archive ZIP illisible');
  let count = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = tailStart + e - 20;
    const loc = locPos >= 0 ? await readAt(src, locPos, 20) : Buffer.alloc(0);
    if (loc.length === 20 && loc.readUInt32LE(0) === ZIP64_LOCATOR) {
      const z = await readAt(src, Number(loc.readBigUInt64LE(8)), 56);
      if (z.length < 56 || z.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('Archive ZIP64 illisible');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
  }
  // The central directory must lie inside the file; a forged size is not allocated.
  if (!Number.isSafeInteger(cdOffset) || !Number.isSafeInteger(cdSize) || cdSize > MAX_CD_SIZE || cdOffset + cdSize > size) {
    throw new Error('Répertoire ZIP corrompu'); // i18n-ignore: replaced by errors.comics.* before display
  }
  const cd = await readAt(src, cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== CENTRAL) throw new Error('Répertoire ZIP corrompu'); // i18n-ignore: replaced by errors.comics.* before display
    const flags = cd.readUInt16LE(p + 8);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry: ZipEntry = {
      // Bit 11 marks UTF-8; older tools write CP437, which only matters for sorting odd names.
      name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      headerOffset: cd.readUInt32LE(p + 42),
    };
    // ZIP64 extra field: only the values saturated in the fixed header are present, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        // A value past the field's own length (or the directory) is not read; the
        // saturated 0xffffffff left in its place then fails the size caps.
        const fieldEnd = Math.min(x + 4 + len, cd.length);
        const next = (v: number) => {
          if (q + 8 > fieldEnd) return v;
          const n = Number(cd.readBigUInt64LE(q));
          q += 8;
          return n;
        };
        if (entry.size === 0xffffffff) entry.size = next(entry.size);
        if (entry.compressedSize === 0xffffffff) entry.compressedSize = next(entry.compressedSize);
        if (entry.headerOffset === 0xffffffff) entry.headerOffset = next(entry.headerOffset);
      }
      x += 4 + len;
    }
    out.push(entry);
    p = xEnd + commentLen;
  }
  return out;
}

// Largest page we inflate: a crafted entry (zip bomb) must fail, not exhaust memory.
export const MAX_ENTRY_SIZE = 64 * 1024 * 1024;
// Deflate can grow incompressible data slightly; anything beyond is not a real page.
const MAX_COMPRESSED = MAX_ENTRY_SIZE + 1024 * 1024;
// Header sniffing only needs the first bytes of each page...
const MAX_HEAD_OUTPUT = 256 * 1024;
// ...and all heads of a book together stay bounded, whatever its page count.
const MAX_HEADS_TOTAL = 128 * 1024 * 1024;
// Bytes read and inflated by readEntry calls at once (the thumbnail strip asks
// for many pages together); further calls wait their turn.
const MAX_IN_FLIGHT = 256 * 1024 * 1024;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function reserve(bytes: number): Promise<void> {
  while (inFlight > 0 && inFlight + bytes > MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight += bytes;
}

function release(bytes: number): void {
  inFlight -= bytes;
  for (const wake of waiting.splice(0)) wake();
}

export function readEntry(file: string, entry: ZipEntry): Promise<Buffer> {
  return withFile(file, (src) => readEntryFrom(src, entry));
}

export async function readEntryFrom(src: ZipSource, entry: ZipEntry): Promise<Buffer> {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Compression ZIP non prise en charge (${entry.method})`);
  if (entry.size > MAX_ENTRY_SIZE || entry.compressedSize > MAX_COMPRESSED || (entry.method === 0 && entry.compressedSize > MAX_ENTRY_SIZE)) {
    throw new Error('Entrée ZIP trop volumineuse'); // i18n-ignore: replaced by errors.comics.* before display
  }
  const cost = entry.compressedSize + (entry.method === 8 ? entry.size : 0);
  await reserve(cost);
  try {
    return await readEntryData(src, entry);
  } finally {
    release(cost);
  }
}

async function readEntryData(src: ZipSource, entry: ZipEntry): Promise<Buffer> {
  const head = await readAt(src, entry.headerOffset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) throw new Error('Entrée ZIP corrompue'); // i18n-ignore: replaced by errors.comics.* before display
  // The local header's name/extra lengths can differ from the central copy.
  const start = entry.headerOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const data = await readAt(src, start, entry.compressedSize);
  if (entry.method === 0) return data;
  // The central directory's size is the cap: a stream inflating past it is lying.
  try {
    return await inflateRaw(data, { maxOutputLength: Math.max(1, Math.min(entry.size, MAX_ENTRY_SIZE)) });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Entrée ZIP plus grande que annoncé'); // i18n-ignore: replaced by errors.comics.* before display
    throw err;
  }
}

// First bytes of each entry (decompressed), read through one file handle:
// enough for image headers without inflating whole pages.
export function readHeads(file: string, entries: ZipEntry[], max = 64 * 1024): Promise<Buffer[]> {
  return withFile(file, async (src) => {
    const out: Buffer[] = [];
    let budget = MAX_HEADS_TOTAL;
    for (const e of entries) {
      const head = budget > 0 ? await readAt(src, e.headerOffset, 30) : Buffer.alloc(0);
      if (head.length < 30 || head.readUInt32LE(0) !== LOCAL || (e.method !== 0 && e.method !== 8)) {
        out.push(Buffer.alloc(0));
        continue;
      }
      const start = e.headerOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const raw = await readAt(src, start, Math.min(e.compressedSize, max, budget));
      const data = e.method === 0 ? raw : await inflateHead(raw, Math.min(MAX_HEAD_OUTPUT, budget));
      budget -= data.length;
      out.push(data);
    }
    return out;
  });
}

// Inflates the start of a deflate stream and stops once `limit` bytes are out,
// so a page that compresses very well (BMP, flat colour) still yields its
// header rather than failing an output cap. A truncated stream inflates as far
// as it goes (sync flush); corrupt input gives what came out before the error.
function inflateHead(raw: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const z = zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const chunks: Buffer[] = [];
    let got = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      z.destroy();
      resolve(Buffer.concat(chunks, Math.min(got, limit)));
    };
    z.on('data', (c: Buffer) => {
      if (done) return;
      chunks.push(c);
      got += c.length;
      if (got >= limit) finish();
    });
    z.on('end', finish);
    z.on('error', finish);
    z.on('close', finish);
    if (limit <= 0 || raw.length === 0) finish();
    else z.end(raw);
  });
}

const IMAGE = /\.(jpe?g|jpe|jfif|png|webp|gif|avif|bmp)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Page images in reading order: natural sort ("2.jpg" before "10.jpg"), no
// macOS resource forks or hidden files.
export function pageEntries(entries: ZipEntry[]): ZipEntry[] {
  return entries
    .filter((e) => IMAGE.test(e.name) && !e.name.endsWith('/'))
    .filter((e) => !e.name.split(/[\\/]/).some((part) => part === '__MACOSX' || part.startsWith('.')))
    .sort((a, b) => collator.compare(a.name, b.name));
}

export function imageType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ['jpg', 'jpe', 'jfif'].includes(ext) ? 'image/jpeg' : `image/${ext}`;
}

// A comic's cover when the server has none: a page named "cover" ("Cover_01"…) or all zeros
// ("000") wins, else the first page in reading order.
const COVER = /^(cover([^a-z].*)?|0+)$/i;
export function coverEntry(entries: ZipEntry[]): ZipEntry | undefined {
  const pages = pageEntries(entries);
  const stem = (e: ZipEntry) => (e.name.split(/[\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
  return pages.find((e) => COVER.test(stem(e))) ?? pages[0];
}

// The end of the archive, fetched first: the end record, ZIP64 records and, for any
// comic, the whole central directory (listEntriesFrom reads exactly this much).
const TAIL = 22 + 0xffff;

// GET with a Range header; the caller adds auth, timeout and cancellation.
export type RangeFetch = (range: string) => Promise<Response>;

async function rangeBody(res: Response, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > max) throw new Error('Réponse Range trop longue'); // i18n-ignore: covers fail silently; leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// An archive on the server read with HTTP Range requests: a server that answers with the
// whole file (200) is refused at once, so a cover never downloads the archive.
export async function httpSource(get: RangeFetch): Promise<ZipSource> {
  const refuse = (res: Response): never => {
    void res.body?.cancel();
    throw new Error(`Range refusé (HTTP ${res.status})`); // i18n-ignore: covers fail silently
  };
  const first = await get(`bytes=-${TAIL}`);
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(first.headers.get('content-range') ?? '');
  if (first.status !== 206 || !m) refuse(first);
  const tailStart = Number(m![1]);
  const tail = await rangeBody(first, TAIL);
  return {
    size: Number(m![3]),
    async read(position, length) {
      const at = position - tailStart;
      if (at >= 0 && at + length <= tail.length) return tail.subarray(at, at + length);
      const res = await get(`bytes=${position}-${position + length - 1}`);
      if (res.status !== 206) refuse(res);
      return rangeBody(res, length);
    },
  };
}
