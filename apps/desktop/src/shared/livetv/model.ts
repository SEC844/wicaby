// Live TV shared model (spec §4.3, §4.4, §21.4): types, PF flag bits, capabilities, and the
// normalisation of Emby / Jellyfin DTOs into lean rows. Erasable TypeScript only (no enum,
// no namespace, no parameter properties); C/livetv/Model.kt mirrors it field for field.
// Golden vectors: tools/checks/fixtures/livetv/normalize.json.
import { parseChannelNumber } from './channel-order';
import { genreFlags } from './lens';

// 'files' never has Live TV (server-caps.ts) but flows through the same API types; 'plex' Live TV is PX-11
// (plex-spec §7): until then its /LiveTv probe answers PLEX-UNMAPPED and the section stays hidden.
export type ServerKind = 'emby' | 'jellyfin' | 'files' | 'plex';

export const PF = { Live: 1, New: 2, Premiere: 4, Repeat: 8, HD: 16, Movie: 32, Sports: 64, News: 128, Kids: 256, Series: 512 } as const;
export type PfName = keyof typeof PF;

export type NumKey = [number, number];

export interface ChannelRow {
  id: string;
  serverId: string;
  number: string; // as sent ('' when absent)
  numKey: NumKey | null; // '5.1' → [5,1], '105' → [105,-1], '' → null
  name: string;
  logoTag?: string;
  favorite: boolean;
  tags: string[];
  radio: boolean;
  serverIndex: number; // position in the server answer (server order)
  lastPlayed?: number; // UserData.LastPlayedDate, seeds Récentes
}

export interface ProgramLite {
  id: string;
  channelId: string;
  start: number; // epoch ms
  end: number;
  title: string;
  episodeTitle?: string;
  season?: number;
  episode?: number;
  flags: number; // PF bits
  rating?: string;
  seriesId?: string;
  timerId?: string; // payload values, used only before the overlay loads
  seriesTimerId?: string;
  imageTag?: string; // only when the fetch asked for images
}

export type LensRef = { kind: 'all' } | { kind: 'favorites' } | { kind: 'recents' } | { kind: 'radio' } | { kind: 'tag'; tag: string } | { kind: 'group'; id: string };
export type Category = 'movies' | 'sports' | 'news' | 'kids' | 'series' | 'new';
export const CATEGORIES: readonly Category[] = ['movies', 'sports', 'news', 'kids', 'series', 'new'];

export type TimerStatus = 'scheduled' | 'recording' | 'conflict-ok' | 'conflict-wont' | 'error';
export interface TimerLite {
  id: string;
  programId?: string;
  channelId?: string;
  seriesTimerId?: string;
  start: number;
  end: number;
  name: string;
  status: TimerStatus;
  prePaddingS: number;
  postPaddingS: number;
}

export interface LiveCaps {
  kind: ServerKind;
  canRecord: boolean; // Policy.EnableLiveTvManagement, downgraded on 403
  channelTags: boolean; // Emby /LiveTv/ChannelTags answered 200
  categorySource: 'flags' | 'genres' | 'unknown'; // §6.6
  categoryFilterOnChannels: boolean | 'unknown'; // §6.6
  programSearch: 'server' | 'items' | 'memory';
  recordingOptions: 'emby' | 'jellyfin';
  tunerCount?: number; // Services[].Tuners.length; hidden when 0
  onNowSource: 'recommended' | 'window'; // §5.1 V15 probe
  newFlag: boolean; // false on Jellyfin (no IsNew in BaseItemDto)
  hdFlag: boolean | 'unknown'; // §4.4 V16 probe
  killEncodes: boolean; // false after one 404/405 (Jellyfin 12.2)
  clockSkewMs: number; // §21.4, 0 unless |skew| > 2 min
}

export type DeviceClass = 'desktop' | 'tv-low' | 'tv' | 'mobile-low' | 'mobile'; // §21.3
export const DEVICE_CLASSES: readonly DeviceClass[] = ['desktop', 'tv-low', 'tv', 'mobile-low', 'mobile'];

export interface PlatformTuning {
  channelPage: number;
  channelPagesInFlight: number;
  tileChannels: number;
  tileMaxSlabs: number;
  concurrency: number;
  rowOverscan: number;
  timeOverscanMin: number;
  maxCells: number;
  lruPrograms: number;
  // §2.2 / §21.3 rows that the planner and the caches also read.
  persistMb: number; // persistent programme cache cap
  idleFavoritesOnly: boolean; // P3 idle prefetch: favourites only, or favourites then the first rows
  idleMax: number; // P3 idle prefetch: at most this many channels
  artDelayMs: number; // detail band art waits for this much stable focus (0 = no delay)
}

// What the player gets for its zap list (also declared in contract.ts by D-5).
export interface ZapEntry {
  id: string;
  number: string;
  name: string;
  logoTag?: string;
}

export function zapEntry(r: ChannelRow): ZapEntry {
  return r.logoTag ? { id: r.id, number: r.number, name: r.name, logoTag: r.logoTag } : { id: r.id, number: r.number, name: r.name };
}

// Capabilities before any probe ran.
export function defaultCaps(kind: ServerKind): LiveCaps {
  return {
    kind,
    canRecord: true,
    channelTags: false,
    categorySource: 'unknown',
    categoryFilterOnChannels: 'unknown',
    programSearch: kind === 'emby' ? 'server' : 'items',
    recordingOptions: kind === 'emby' ? 'emby' : 'jellyfin',
    onNowSource: 'recommended',
    newFlag: kind === 'emby',
    hdFlag: kind === 'jellyfin' ? true : 'unknown',
    killEncodes: true,
    clockSkewMs: 0,
  };
}

// ---- Dates ----

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

// Server dates: ISO 8601 with up to 7 fractional digits (.NET); no zone means UTC. Invalid → NaN.
export function parseServerDate(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = DATE_RE.exec(s.trim());
  if (!m) return NaN;
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0, ms);
  const z = m[8];
  if (z && z.toUpperCase() !== 'Z') {
    const sign = z[0] === '-' ? -1 : 1;
    const digits = z.slice(1).replace(':', '');
    const off = Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2, 4)) : 0);
    t -= sign * off * 60_000;
  }
  return t;
}

// ---- DTO normalisation (§4.4) ----

type Dto = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const obj = (v: unknown): Dto | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dto) : undefined);

const FLAG_FIELDS: readonly [string, number][] = [
  ['IsLive', PF.Live],
  ['IsNew', PF.New],
  ['IsPremiere', PF.Premiere],
  ['IsRepeat', PF.Repeat],
  ['IsHD', PF.HD],
  ['IsMovie', PF.Movie],
  ['IsSports', PF.Sports],
  ['IsNews', PF.News],
  ['IsKids', PF.Kids],
  ['IsSeries', PF.Series],
];

// Flags straight from the DTO. Missing means false; "New" is never inferred.
export function flagsOf(dto: Dto, kind?: ServerKind): number {
  let f = 0;
  for (const [field, bit] of FLAG_FIELDS) if (dto[field] === true) f |= bit;
  if (kind === 'jellyfin') f &= ~PF.New; // Jellyfin BaseItemDto has no IsNew
  return f;
}

export function normalizeChannel(dto: Dto, serverId: string, serverIndex: number): ChannelRow | null {
  const id = str(dto.Id);
  if (!id) return null;
  const rawNumber = dto.ChannelNumber ?? dto.Number;
  const number = typeof rawNumber === 'string' ? rawNumber : typeof rawNumber === 'number' ? String(rawNumber) : '';
  const ud = obj(dto.UserData);
  const images = obj(dto.ImageTags);
  const tags = Array.isArray(dto.Tags) ? dto.Tags.filter((t): t is string => typeof t === 'string' && t !== '') : [];
  const type = str(dto.ChannelType) ?? str(dto.Type);
  const row: ChannelRow = {
    id,
    serverId,
    number,
    numKey: parseChannelNumber(number),
    name: typeof dto.Name === 'string' ? dto.Name : '',
    favorite: ud?.IsFavorite === true,
    tags,
    radio: type === 'Radio',
    serverIndex,
  };
  const logo = str(images?.Primary);
  if (logo) row.logoTag = logo;
  const played = parseServerDate(ud?.LastPlayedDate);
  if (Number.isFinite(played)) row.lastPlayed = played;
  return row;
}

export interface NormalizeOpts {
  kind?: ServerKind;
  categorySource?: LiveCaps['categorySource'];
}

// null when the DTO lacks an id, a channel or valid dates.
export function normalizeProgram(dto: Dto, opts: NormalizeOpts = {}): ProgramLite | null {
  const id = str(dto.Id);
  const channelId = str(dto.ChannelId);
  const start = parseServerDate(dto.StartDate);
  const end = parseServerDate(dto.EndDate);
  if (!id || !channelId || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  let flags = flagsOf(dto, opts.kind);
  if (opts.categorySource === 'genres' && Array.isArray(dto.Genres)) {
    flags |= genreFlags(dto.Genres.filter((g): g is string => typeof g === 'string'));
  }
  const p: ProgramLite = { id, channelId, start, end, title: typeof dto.Name === 'string' ? dto.Name : '', flags };
  const episodeTitle = str(dto.EpisodeTitle);
  if (episodeTitle) p.episodeTitle = episodeTitle;
  const season = int(dto.ParentIndexNumber);
  if (season !== undefined) p.season = season;
  const episode = int(dto.IndexNumber);
  if (episode !== undefined) p.episode = episode;
  const rating = str(dto.OfficialRating);
  if (rating) p.rating = rating;
  const seriesId = str(dto.SeriesId);
  if (seriesId) p.seriesId = seriesId;
  const timerId = str(dto.TimerId);
  if (timerId) p.timerId = timerId;
  const seriesTimerId = str(dto.SeriesTimerId);
  if (seriesTimerId) p.seriesTimerId = seriesTimerId;
  const imageTag = str(obj(dto.ImageTags)?.Primary);
  if (imageTag) p.imageTag = imageTag;
  return p;
}

// ---- Probes on raw answers (§4.4 V16, §5.1 V15) ----

// V16: false when none of the programmes of the first tiles carries an IsHD key at all.
export function hdProbe(rawPrograms: readonly Dto[]): boolean {
  return rawPrograms.some((p) => Object.prototype.hasOwnProperty.call(p, 'IsHD'));
}

// V15: the server ignored IsAiring when an item is not airing at `now`.
export function onNowProbe(rawItems: readonly Dto[], now: number): 'recommended' | 'window' {
  for (const it of rawItems) {
    const s = parseServerDate(it.StartDate);
    const e = parseServerDate(it.EndDate);
    if (s > now || e <= now) return 'window';
  }
  return 'recommended';
}

// ---- Clock skew (§21.4) ----

export interface SkewState {
  streak: number; // answers in a row with |skew| > threshold
  skewMs: number; // current caps.clockSkewMs
}
export const SKEW_THRESHOLD_MS = 120_000;
export const SKEW_STREAK = 3;

// Feed one answer's Date header (ms) with the client time it arrived at.
export function nextSkew(state: SkewState, serverMs: number, clientMs: number): SkewState {
  if (!Number.isFinite(serverMs)) return state;
  const skew = serverMs - clientMs;
  if (Math.abs(skew) <= SKEW_THRESHOLD_MS) return { streak: 0, skewMs: 0 };
  const streak = state.streak + 1;
  return { streak, skewMs: streak >= SKEW_STREAK ? skew : state.skewMs };
}
