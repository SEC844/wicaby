// Live TV zapping (spec §8.3, §8.4): the zap list, CH+/- merging, held keys, the last channel and
// the number-entry DigitBuffer (also the guide's jump mode). Time is injected so the golden
// vectors replay it. Pure and erasable TypeScript only; C/livetv/Zap.kt mirrors it (zap.json).
import { compareNumKey, numKeyText, parseChannelNumber } from './channel-order';
import type { NumKey, ZapEntry } from './model';

// ---- Zap list ----

export const ZAP_MERGE_MS = 400;
export const HELD_PREVIEW_MS = 125; // held CH keys preview at most 8 channels/s

// Next / previous with wrap, skipping hidden ids. When `fromId` is not in the list (a search
// tune), its position is found by number order.
export function zapTarget(list: readonly ZapEntry[], fromId: string, delta: 1 | -1, fromNumber?: string, hidden: readonly string[] = []): string | null {
  const skip = new Set(hidden);
  const usable = list.filter((e) => !skip.has(e.id));
  if (!usable.length) return null;
  const n = usable.length;
  const i = usable.findIndex((e) => e.id === fromId);
  if (i >= 0) {
    if (n === 1) return usable[0].id === fromId ? null : usable[0].id;
    return usable[(((i + delta) % n) + n) % n].id;
  }
  // Not in the list: the slot it would take in number order.
  const key = parseChannelNumber(fromNumber ?? list.find((e) => e.id === fromId)?.number ?? '');
  let at = usable.findIndex((e) => compareNumKey(parseChannelNumber(e.number), key) > 0);
  if (at < 0) at = n; // after everything
  return delta > 0 ? usable[at % n].id : usable[(at - 1 + n) % n].id;
}

export interface ZapState {
  current: string | null; // adopted channel
  last: string | null; // the adopted channel before it ("Chaîne précédente")
  pending: string | null; // merged target shown in the banner, not yet tuned
  fireAt: number | null; // when the merged tune fires
  held: boolean; // a CH key is held (TV): preview only, tune on key-up
  lastPreviewAt: number;
  tuning: string | null; // the tune in flight
}

export type ZapEvent =
  | { type: 'press'; delta: 1 | -1; at: number; repeat?: boolean }
  | { type: 'key-up'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'tune'; id: string; at: number } // digits, mini-guide, guide, search…
  | { type: 'last-channel'; at: number }
  | { type: 'adopted'; id: string }
  | { type: 'failed'; id: string };

export type ZapEffect = { type: 'banner'; id: string } | { type: 'tune'; id: string };

export function zapInit(current: string | null = null): ZapState {
  return { current, last: null, pending: null, fireAt: null, held: false, lastPreviewAt: -Infinity, tuning: null };
}

export function zapReduce(s: ZapState, ev: ZapEvent, list: readonly ZapEntry[], hidden: readonly string[] = []): { state: ZapState; effects: ZapEffect[] } {
  switch (ev.type) {
    case 'press': {
      const from = s.pending ?? s.tuning ?? s.current;
      if (from === null) return { state: s, effects: [] };
      if (ev.repeat && ev.at - s.lastPreviewAt < HELD_PREVIEW_MS) return { state: { ...s, held: true, fireAt: null }, effects: [] };
      const target = zapTarget(list, from, ev.delta, undefined, hidden);
      if (target === null) return { state: s, effects: [] };
      const held = ev.repeat === true;
      return {
        state: { ...s, pending: target, fireAt: held ? null : ev.at + ZAP_MERGE_MS, held, lastPreviewAt: ev.at },
        effects: [{ type: 'banner', id: target }],
      };
    }
    case 'key-up': {
      if (!s.held || s.pending === null) return { state: { ...s, held: false }, effects: [] };
      return fire({ ...s, held: false });
    }
    case 'tick': {
      if (s.pending === null || s.fireAt === null || ev.at < s.fireAt) return { state: s, effects: [] };
      return fire(s);
    }
    case 'tune': {
      const st = { ...s, pending: null, fireAt: null, held: false };
      if (ev.id === s.current && s.tuning === null) return { state: st, effects: [{ type: 'banner', id: ev.id }] };
      return { state: { ...st, tuning: ev.id }, effects: [{ type: 'banner', id: ev.id }, { type: 'tune', id: ev.id }] };
    }
    case 'last-channel': {
      if (s.last === null) return { state: s, effects: [] };
      return zapReduce(s, { type: 'tune', id: s.last, at: ev.at }, list, hidden);
    }
    case 'adopted': {
      if (ev.id === s.current) return { state: { ...s, tuning: s.tuning === ev.id ? null : s.tuning }, effects: [] };
      return { state: { ...s, last: s.current, current: ev.id, tuning: s.tuning === ev.id ? null : s.tuning }, effects: [] };
    }
    case 'failed':
      return { state: { ...s, tuning: s.tuning === ev.id ? null : s.tuning }, effects: [] };
  }
}

function fire(s: ZapState): { state: ZapState; effects: ZapEffect[] } {
  const id = s.pending as string;
  const st: ZapState = { ...s, pending: null, fireAt: null };
  if (id === s.current && s.tuning === null) return { state: st, effects: [] };
  return { state: { ...st, tuning: id }, effects: [{ type: 'tune', id }] };
}

// ---- Number entry (§8.4) ----

export interface DigitChannel {
  id: string;
  number: string;
  hidden?: boolean;
}

export const DIGIT_TIMEOUT_MS = 1800;
export const JUMP_TIMEOUT_MS = 1200;
export const DIGIT_MAX_CHARS = 6;

export interface DigitState {
  buf: string; // digits and at most one '.'
  pick: number; // index among exact duplicates (↑/↓)
  lastKeyAt: number;
}

export type DigitPreview =
  | { kind: 'exact'; ids: string[]; pick: number } // ids in lineup order; 'pick' is the one OK tunes
  | { kind: 'prefix'; id: string }
  | { kind: 'alias'; id: string }
  | { kind: 'none' };

export type DigitResult =
  | { type: 'commit'; id: string; hidden: boolean; via: 'exact' | 'alias' }
  | { type: 'fail'; number: string }
  | { type: 'last-channel' }
  | { type: 'cancel' };

export type DigitEvent =
  | { type: 'digit'; d: string; at: number }
  | { type: 'separator'; at: number }
  | { type: 'backspace'; at: number }
  | { type: 'enter'; at: number }
  | { type: 'pick'; delta: 1 | -1; at: number }
  | { type: 'escape'; at: number }
  | { type: 'tick'; at: number };

export interface DigitStep {
  state: DigitState | null; // null = the buffer is closed
  preview: DigitPreview | null;
  result?: DigitResult;
}

// Lookup tables over the whole lineup (hidden channels included), built once per lineup.
export interface DigitIndex {
  rows: { id: string; raw: string; key: NumKey | null; canon: string; hidden: boolean }[];
}

const normRaw = (s: string): string => s.trim().replace(/\s*[.\-_ ]\s*/, '.');

export function digitIndex(lineup: readonly DigitChannel[]): DigitIndex {
  return {
    rows: lineup.map((c) => {
      const key = parseChannelNumber(c.number);
      return { id: c.id, raw: key ? normRaw(c.number) : '', key, canon: key ? numKeyText(key) : '', hidden: c.hidden === true };
    }),
  };
}

// Exact matches, raw first ('05' reaches the channel numbered '05'), then by number key ('02' → 2).
function exact(ix: DigitIndex, buf: string): DigitIndex['rows'] {
  const raw = ix.rows.filter((r) => r.key !== null && r.raw === buf);
  if (raw.length) return raw;
  const key = parseChannelNumber(buf);
  if (!key) return [];
  return ix.rows.filter((r) => r.key !== null && r.key[0] === key[0] && r.key[1] === key[1]);
}

// Numbers that extend the buffer (raw or canonical form), other than an exact match. A buffer with
// a leading zero extends by raw numbers only ('0' waits for '05'; '02' does not wait for 20–29).
function extendable(ix: DigitIndex, buf: string): DigitIndex['rows'] {
  if (buf.startsWith('0')) return ix.rows.filter((r) => r.key !== null && r.raw.startsWith(buf) && r.raw !== buf);
  const key = parseChannelNumber(buf.endsWith('.') ? buf.slice(0, -1) : buf);
  const canon = key ? numKeyText(key) + (buf.endsWith('.') ? '.' : '') : buf;
  return ix.rows.filter((r) => r.key !== null && ((r.raw.startsWith(buf) && r.raw !== buf) || (r.canon.startsWith(canon) && r.canon !== canon)));
}

// Sub-channel alias: '51' → 5.1 when no channel 51 exists (longest major part first).
function alias(ix: DigitIndex, buf: string): DigitIndex['rows'][number] | null {
  if (buf.includes('.') || buf.length < 2) return null;
  for (let i = buf.length - 1; i >= 1; i--) {
    const major = Number(buf.slice(0, i));
    const minor = Number(buf.slice(i));
    const hit = ix.rows.find((r) => r.key !== null && r.key[0] === major && r.key[1] === minor);
    if (hit) return hit;
  }
  return null;
}

// Could more digits still make an alias match? ('51' waits when 5.12 exists.)
function aliasPossible(ix: DigitIndex, buf: string): boolean {
  if (buf.includes('.')) return false;
  for (let i = 1; i < buf.length; i++) {
    const major = Number(buf.slice(0, i));
    const minorPart = buf.slice(i);
    if (ix.rows.some((r) => r.key !== null && r.key[1] >= 0 && r.key[0] === major && String(r.key[1]).startsWith(minorPart))) return true;
  }
  return false;
}

export function digitPreview(ix: DigitIndex, st: DigitState): DigitPreview {
  const ex = exact(ix, st.buf);
  if (ex.length) return { kind: 'exact', ids: ex.map((r) => r.id), pick: Math.min(st.pick, ex.length - 1) };
  const al = alias(ix, st.buf);
  if (al) return { kind: 'alias', id: al.id };
  const ext = extendable(ix, st.buf);
  if (ext.length) return { kind: 'prefix', id: ext[0].id };
  return { kind: 'none' };
}

function resolve(ix: DigitIndex, st: DigitState): DigitResult {
  const ex = exact(ix, st.buf);
  if (ex.length) {
    const r = ex[Math.min(st.pick, ex.length - 1)];
    return { type: 'commit', id: r.id, hidden: r.hidden, via: 'exact' };
  }
  const al = alias(ix, st.buf);
  if (al) return { type: 'commit', id: al.id, hidden: al.hidden, via: 'alias' };
  return { type: 'fail', number: st.buf };
}

// After a key: commit at once on a unique exact match that nothing extends; fail at once when
// nothing starts with the buffer and no alias can match.
function settle(ix: DigitIndex, st: DigitState): DigitStep {
  const preview = digitPreview(ix, st);
  const ex = exact(ix, st.buf);
  const ext = extendable(ix, st.buf);
  if (ex.length === 1 && !ext.length && !aliasPossible(ix, st.buf)) return { state: null, preview, result: resolve(ix, st) };
  if (!ex.length && !ext.length && !alias(ix, st.buf) && !aliasPossible(ix, st.buf)) return { state: null, preview, result: { type: 'fail', number: st.buf } };
  return { state: st, preview };
}

// One step of the buffer. `st` null means closed: a digit opens it, Backspace means last channel.
export function digitReduce(ix: DigitIndex, st: DigitState | null, ev: DigitEvent, timeoutMs = DIGIT_TIMEOUT_MS): DigitStep {
  switch (ev.type) {
    case 'digit': {
      if (!/^[0-9]$/.test(ev.d)) return { state: st, preview: st ? digitPreview(ix, st) : null };
      const buf = st?.buf ?? '';
      if (buf.length >= DIGIT_MAX_CHARS) return { state: { ...(st as DigitState), lastKeyAt: ev.at }, preview: digitPreview(ix, st as DigitState) };
      return settle(ix, { buf: buf + ev.d, pick: 0, lastKeyAt: ev.at });
    }
    case 'separator': {
      if (!st || st.buf.includes('.') || st.buf.length >= DIGIT_MAX_CHARS) return { state: st ? { ...st, lastKeyAt: ev.at } : null, preview: st ? digitPreview(ix, st) : null };
      const next = { buf: st.buf + '.', pick: 0, lastKeyAt: ev.at };
      return { state: next, preview: digitPreview(ix, next) };
    }
    case 'backspace': {
      if (!st) return { state: null, preview: null, result: { type: 'last-channel' } };
      const buf = st.buf.slice(0, -1);
      if (!buf) return { state: null, preview: null, result: { type: 'cancel' } };
      const next = { buf, pick: 0, lastKeyAt: ev.at };
      return { state: next, preview: digitPreview(ix, next) };
    }
    case 'pick': {
      if (!st) return { state: null, preview: null };
      const ex = exact(ix, st.buf);
      if (ex.length < 2) return { state: { ...st, lastKeyAt: ev.at }, preview: digitPreview(ix, st) };
      const n = ex.length;
      const next = { ...st, pick: (((st.pick + ev.delta) % n) + n) % n, lastKeyAt: ev.at };
      return { state: next, preview: digitPreview(ix, next) };
    }
    case 'enter':
      if (!st) return { state: null, preview: null };
      return { state: null, preview: digitPreview(ix, st), result: resolve(ix, st) };
    case 'escape':
      return { state: null, preview: null, result: st ? { type: 'cancel' } : undefined };
    case 'tick':
      if (!st) return { state: null, preview: null };
      if (ev.at - st.lastKeyAt < timeoutMs) return { state: st, preview: digitPreview(ix, st) };
      return { state: null, preview: digitPreview(ix, st), result: resolve(ix, st) };
  }
}
