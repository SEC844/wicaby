// A ZIP archive read over HTTP Range requests (the comic reader's CBZ, ZIP and image EPUB): the end of the file for
// the central directory, then each entry on demand, so a 300 MB book opens without being downloaded. Where the
// server ignores Range (a 200 answer), the whole file is kept and read in memory. The absolute offset of the end
// read is found from the directory itself, so the Content-Range header (often not exposed to scripts) is not needed.
import { inflate } from './inflate';

export interface Entry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  offset: number;
}

// The end record plus the longest comment.
const TAIL = 22 + 65_535;
// Room for the local header's name and extra field, which may differ from the central directory's.
const SLACK = 1024;

export class ZipError extends Error {
  constructor(readonly kind: 'format' | 'encrypted' | 'too-large' | 'http') {
    super(kind);
  }
}

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const u32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

const UTF8 = new TextDecoder('utf-8');
const utf8 = (b: Uint8Array) => UTF8.decode(b);

export class Zip {
  entries: Entry[] = [];
  private whole: Uint8Array | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async range(from: number, to?: number): Promise<{ status: number; bytes: Uint8Array }> {
    const res = await fetch(this.url, { headers: { ...this.headers, Range: to === undefined ? `bytes=-${from}` : `bytes=${from}-${to}` } });
    if (!res.ok) throw new ZipError('http');
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  async open(maxWholeBytes = 400 * 1024 * 1024): Promise<void> {
    const { status, bytes } = await this.range(TAIL);
    // The whole file came back: read it in memory.
    if (status === 200) {
      if (bytes.length > maxWholeBytes) throw new ZipError('too-large');
      this.whole = bytes;
    }
    const tail = bytes;
    let p = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        p = i;
        break;
      }
    }
    if (p < 0) throw new ZipError('format');
    const count = u16(tail, p + 10);
    const cdSize = u32(tail, p + 12);
    const cdOffset = u32(tail, p + 16);
    // ZIP64 (over 4 GB or 65,535 entries) is not read.
    if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('too-large');
    // The tail starts at this absolute offset (the directory ends where the end record starts).
    const base = this.whole ? 0 : cdOffset + cdSize - p;
    let cd: Uint8Array;
    if (cdOffset >= base) cd = tail.subarray(cdOffset - base, cdOffset - base + cdSize);
    else cd = (await this.range(cdOffset, cdOffset + cdSize - 1)).bytes;
    const out: Entry[] = [];
    for (let q = 0, k = 0; k < count && q + 46 <= cd.length; k++) {
      if (u32(cd, q) !== 0x02014b50) throw new ZipError('format');
      const flags = u16(cd, q + 8);
      const nameLen = u16(cd, q + 28);
      const extraLen = u16(cd, q + 30);
      const commentLen = u16(cd, q + 32);
      const name = utf8(cd.subarray(q + 46, q + 46 + nameLen));
      if (flags & 1 && !name.endsWith('/')) throw new ZipError('encrypted');
      out.push({ name, method: u16(cd, q + 10), csize: u32(cd, q + 20), usize: u32(cd, q + 24), offset: u32(cd, q + 42) });
      q += 46 + nameLen + extraLen + commentLen;
    }
    this.entries = out;
  }

  // The entry's bytes, inflated (stored and deflate only; anything else is refused).
  async read(e: Entry): Promise<Uint8Array> {
    if (e.method !== 0 && e.method !== 8) throw new ZipError('format');
    const span = 30 + e.name.length * 3 + SLACK + e.csize;
    const b = this.whole ? this.whole.subarray(e.offset, e.offset + span) : (await this.range(e.offset, e.offset + span - 1)).bytes;
    if (u32(b, 0) !== 0x04034b50) throw new ZipError('format');
    const start = 30 + u16(b, 26) + u16(b, 28);
    const data = b.subarray(start, start + e.csize);
    if (data.length < e.csize) throw new ZipError('format');
    return e.method === 0 ? data : inflate(data, e.usize);
  }

  find(name: string): Entry | undefined {
    const n = name.toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === n || e.name.toLowerCase().endsWith(`/${n}`));
  }
}
