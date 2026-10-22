import type { AudioDescriptionPref, SubtitleMode } from './contract';
import type { MediaStream } from './models';

// The one place that picks the audio and subtitle tracks of every start: first play,
// next episode, remote Play, restart. Pure, so tools/checks/track-check.mjs can run it.

const LANG_ALIASES: Record<string, string> = {
  fr: 'fre', fra: 'fre', en: 'eng', de: 'ger', deu: 'ger', es: 'spa', it: 'ita', ja: 'jpn', jp: 'jpn',
  pt: 'por', nl: 'dut', nld: 'dut', zh: 'chi', zho: 'chi', ko: 'kor', ru: 'rus', pl: 'pol', sv: 'swe',
  da: 'dan', no: 'nor', nb: 'nor', nob: 'nor', fi: 'fin', ar: 'ara', cs: 'cze', ces: 'cze', el: 'gre',
  ell: 'gre', he: 'heb', hu: 'hun', tr: 'tur',
};
const UNKNOWN = new Set(['', 'und', 'unk', 'mis', 'mul', 'zxx']);

export function normLang(lang?: string): string {
  const v = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
  const n = LANG_ALIASES[v] ?? v;
  return UNKNOWN.has(n) ? '' : n;
}

// Unknown never matches, not even another unknown.
export const sameLang = (a?: string, b?: string): boolean => {
  const x = normLang(a);
  return x !== '' && x === normLang(b);
};

const words = (s: MediaStream) => `${s.Title ?? ''} ${s.DisplayTitle ?? ''}`.toLowerCase();
// Many releases only say "Forced" in the track title.
export const isForced = (s: MediaStream): boolean => Boolean(s.IsForced) || /\bforced\b|\bforcé/.test(words(s));
const isCommentary = (s: MediaStream) => /comment/.test(words(s));
export const isSdh = (s: MediaStream): boolean => Boolean(s.IsHearingImpaired) || /\bsdh\b|\bcc\b|malentendant|hearing/.test(words(s));
// Audio description: Plex visualImpaired, else the title.
export const isAd = (s: MediaStream): boolean => Boolean(s.IsVisualImpaired) || /\bad\b|audio[ -]?description|description audio|\bdvs\b/.test(words(s));

export interface TrackPrefs {
  audioLanguage: string;
  subtitleLanguage: string;
  mode: SubtitleMode;
  // "Toujours afficher les sous-titres forcés"; false leaves forced tracks to a manual pick.
  forced?: boolean;
  // "Préférer les sous-titres SDH".
  sdh?: boolean;
  // Audio description; absent = 'avoid' (an AD track is never auto-picked over a plain one in its language).
  audioDescription?: AudioDescriptionPref;
}

// What the user picked by hand during an episode, replayed on the rest of the series (X-05).
// ordinal: position among the tracks of that type, -1 when unknown (old files, live).
export interface AudioIntent {
  language: string;
  codec?: string;
  channels?: number;
  title?: string;
  // isCommentary of the picked track (Title or DisplayTitle); absent in older entries: the title decides.
  commentary?: boolean;
  forced: false;
  ordinal: number;
}
export interface SubtitleIntent {
  language: string;
  codec?: string;
  title?: string;
  commentary?: boolean;
  forced: boolean;
  sdh: boolean;
  ordinal: number;
}
export interface SeriesChoice {
  audio?: AudioIntent;
  // null: subtitles turned off.
  subtitle?: SubtitleIntent | null;
  at: number;
}
export type TrackMemoryDoc = Record<string, SeriesChoice>;

// Server-side defaults (MediaSource.DefaultAudioStreamIndex / DefaultSubtitleStreamIndex),
// which already follow the user's server preferences.
export interface ServerDefaults {
  audio?: number;
  subtitle?: number;
}

export function pickAudio(streams: MediaStream[], defaults: ServerDefaults, prefs: TrackPrefs, remembered?: SeriesChoice): number | null {
  const audio = streams.filter((s) => s.Type === 'Audio');
  if (audio.length === 0) return null;
  const ad = prefs.audioDescription ?? 'avoid';
  // 0 = the wanted AD class; ties keep the default track first, then file order (sort is stable).
  const rank = (a: MediaStream) => (ad === 'any' || isAd(a) === (ad === 'prefer') ? 0 : 1);
  const byLang = (lang?: string) => {
    const c = audio.filter((a) => sameLang(a.Language, lang));
    const main = c.filter((a) => !isCommentary(a)).sort((x, y) => rank(x) - rank(y) || Number(!!y.IsDefault) - Number(!!x.IsDefault));
    return main[0] ?? c[0];
  };
  const intent = migrateChoice(remembered)?.audio;
  const mem = intent ? matchIntent(streams, 'Audio', intent) : undefined;
  if (mem !== undefined) return mem;
  const hit = byLang(prefs.audioLanguage);
  if (hit) return hit.Index;
  const d = audio.find((a) => a.Index === defaults.audio) ?? audio.find((a) => a.IsDefault) ?? audio.find((a) => !isCommentary(a)) ?? audio[0];
  return accessible(streams, d.Index, prefs);
}

// The track's twin (same type, language, forced and commentary class) that fits the accessibility
// preferences when the track itself does not: the audio-description choice, and SDH when preferred.
// Used on server defaults, which know nothing of them; the track itself when there is no twin.
export function accessible(streams: MediaStream[], index: number, prefs: Pick<TrackPrefs, 'sdh' | 'audioDescription'>): number {
  const s = streams.find((x) => x.Index === index);
  if (!s || (s.Type !== 'Audio' && s.Type !== 'Subtitle')) return index;
  const ad = prefs.audioDescription ?? 'avoid';
  const fits = (x: MediaStream) => (x.Type === 'Audio' ? ad === 'any' || isAd(x) === (ad === 'prefer') : !prefs.sdh || isSdh(x));
  if (fits(s)) return index;
  const twin = streams.find((x) => x.Type === s.Type && fits(x) && sameLang(x.Language, s.Language) && isForced(x) === isForced(s) && isCommentary(x) === isCommentary(s));
  return twin?.Index ?? index;
}

export function pickSubtitle(
  streams: MediaStream[],
  audioIndex: number | null,
  defaults: ServerDefaults,
  prefs: TrackPrefs,
  remembered?: SeriesChoice,
): number | null {
  const subs = streams.filter((s) => s.Type === 'Subtitle');
  if (subs.length === 0) return null;
  // "My language": the subtitle preference, else the audio one.
  const mine = prefs.subtitleLanguage || prefs.audioLanguage;
  const audioLang = streams.find((s) => s.Index === audioIndex && s.Type === 'Audio')?.Language;
  const full = (lang?: string) => {
    const c = subs.filter((s) => !isForced(s) && sameLang(s.Language, lang));
    const want = (s: MediaStream) => isSdh(s) === Boolean(prefs.sdh);
    return c.find((s) => s.IsDefault && want(s)) ?? c.find(want) ?? c[0];
  };
  const forcedIn = (lang?: string) => subs.find((s) => isForced(s) && sameLang(s.Language, lang));
  // Forced tracks translate the foreign passages (signs, alien dialogue) of the audio being played.
  const forced = prefs.forced === false ? undefined : (forcedIn(mine) ?? forcedIn(audioLang));
  const serverDefault = subs.find((s) => s.Index === defaults.subtitle);

  const intent = migrateChoice(remembered)?.subtitle;
  if (intent === null) return null;
  // A track this episode lacks falls back to the mode.
  const mem = intent ? matchIntent(streams, 'Subtitle', intent) : undefined;
  if (mem !== undefined) return mem;

  switch (prefs.mode) {
    case 'manual':
      return forced?.Index ?? null;
    case 'foreign': {
      if (!mine) return serverDefault?.Index ?? null;
      // Unknown audio language counts as "mine": no surprise subtitles on untagged files.
      const foreign = normLang(audioLang) !== '' && !sameLang(audioLang, mine);
      return (foreign ? (full(mine) ?? forced) : forced)?.Index ?? null;
    }
    case 'always':
      return (full(mine) ?? forced ?? serverDefault ?? (mine ? undefined : (subs.find((s) => !isForced(s)) ?? subs[0])))?.Index ?? null;
    default:
      return serverDefault ? accessible(streams, serverDefault.Index, prefs) : null;
  }
}

// explicitAudio / explicitSubtitle come from the request (item page, restart, remote);
// a negative subtitle index means "none". applied: the series memory changed the outcome.
export function selectTracks(
  streams: MediaStream[],
  defaults: ServerDefaults,
  prefs: TrackPrefs,
  remembered?: SeriesChoice,
  explicitAudio?: number,
  explicitSubtitle?: number,
): { audio: number | null; subtitle: number | null; applied: boolean } {
  const run = (mem?: SeriesChoice) => {
    const audio = explicitAudio ?? pickAudio(streams, defaults, prefs, mem);
    const subtitle = explicitSubtitle !== undefined ? (explicitSubtitle >= 0 ? explicitSubtitle : null) : pickSubtitle(streams, audio, defaults, prefs, mem);
    return { audio, subtitle };
  };
  const mem = migrateChoice(remembered);
  const picked = run(mem);
  const plain = mem ? run() : picked;
  return { ...picked, applied: picked.audio !== plain.audio || picked.subtitle !== plain.subtitle };
}

// ---- X-05 matching (the same rules as TrackMemory.kt; fixtures in tools/checks/fixtures/track) ----

// Unicode property escapes need Chromium 64, and the TV web app runs this from 53: there, the letters of the main
// scripts (Latin, Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, Japanese kana, CJK, Hangul) stand in for \p{L}.
const NOT_WORD = (() => {
  try {
    return new RegExp('[^\\p{L}\\p{N}]+', 'gu');
  } catch {
    return /[^0-9a-z\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02af\u0370-\u03ff\u0400-\u052f\u0590-\u05ff\u0600-\u06ff\u0900-\u0dff\u0e00-\u0eff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g;
  }
})();
const normTitle = (t?: string) => (t ?? '').toLowerCase().replace(NOT_WORD, ' ').trim();

// An old language-only entry (migrated): no ordinal, codec or title was recorded.
const isLegacy = (intent: AudioIntent | SubtitleIntent) => intent.ordinal < 0 && !intent.codec;

// Language +10 (+1 exact tag), codec +5, channels +3, title +2 (two untitled tracks are equal too,
// except for a legacy entry), forced class +2, SDH class +2 (subtitles), same ordinal +1.
// A different language scores 0.
export function scoreTrack(s: MediaStream, intent: AudioIntent | SubtitleIntent, ordinal: number): number {
  if (!sameLang(s.Language, intent.language)) return 0;
  let n = 10;
  if ((s.Language ?? '').toLowerCase() === intent.language.toLowerCase()) n += 1;
  if (intent.codec && (s.Codec ?? '').toLowerCase() === intent.codec.toLowerCase()) n += 5;
  if ('channels' in intent && intent.channels && s.Channels === intent.channels) n += 3;
  if (normTitle(s.Title) === normTitle(intent.title) && (normTitle(intent.title) || !isLegacy(intent))) n += 2;
  if (isForced(s) === intent.forced) n += 2;
  if (s.Type === 'Subtitle' && isSdh(s) === Boolean((intent as SubtitleIntent).sdh)) n += 2;
  if (intent.ordinal >= 0 && ordinal === intent.ordinal) n += 1;
  return n;
}

// The best track of that type scoring 10 or more, lowest index on a tie (a legacy entry first prefers
// the default track, as the old language-only pick did). The forced class must match, and a commentary
// never stands in for the main track (or the reverse).
export function matchIntent(streams: MediaStream[], type: 'Audio' | 'Subtitle', intent: AudioIntent | SubtitleIntent): number | undefined {
  const commentary = intent.commentary ?? /comment/.test((intent.title ?? '').toLowerCase());
  const legacy = isLegacy(intent);
  let best: { index: number; score: number } | undefined;
  streams
    .filter((s) => s.Type === type)
    .forEach((s, ordinal) => {
      if (isForced(s) !== intent.forced || isCommentary(s) !== commentary) return;
      const base = scoreTrack(s, intent, ordinal);
      // Fractional, so it only ever breaks a tie.
      const score = base + (legacy && s.IsDefault ? 0.5 : 0);
      if (base >= 10 && (!best || score > best.score || (score === best.score && s.Index < best.index))) best = { index: s.Index, score };
    });
  return best?.index;
}

// Old track-memory.json: audio was a bare language, subtitle { language, forced }.
export function migrateChoice(raw: unknown): SeriesChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && typeof (v as { language?: unknown }).language === 'string';
  const a = c.audio;
  const s = c.subtitle;
  return {
    at: Number(c.at) || 0,
    audio: typeof a === 'string' ? { language: a, forced: false, ordinal: -1 } : obj(a) ? { ordinal: -1, ...(a as object), forced: false } as AudioIntent : undefined,
    subtitle: s === null ? null : obj(s) ? ({ sdh: false, ordinal: -1, ...s, forced: s.forced === true } as SubtitleIntent) : undefined,
  };
}

// Records a manual pick for the series; keeps the 300 most recent series. streams: the item's list,
// for the ordinal (omitted: unknown).
export function rememberChoice(
  doc: TrackMemoryDoc,
  seriesId: string,
  kind: 'audio' | 'subtitle',
  stream: MediaStream | null,
  now = Date.now(),
  streams: MediaStream[] = [],
): TrackMemoryDoc {
  const next: SeriesChoice = { ...migrateChoice(doc[seriesId]), at: now };
  const ordinal = stream ? streams.filter((s) => s.Type === stream.Type).findIndex((s) => s.Index === stream.Index) : -1;
  const base = { language: stream?.Language ?? '', ...(stream?.Codec ? { codec: stream.Codec.toLowerCase() } : {}), ...(stream?.Title ? { title: stream.Title } : {}), commentary: stream ? isCommentary(stream) : false, ordinal };
  if (kind === 'audio') {
    if (!stream || !normLang(stream.Language)) return doc;
    next.audio = { ...base, ...(stream.Channels ? { channels: stream.Channels } : {}), forced: false };
  } else {
    next.subtitle = stream ? { ...base, forced: isForced(stream), sdh: isSdh(stream) } : null;
  }
  const entries = Object.entries({ ...doc, [seriesId]: next }).sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0));
  return Object.fromEntries(entries.slice(0, 300));
}
