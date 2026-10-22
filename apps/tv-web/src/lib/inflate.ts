// Raw DEFLATE (RFC 1951) for the comic reader's ZIP entries: stored, fixed and dynamic Huffman blocks. The TV
// engines have no DecompressionStream (Chromium 80+), and a library would weigh more than this.
// The output never grows past the size the entry claims, nor past MAX_OUTPUT: a small archive cannot expand into
// gigabytes (a deflate bomb) and run the TV out of memory.

// One comic page, as the largest entry worth opening.
export const MAX_OUTPUT = 64 * 1024 * 1024;

export class InflateError extends Error {}

class Tree {
  readonly counts = new Uint16Array(16);
  readonly symbols = new Uint16Array(288);
}

const LENGTH_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LENGTH_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
// The order code-length code lengths come in (§3.2.7).
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

function build(t: Tree, lengths: Uint8Array, off: number, n: number): void {
  t.counts.fill(0);
  for (let i = 0; i < n; i++) t.counts[lengths[off + i]]++;
  t.counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 0, sum = 0; i < 16; i++) {
    offs[i] = sum;
    sum += t.counts[i];
  }
  for (let i = 0; i < n; i++) if (lengths[off + i]) t.symbols[offs[lengths[off + i]]++] = i;
}

const FIXED_LIT = new Tree();
const FIXED_DIST = new Tree();
{
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  build(FIXED_LIT, l, 0, 288);
  const d = new Uint8Array(30).fill(5);
  build(FIXED_DIST, d, 0, 30);
}

class Reader {
  pos = 0;
  bit = 0;
  bits = 0;
  out: Uint8Array;
  n = 0;
  readonly limit: number;

  constructor(
    readonly src: Uint8Array,
    size: number,
  ) {
    if (size > MAX_OUTPUT) throw new InflateError('inflate: entry too large');
    this.limit = size > 0 ? size : MAX_OUTPUT;
    this.out = new Uint8Array(size > 0 ? size : Math.min(src.length * 4 + 1024, MAX_OUTPUT));
  }

  need(k: number): void {
    while (this.bits < k) {
      if (this.pos >= this.src.length) throw new InflateError('inflate: truncated');
      this.bit |= this.src[this.pos++] << this.bits;
      this.bits += 8;
    }
  }

  read(k: number): number {
    if (!k) return 0;
    this.need(k);
    const v = this.bit & ((1 << k) - 1);
    this.bit >>>= k;
    this.bits -= k;
    return v;
  }

  // Huffman codes are read bit by bit, most significant first (canonical codes).
  symbol(t: Tree): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.read(1);
      const count = t.counts[len];
      if (code - first < count) return t.symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('inflate: bad code');
  }

  put(b: number): void {
    if (this.n >= this.out.length) {
      if (this.n >= this.limit) throw new InflateError('inflate: output larger than claimed');
      const grown = new Uint8Array(Math.min(this.out.length * 2, this.limit));
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.n++] = b;
  }
}

function block(r: Reader, lit: Tree, dist: Tree): void {
  for (;;) {
    const s = r.symbol(lit);
    if (s === 256) return;
    if (s < 256) {
      r.put(s);
      continue;
    }
    const li = s - 257;
    const len = LENGTH_BASE[li] + r.read(LENGTH_EXTRA[li]);
    const di = r.symbol(dist);
    const back = DIST_BASE[di] + r.read(DIST_EXTRA[di]);
    if (back > r.n) throw new InflateError('inflate: bad distance');
    for (let i = 0; i < len; i++) r.put(r.out[r.n - back]);
  }
}

function dynamicTrees(r: Reader, lit: Tree, dist: Tree): void {
  const hlit = r.read(5) + 257;
  const hdist = r.read(5) + 1;
  const hclen = r.read(4) + 4;
  const lengths = new Uint8Array(288 + 32);
  for (let i = 0; i < hclen; i++) lengths[CL_ORDER[i]] = r.read(3);
  const cl = new Tree();
  build(cl, lengths, 0, 19);
  lengths.fill(0, 0, 19);
  for (let i = 0; i < hlit + hdist; ) {
    const s = r.symbol(cl);
    if (s < 16) lengths[i++] = s;
    else {
      const [rep, val] = s === 16 ? [3 + r.read(2), lengths[i - 1]] : s === 17 ? [3 + r.read(3), 0] : [11 + r.read(7), 0];
      lengths.fill(val, i, i + rep);
      i += rep;
    }
  }
  build(lit, lengths, 0, hlit);
  build(dist, lengths, hlit, hdist);
}

// Inflates [src]; [size] is the expected output length (the ZIP entry's): the buffer is sized once, and the output
// may not exceed it.
export function inflate(src: Uint8Array, size = 0): Uint8Array {
  const r = new Reader(src, size);
  const lit = new Tree();
  const dist = new Tree();
  let last = 0;
  do {
    last = r.read(1);
    const type = r.read(2);
    if (type === 0) {
      // Stored: byte-aligned length, its complement, then the bytes.
      r.bit = 0;
      r.bits = 0;
      if (r.pos + 4 > r.src.length) throw new InflateError('inflate: truncated');
      const len = r.src[r.pos] | (r.src[r.pos + 1] << 8);
      const nlen = r.src[r.pos + 2] | (r.src[r.pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('inflate: bad stored length');
      r.pos += 4;
      if (r.pos + len > r.src.length) throw new InflateError('inflate: truncated');
      for (let i = 0; i < len; i++) r.put(r.src[r.pos++]);
    } else if (type === 1) block(r, FIXED_LIT, FIXED_DIST);
    else if (type === 2) {
      dynamicTrees(r, lit, dist);
      block(r, lit, dist);
    } else throw new InflateError('inflate: bad block');
  } while (!last);
  return r.n === r.out.length ? r.out : r.out.subarray(0, r.n);
}
