// A small QR code encoder (ISO/IEC 18004: byte mode, error correction level M, versions 1 to 6, up to 106 bytes)
// for the plex.tv/link code (plex-spec §5.1): enough for a short URL, no dependency. qrMatrix() gives the modules
// (true = dark), qrPath() an SVG path of them. Checked by tools/checks/plex-link-check.mjs (the ISO Reed-Solomon
// and format vectors, and the structure); verified once against a reference decoder.

// Per version (index 0 = version 1), level M: [EC codewords per block, [blocks, data codewords per block]].
const BLOCKS: readonly [number, number, number][] = [
  [10, 1, 16],
  [16, 1, 28],
  [26, 1, 44],
  [18, 2, 32],
  [24, 2, 43],
  [16, 4, 27],
];
const ALIGN: readonly number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// The n error correction codewords of `data`.
export function reedSolomon(data: readonly number[], n: number): number[] {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array<number>(n).fill(0);
  for (const d of data) {
    const f = d ^ rem.shift()!;
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f);
  }
  return rem;
}

// The 15 format bits of level M (00) and a mask, BCH-coded and XOR-masked.
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Data codewords for `bytes` in the smallest version that holds them, and that version (1-based).
function codewords(bytes: Uint8Array): { version: number; words: number[] } {
  const v = BLOCKS.findIndex(([, blocks, per]) => 4 + 8 + bytes.length * 8 <= blocks * per * 8);
  if (v < 0) throw new Error('QR: text too long');
  const [ec, blocks, per] = BLOCKS[v];
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  const capacity = blocks * per * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  for (let pad = 0xec; data.length < blocks * per; pad ^= 0xec ^ 0x11) data.push(pad);
  // Split into blocks, add each one's EC, interleave.
  const parts = Array.from({ length: blocks }, (_, i) => data.slice(i * per, (i + 1) * per));
  const ecs = parts.map((p) => reedSolomon(p, ec));
  const words: number[] = [];
  for (let i = 0; i < per; i++) for (const p of parts) words.push(p[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) words.push(e[i]);
  return { version: v + 1, words };
}

export function qrMatrix(text: string): boolean[][] {
  const { version, words } = codewords(new TextEncoder().encode(text));
  const size = 17 + version * 4;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, on: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    dark[r][c] = on;
    fixed[r][c] = true;
  };
  // Finder patterns with their separators.
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ])
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(r0 + r, c0 + c, ring !== 2 && ring !== 4);
      }
  // Alignment patterns (not over a finder).
  for (const r of ALIGN[version - 1])
    for (const c of ALIGN[version - 1]) {
      if (fixed[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Timing patterns, the dark module, the reserved format areas.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  set(size - 8, 8, true);
  const formatCells: [number, number][][] = [[], []];
  for (let i = 0; i < 15; i++) {
    formatCells[0].push(i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : i === 8 ? [8, 7] : [8, 14 - i]);
    formatCells[1].push(i < 8 ? [8, size - 1 - i] : [size - 15 + i, 8]);
  }
  for (const cells of formatCells) for (const [r, c] of cells) set(r, c, false);
  // Data, in two-column zigzags from the bottom right, skipping the timing column.
  const bits = words.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1));
  let k = 0;
  for (let right = size - 1, up = true; right > 0; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [right, right - 1]) if (!fixed[r][c]) dark[r][c] = bits[k++] === 1;
    }
  }
  // The mask with the lowest penalty.
  let best: boolean[][] = dark;
  let bestScore = Infinity;
  MASKS.forEach((fn, m) => {
    const grid = dark.map((row, r) => row.map((on, c) => (fixed[r][c] ? on : on !== fn(r, c))));
    const f = formatBits(m);
    for (const cells of formatCells) cells.forEach(([r, c], i) => (grid[r][c] = ((f >> i) & 1) === 1));
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  });
  return best;
}

// ISO penalty rules 1 (runs), 2 (2×2 blocks), 3 (finder-like runs) and 4 (balance).
function penalty(g: boolean[][]): number {
  const n = g.length;
  let score = 0;
  const lines = [...g, ...g.map((_, c) => g.map((row) => row[c]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const s = line.map((x) => (x ? '1' : '0')).join('');
    score += 40 * ((s.match(/(?=10111010000|00001011101)/g) ?? []).length);
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) score += 3;
  const darkCount = g.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((darkCount * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

// One SVG path for the dark modules, with a 4-module quiet zone: viewBox 0 0 (size + 8) (size + 8).
export function qrPath(text: string): { size: number; d: string } {
  const m = qrMatrix(text);
  let d = '';
  m.forEach((row, r) => row.forEach((on, c) => on && (d += `M${c + 4} ${r + 4}h1v1h-1z`)));
  return { size: m.length + 8, d };
}
