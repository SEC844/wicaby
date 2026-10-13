// Live TV lenses (spec §6.5, §6.6): hidden channels, favourite order, recents, tags, client
// groups, radio, category rows and the IPTV genre fallback. One pipeline feeds the guide rows,
// the "Toutes les chaînes" list, the mini-guide and the zap list.
// Pure and erasable TypeScript only; C/livetv/Lens.kt mirrors it (vectors: lens.json).
import { compareByNumber, nameKey, sortChannels } from './channel-order';
import type { SortMode } from './channel-order';
import type { Category, ChannelRow, LensRef, LiveCaps, ProgramLite } from './model';

export interface ClientGroup {
  id: string;
  name: string;
  ids: string[];
}

// The synced part of the lens state (DisplayPreferences, §5.4).
export interface LensPrefs {
  favOrder: string[];
  hidden: string[];
  groups: ClientGroup[];
  recents: string[];
}

export const RECENTS_MAX = 20;

// Favoris: members in lt.fav order; members missing from it appended in number order; stale ids dropped.
export function reconcileFavorites(rows: readonly ChannelRow[], favOrder: readonly string[]): ChannelRow[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: ChannelRow[] = [];
  const seen = new Set<string>();
  for (const id of favOrder) {
    const r = byId.get(id);
    if (r && r.favorite && !seen.has(id)) {
      out.push(r);
      seen.add(id);
    }
  }
  const rest = rows.filter((r) => r.favorite && !seen.has(r.id)).sort(compareByNumber);
  return out.concat(rest);
}

// The favourite order to write back after a reconcile (drops stale ids, appends new members).
export function favoriteOrder(rows: readonly ChannelRow[], favOrder: readonly string[]): string[] {
  return reconcileFavorites(rows, favOrder).map((r) => r.id);
}

// Moves one id to the front of the MRU (at most RECENTS_MAX).
export function pushRecent(recents: readonly string[], id: string, max = RECENTS_MAX): string[] {
  return [id, ...recents.filter((x) => x !== id)].slice(0, max);
}

// Récentes: the stored MRU (existing channels only), topped up from UserData.LastPlayedDate.
export function recentIds(rows: readonly ChannelRow[], recents: readonly string[], max = RECENTS_MAX): string[] {
  const ids = new Set(rows.map((r) => r.id));
  const out: string[] = [];
  for (const id of recents) if (ids.has(id) && !out.includes(id) && out.length < max) out.push(id);
  if (out.length < max) {
    const played = rows
      .filter((r) => r.lastPlayed !== undefined && !out.includes(r.id))
      .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || compareByNumber(a, b));
    for (const r of played) {
      if (out.length >= max) break;
      out.push(r.id);
    }
  }
  return out;
}

export interface LensInput {
  rows: readonly ChannelRow[];
  lens: LensRef;
  prefs: LensPrefs;
  sort: SortMode;
  favFirst: boolean;
}

// The pipeline: hidden out → lens → sort. Favoris keeps the favourite order and Récentes the MRU
// order (neither is re-sorted); "Favoris en premier" applies to every other lens.
export function applyLens(input: LensInput): ChannelRow[] {
  const hidden = new Set(input.prefs.hidden);
  const visible = input.rows.filter((r) => !hidden.has(r.id));
  const lens = input.lens;
  const mru = recentIds(input.rows, input.prefs.recents);
  switch (lens.kind) {
    case 'favorites':
      return reconcileFavorites(visible, input.prefs.favOrder);
    case 'recents': {
      const byId = new Map(visible.map((r) => [r.id, r] as const));
      return mru.map((id) => byId.get(id)).filter((r): r is ChannelRow => r !== undefined);
    }
    case 'radio':
      return sortChannels(
        visible.filter((r) => r.radio),
        input.sort,
        { mru, favFirst: input.favFirst },
      );
    case 'tag':
      return sortChannels(
        visible.filter((r) => r.tags.includes(lens.tag)),
        input.sort,
        { mru, favFirst: input.favFirst },
      );
    case 'group': {
      const g = input.prefs.groups.find((x) => x.id === lens.id);
      const members = new Set(g?.ids ?? []);
      return sortChannels(
        visible.filter((r) => members.has(r.id)),
        input.sort,
        { mru, favFirst: input.favFirst },
      );
    }
    default:
      return sortChannels(visible, input.sort, { mru, favFirst: input.favFirst });
  }
}

// The lenses on offer, in bar order (also the ←/→ cycle of the mini-guide): Toutes, Favoris,
// Récentes, Radio (only when a radio channel exists), server tags (sorted), client groups.
export function availableLenses(rows: readonly ChannelRow[], groups: readonly ClientGroup[], serverTags = true): LensRef[] {
  const out: LensRef[] = [{ kind: 'all' }, { kind: 'favorites' }, { kind: 'recents' }];
  if (rows.some((r) => r.radio)) out.push({ kind: 'radio' });
  if (serverTags) {
    const tags = new Set<string>();
    for (const r of rows) for (const t of r.tags) tags.add(t);
    for (const tag of [...tags].sort((a, b) => compareTags(a, b))) out.push({ kind: 'tag', tag });
  }
  for (const g of groups) out.push({ kind: 'group', id: g.id });
  return out;
}

function compareTags(a: string, b: string): number {
  const ka = nameKey(a);
  const kb = nameKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

export function sameLens(a: LensRef, b: LensRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tag') return a.tag === (b as { tag: string }).tag;
  if (a.kind === 'group') return a.id === (b as { id: string }).id;
  return true;
}

// Previous / next lens with wrap; an unknown current lens starts from Toutes.
export function stepLens(list: readonly LensRef[], current: LensRef, delta: number): LensRef {
  if (!list.length) return { kind: 'all' };
  const i = list.findIndex((l) => sameLens(l, current));
  const n = list.length;
  const at = i < 0 ? 0 : (((i + delta) % n) + n) % n;
  return list[at];
}

// ---- URL state (§3.1): lens=all|fav|recent|radio|movies|…|tag:<name>|group:<id> ----

export function lensToParam(lens: LensRef): string {
  switch (lens.kind) {
    case 'favorites':
      return 'fav';
    case 'recents':
      return 'recent';
    case 'radio':
      return 'radio';
    case 'tag':
      return `tag:${lens.tag}`;
    case 'group':
      return `group:${lens.id}`;
    default:
      return 'all';
  }
}

export function lensFromParam(param: string | null | undefined): { lens: LensRef; category?: Category } {
  const p = param ?? '';
  if (p === 'fav') return { lens: { kind: 'favorites' } };
  if (p === 'recent') return { lens: { kind: 'recents' } };
  if (p === 'radio') return { lens: { kind: 'radio' } };
  if (p.startsWith('tag:') && p.length > 4) return { lens: { kind: 'tag', tag: p.slice(4) } };
  if (p.startsWith('group:') && p.length > 6) return { lens: { kind: 'group', id: p.slice(6) } };
  if (p === 'movies' || p === 'sports' || p === 'news' || p === 'kids' || p === 'series' || p === 'new') return { lens: { kind: 'all' }, category: p };
  return { lens: { kind: 'all' } };
}

// ---- Categories (§6.6) ----

export const CATEGORY_BITS: Readonly<Record<Category, number>> = {
  movies: 32, // PF.Movie
  sports: 64, // PF.Sports
  news: 128, // PF.News
  kids: 256, // PF.Kids
  series: 512, // PF.Series
  new: 2 | 4, // PF.New | PF.Premiere ("Inédits"; New is always 0 on Jellyfin)
};

export function programInCategory(p: Pick<ProgramLite, 'flags'>, cat: Category): boolean {
  return (p.flags & CATEGORY_BITS[cat]) !== 0;
}

// Cells outside the selected category fade to 35 % (they stay focusable).
export function dimmed(p: Pick<ProgramLite, 'flags'>, cat: Category | null | undefined): boolean {
  return !!cat && !programInCategory(p, cat);
}

// Rows: intersected with the category channel set only when the server honours the filter.
// "Inédits" has no channel-level flag except Emby's optional IsNewOrPremiere (same probe).
export function categoryRows(rows: readonly ChannelRow[], cat: Category | null | undefined, set: ReadonlySet<string> | readonly string[] | null | undefined, filterOnChannels: LiveCaps['categoryFilterOnChannels']): ChannelRow[] {
  if (!cat || filterOnChannels !== true || !set) return rows.slice();
  const s = set instanceof Set ? set : new Set(set as readonly string[]);
  return rows.filter((r) => s.has(r.id));
}

// Probe 1: a set as large as the whole lineup (> 20 channels) means the server ignored the flag.
export function categoryRowsProbe(setSize: number, channelCount: number): boolean {
  return !(setSize === channelCount && channelCount > 20);
}

const CATEGORY_MASK = 32 | 64 | 128 | 256; // Movie, Sports, News, Kids

// Probe 2 (after the first 3 tiles): 'flags' when the programmes carry category flags (or the
// lineup is small); 'probe' when an onNow page with Fields=Genres must decide.
export function categorySourceFromTiles(programs: readonly Pick<ProgramLite, 'flags'>[], channelCount: number): 'flags' | 'probe' {
  if (programs.some((p) => (p.flags & CATEGORY_MASK) !== 0)) return 'flags';
  return channelCount > 20 ? 'probe' : 'flags';
}

// The genre probe's verdict: 'genres' when any genre maps through the keyword table, else 'unknown'
// (the category chips are hidden).
export function categorySourceFromGenres(genreLists: readonly (readonly string[])[]): 'genres' | 'unknown' {
  return genreLists.some((g) => genreFlags(g) !== 0) ? 'genres' : 'unknown';
}

// ---- Genre keyword table (server data, never translated; matched on nameKey tokens) ----
// A plain entry matches a contiguous run of whole tokens ("info" never matches "informatique");
// a quoted entry (ETSI EN 300 468 content names, as XMLTV grabbers emit them) matches the whole genre.

export interface GenreRule {
  bit: number;
  words: readonly string[];
  exact: readonly string[];
}

export const GENRE_TABLE: readonly GenreRule[] = [
  // Sport → PF.Sports
  { bit: 64, words: ['sport', 'sports', 'football', 'soccer', 'rugby', 'tennis', 'basket', 'cyclisme', 'f1', 'motorsport', 'deportes', 'fussball', 'calcio'], exact: ['sports'] },
  // Films → PF.Movie
  { bit: 32, words: ['film', 'films', 'movie', 'movies', 'cinéma', 'téléfilm', 'téléfilms', 'spielfilm', 'cine', 'pelicula', 'película'], exact: ['movie / drama'] }, // i18n-ignore: server data
  // Infos → PF.News
  { bit: 128, words: ['info', 'infos', 'news', 'journal', 'actualité', 'actualités', 'nachrichten', 'noticias', 'notiziario'], exact: ['news / current affairs'] }, // i18n-ignore: server data
  // Jeunesse → PF.Kids
  { bit: 256, words: ['jeunesse', 'enfants', 'kids', 'children', 'animation', 'dessin animé', 'dessins animés', 'kinder', 'infantil'], exact: ["children's / youth programmes"] }, // i18n-ignore: server data
  // Séries → PF.Series
  { bit: 512, words: ['série', 'séries', 'series', 'feuilleton', 'sitcom', 'serie'], exact: ['tv series'] }, // i18n-ignore: server data
];

// Token separators: whitespace and controls, ASCII punctuation, NBSP, typographic quotes and dashes.
function isSeparator(c: number): boolean {
  return c <= 0x20 || (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e) || c === 0xa0 || c === 0x2018 || c === 0x2019 || c === 0x2013 || c === 0x2014;
}

export function genreTokens(s: string): string[] {
  const k = nameKey(s);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (isSeparator(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += k[i];
  }
  if (cur) out.push(cur);
  return out;
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length && ok; j++) ok = hay[i + j] === needle[j];
    if (ok) return true;
  }
  return false;
}

const sameTokens = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

// PF bits for a programme's Genres through the keyword table.
export function genreFlags(genres: readonly string[]): number {
  let f = 0;
  for (const g of genres) {
    const toks = genreTokens(g);
    if (!toks.length) continue;
    for (const rule of GENRE_TABLE) {
      if (f & rule.bit) continue;
      if (rule.exact.some((e) => sameTokens(toks, genreTokens(e))) || rule.words.some((w) => containsRun(toks, genreTokens(w)))) f |= rule.bit;
    }
  }
  return f;
}

// ---- Channel search (§6.8): name (folded, substring), number prefix, Emby tag; at most 8 ----

export function searchChannels(rows: readonly ChannelRow[], query: string, limit = 8): ChannelRow[] {
  const q = nameKey(query);
  if (!q) return [];
  const numQ = /^\d+(?:[.\-_ ]\d*)?$/.test(q) ? q.replace(/[\-_ ]/, '.') : null;
  const scored: { r: ChannelRow; score: number }[] = [];
  for (const r of rows) {
    let score = -1;
    const num = r.number.trim().replace(/\s*[\-_ ]\s*/, '.');
    if (numQ !== null && num === numQ) score = 0;
    else if (numQ !== null && num.startsWith(numQ)) score = 1;
    else {
      const name = nameKey(r.name);
      if (name.startsWith(q)) score = 2;
      else if (name.includes(q)) score = 3;
      else if (r.tags.some((t) => nameKey(t).includes(q))) score = 4;
    }
    if (score >= 0) scored.push({ r, score });
  }
  scored.sort((a, b) => a.score - b.score || compareByNumber(a.r, b.r));
  return scored.slice(0, limit).map((x) => x.r);
}
