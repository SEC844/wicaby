// Live TV DisplayPreferences document `wicaby-livetv` (spec §5.4): the lt.* keys, 6 kB chunking,
// the read-modify-write merge and the refuse-to-write rule.
// Pure and erasable TypeScript only; C/livetv/PrefsCodec.kt mirrors it (vectors: prefs.json).
import type { ClientGroup } from './lens';
import type { LensRef } from './model';
import type { SortMode } from './channel-order';

export const PREFS_ID = 'wicaby-livetv';
export const PREFS_CLIENT = 'wicaby';
export const PREFS_VERSION = '1';
export const CHUNK_BYTES = 6000;
export const RECENTS_CAP = 20;

export type Badge = 'live' | 'new' | 'premiere' | 'repeat' | 'hd' | 'rating';
export const DEFAULT_BADGES: readonly Badge[] = ['live', 'new', 'hd'];
const BADGES: readonly Badge[] = ['live', 'new', 'premiere', 'repeat', 'hd', 'rating'];

export interface LivePrefs {
  sort: SortMode;
  favFirst: boolean;
  lens: LensRef;
  fav: string[]; // favourite order (membership stays IsFavorite)
  hidden: string[];
  groups: ClientGroup[];
  recents: string[];
  badges: Badge[];
  dvrPadding: { pre: number; post: number } | null;
}

export type PrefField = keyof LivePrefs;
export const PREF_FIELDS: readonly PrefField[] = ['sort', 'favFirst', 'lens', 'fav', 'hidden', 'groups', 'recents', 'badges', 'dvrPadding'];

export function defaultPrefs(): LivePrefs {
  return { sort: 'number', favFirst: false, lens: { kind: 'all' }, fav: [], hidden: [], groups: [], recents: [], badges: [...DEFAULT_BADGES], dvrPadding: null };
}

// The CustomPrefs keys a field owns: a single key, or a chunk prefix (`lt.fav.0` … `lt.fav.N`).
const SINGLE: Partial<Record<PrefField, string>> = { sort: 'lt.sort', favFirst: 'lt.favFirst', lens: 'lt.lens', recents: 'lt.recents', badges: 'lt.badges', dvrPadding: 'lt.dvrPadding' };
const CHUNKED: Partial<Record<PrefField, string>> = { fav: 'lt.fav', hidden: 'lt.hidden', groups: 'lt.groups' };

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// Splits an array into JSON arrays of at most `max` UTF-8 bytes each (an element is never split;
// a single oversized element gets a chunk of its own). An empty array writes no key.
export function chunkArray(prefix: string, items: readonly unknown[], max = CHUNK_BYTES): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string[] = [];
  let size = 2; // '[' + ']'
  let n = 0;
  const flush = (): void => {
    if (!cur.length) return;
    out[`${prefix}.${n++}`] = `[${cur.join(',')}]`;
    cur = [];
    size = 2;
  };
  for (const it of items) {
    const json = JSON.stringify(it);
    const add = utf8Length(json) + (cur.length ? 1 : 0);
    if (cur.length && size + add > max) flush();
    cur.push(json);
    size += utf8Length(json) + (cur.length > 1 ? 1 : 0);
  }
  flush();
  return out;
}

// Reads prefix.0, prefix.1, … until a gap; a chunk that is not a JSON array is skipped.
export function readChunks(custom: Readonly<Record<string, string>>, prefix: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; Object.prototype.hasOwnProperty.call(custom, `${prefix}.${i}`); i++) {
    try {
      const v: unknown = JSON.parse(custom[`${prefix}.${i}`]);
      if (Array.isArray(v)) out.push(...v);
    } catch {
      // skipped
    }
  }
  return out;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const uniq = (a: string[]): string[] => [...new Set(a)];

function parseJson(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function asLens(v: unknown): LensRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'all':
    case 'favorites':
    case 'recents':
    case 'radio':
      return { kind: o.kind };
    case 'tag':
      return isStr(o.tag) ? { kind: 'tag', tag: o.tag } : null;
    case 'group':
      return isStr(o.id) ? { kind: 'group', id: o.id } : null;
    default:
      return null;
  }
}

// CustomPrefs → LivePrefs. Unknown or broken values fall back to the defaults.
export function decodePrefs(custom: Readonly<Record<string, string>> | null | undefined): LivePrefs {
  const c = custom ?? {};
  const p = defaultPrefs();
  const sort = c['lt.sort'];
  if (sort === 'number' || sort === 'name' || sort === 'recent' || sort === 'server') p.sort = sort;
  if (c['lt.favFirst'] === '1') p.favFirst = true;
  p.lens = asLens(parseJson(c['lt.lens'])) ?? p.lens;
  p.fav = uniq(readChunks(c, 'lt.fav').filter(isStr));
  p.hidden = uniq(readChunks(c, 'lt.hidden').filter(isStr));
  p.groups = readChunks(c, 'lt.groups').flatMap((g): ClientGroup[] => {
    if (!g || typeof g !== 'object') return [];
    const o = g as Record<string, unknown>;
    if (!isStr(o.id) || typeof o.name !== 'string' || !Array.isArray(o.ids)) return [];
    return [{ id: o.id, name: o.name, ids: uniq(o.ids.filter(isStr)) }];
  });
  const rec = parseJson(c['lt.recents']);
  if (Array.isArray(rec)) p.recents = uniq(rec.filter(isStr)).slice(0, RECENTS_CAP);
  if (c['lt.badges'] !== undefined) p.badges = c['lt.badges'].split(',').filter((b): b is Badge => (BADGES as readonly string[]).includes(b));
  const pad = parseJson(c['lt.dvrPadding']);
  if (pad && typeof pad === 'object') {
    const o = pad as Record<string, unknown>;
    if (typeof o.pre === 'number' && typeof o.post === 'number' && o.pre >= 0 && o.post >= 0) p.dvrPadding = { pre: o.pre, post: o.post };
  }
  return p;
}

// The keys one field encodes to (chunk keys numbered from 0).
export function encodeField<K extends PrefField>(field: K, value: LivePrefs[K]): Record<string, string> {
  switch (field) {
    case 'sort':
      return { 'lt.sort': value as string };
    case 'favFirst':
      return { 'lt.favFirst': value ? '1' : '0' };
    case 'lens':
      return { 'lt.lens': JSON.stringify(value) };
    case 'recents':
      return { 'lt.recents': JSON.stringify((value as string[]).slice(0, RECENTS_CAP)) };
    case 'badges':
      return { 'lt.badges': (value as string[]).join(',') };
    case 'dvrPadding':
      return value ? { 'lt.dvrPadding': JSON.stringify(value) } : {};
    default:
      return chunkArray(CHUNKED[field] as string, value as unknown[]);
  }
}

function ownsKey(field: PrefField, key: string): boolean {
  const single = SINGLE[field];
  if (single) return key === single;
  const prefix = CHUNKED[field] as string;
  return key.startsWith(`${prefix}.`) && /^\d+$/.test(key.slice(prefix.length + 1));
}

// Read-modify-write: start from the server's CustomPrefs, replace only the changed fields (their
// old keys, including chunk keys the new value no longer uses, are deleted), keep everything else
// (other apps' keys, other fields written by another device), and stamp lt.v.
export function mergeCustomPrefs(server: Readonly<Record<string, string>> | null | undefined, changes: Partial<LivePrefs>): Record<string, string> {
  const out: Record<string, string> = { ...(server ?? {}) };
  for (const field of PREF_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    for (const k of Object.keys(out)) if (ownsKey(field, k)) delete out[k];
    Object.assign(out, encodeField(field, changes[field] as LivePrefs[typeof field]));
  }
  out['lt.v'] = PREFS_VERSION;
  return out;
}

// The full DTO to POST: the server document with Id, Client and CustomPrefs set (Emby reads the
// client from the body, §5.2).
export function prefsBody(serverDto: Readonly<Record<string, unknown>> | null | undefined, custom: Record<string, string>): Record<string, unknown> {
  return { ...(serverDto ?? {}), Id: PREFS_ID, Client: PREFS_CLIENT, CustomPrefs: custom };
}

// ---- Write queue: refuse to write while the document failed to load ----

export interface PrefsSync {
  load: 'pending' | 'ok' | 'failed';
  queued: Partial<LivePrefs>; // last-writer-wins per field
}

export function syncInit(): PrefsSync {
  return { load: 'pending', queued: {} };
}

export function queueChange(s: PrefsSync, changes: Partial<LivePrefs>): PrefsSync {
  return { ...s, queued: { ...s.queued, ...changes } };
}

export function loaded(s: PrefsSync, ok: boolean): PrefsSync {
  return { ...s, load: ok ? 'ok' : 'failed' };
}

// The next POST, or null when nothing is queued or the document is not loaded (no empty overwrite).
export function planWrite(s: PrefsSync, server: Readonly<Record<string, unknown>> | null): { body: Record<string, unknown>; next: PrefsSync } | null {
  if (s.load !== 'ok' || !Object.keys(s.queued).length) return null;
  const custom = (server?.CustomPrefs ?? {}) as Record<string, string>;
  return { body: prefsBody(server, mergeCustomPrefs(custom, s.queued)), next: { ...s, queued: {} } };
}

// Favourite toggles and order edits are refused while favourites or prefs failed to load (§6.5).
export function canEditFavorites(s: PrefsSync, favoritesLoaded: boolean): boolean {
  return s.load === 'ok' && favoritesLoaded;
}
