// Live TV channel numbers, the name fold and the channel sorts (spec §4.4, §6.5).
// Pure and erasable TypeScript only: tools/checks/livetv-check.mjs imports it with Node's type
// stripping, and C/livetv/ChannelOrder.kt mirrors it (golden vectors: channel-order.json).
import type { ChannelRow, NumKey } from './model';

const NUMBER_RE = /^\s*(\d+)(?:\s*[.\-_ ]\s*(\d+))?\s*$/;

// '5.1' → [5,1], '105' → [105,-1], '02' → [2,-1], '' or 'HD1' → null.
export function parseChannelNumber(s: string | null | undefined): NumKey | null {
  if (!s) return null;
  const m = NUMBER_RE.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? -1 : Number(m[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return [major, minor];
}

// Canonical text of a number key: [5,1] → '5.1', [105,-1] → '105'.
export function numKeyText(k: NumKey): string {
  return k[1] < 0 ? String(k[0]) : `${k[0]}.${k[1]}`;
}

export function compareNumKey(a: NumKey | null, b: NumKey | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // no number last
  return a[0] - b[0] || a[1] - b[1];
}

// ---- nameKey: one fold for sorting, channel search and genre keywords ----
// Unicode NFD, combining marks U+0300–U+036F dropped, each code point lower-cased on its own
// (root, simple mapping: Kotlin Character.toLowerCase(int); so no final-sigma rule), whitespace
// (≤ U+0020, NBSP, U+2007, U+202F) trimmed and collapsed to one space. 'Œ' and 'ß' stay as they
// are. Never Intl.Collator (ICU differs between Node, the JDK and Android).
export function nameKey(s: string | null | undefined): string {
  if (!s) return '';
  let out = '';
  let space = false;
  for (const ch of s.normalize('NFD')) {
    const c = ch.charCodeAt(0);
    if (ch.length === 1 && c >= 0x300 && c <= 0x36f) continue;
    if (c <= 0x20 || c === 0xa0 || c === 0x2007 || c === 0x202f) {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += ch.toLowerCase();
  }
  return out;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

// Natural order of two folded keys: digit runs by value, then by length (leading zeros after),
// other runs by UTF-16 code units; a digit run sorts before a non-digit run.
export function compareFolded(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);
    const da = isDigit(ca);
    const db = isDigit(cb);
    if (da && db) {
      let ie = i;
      while (ie < a.length && isDigit(a.charCodeAt(ie))) ie++;
      let je = j;
      while (je < b.length && isDigit(b.charCodeAt(je))) je++;
      let ia = i;
      while (ia < ie - 1 && a.charCodeAt(ia) === 48) ia++;
      let jb = j;
      while (jb < je - 1 && b.charCodeAt(jb) === 48) jb++;
      const lenA = ie - ia;
      const lenB = je - jb;
      if (lenA !== lenB) return lenA - lenB;
      for (let k = 0; k < lenA; k++) {
        const d = a.charCodeAt(ia + k) - b.charCodeAt(jb + k);
        if (d) return d;
      }
      const raw = ie - i - (je - j);
      if (raw) return raw;
      i = ie;
      j = je;
      continue;
    }
    if (da !== db) return da ? -1 : 1;
    if (ca !== cb) return ca - cb;
    i++;
    j++;
  }
  return a.length - i - (b.length - j);
}

export function compareNames(a: string, b: string): number {
  return compareFolded(nameKey(a), nameKey(b));
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type SortMode = 'number' | 'name' | 'recent' | 'server';
export const SORT_MODES: readonly SortMode[] = ['number', 'name', 'recent', 'server'];

// Numéro: numKey (no number last), then natural name, then id.
export function compareByNumber(a: ChannelRow, b: ChannelRow): number {
  return compareNumKey(a.numKey, b.numKey) || compareNames(a.name, b.name) || cmpStr(a.id, b.id);
}

// Nom: nameKey natural order, then number, then id.
export function compareByName(a: ChannelRow, b: ChannelRow): number {
  return compareNames(a.name, b.name) || compareNumKey(a.numKey, b.numKey) || cmpStr(a.id, b.id);
}

export function compareByServer(a: ChannelRow, b: ChannelRow): number {
  return a.serverIndex - b.serverIndex || cmpStr(a.id, b.id);
}

// Sorts a copy. 'recent' puts the MRU ids first (MRU order), then the rest by number.
// favFirst stably moves favourites to the top.
export function sortChannels(rows: readonly ChannelRow[], mode: SortMode, opts: { mru?: readonly string[]; favFirst?: boolean } = {}): ChannelRow[] {
  let out: ChannelRow[];
  if (mode === 'recent') {
    const rank = new Map<string, number>();
    (opts.mru ?? []).forEach((id, i) => {
      if (!rank.has(id)) rank.set(id, i);
    });
    out = rows.slice().sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined || rb !== undefined) return ra !== undefined ? -1 : 1;
      return compareByNumber(a, b);
    });
  } else {
    out = rows.slice().sort(mode === 'name' ? compareByName : mode === 'server' ? compareByServer : compareByNumber);
  }
  if (opts.favFirst) out = [...out.filter((r) => r.favorite), ...out.filter((r) => !r.favorite)];
  return out;
}

// Ids of channels sharing a number key with another channel, grouped in input order.
export function duplicateNumbers(rows: readonly ChannelRow[]): string[][] {
  const by = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.numKey) continue;
    const k = numKeyText(r.numKey);
    const list = by.get(k);
    if (list) list.push(r.id);
    else by.set(k, [r.id]);
  }
  return [...by.values()].filter((l) => l.length > 1);
}
