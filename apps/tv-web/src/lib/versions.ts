// An item with several MediaSources ("versions"): 4K and 1080p, VF and VOST, a director's cut (Android core
// Versions.kt). Labels for the details page's Version picker, the choice remembered per item (across launches), and
// the audio/subtitle picks made on the details page (per item and version, this session only). Playback reads
// both, so the player, PlaybackInfo and the play session follow the choice.
import type { BaseItem, MediaSource, MediaStream } from '$shared/models';
import { hdrFromStream, type HdrKind } from '$shared/hdr';
import { versionSignature } from '$shared/quality-presets';
import { load, save } from './storage';
import { accessibleIndex } from './track-memory';

// ---- Labels

// One label per source, same order: its name when it has a meaningful one, else what tells it apart ("4K HDR · HEVC ·
// Atmos", plus the audio languages when those differ).
export function labels(item: BaseItem): string[] {
  const sources = item.MediaSources ?? [];
  const names = sources.map((s) => cleanName(item.Name, s));
  const quality = sources.map(qualityOf);
  const langs = sources.map(languages);
  const showLangs = new Set(langs).size > 1;
  const base = sources.map((_, i) => names[i] ?? [quality[i], showLangs ? langs[i] : ''].filter(Boolean).join(' · '));
  // Two names that read the same get their quality; anything still equal gets a number.
  const withQuality = base.map((l, i) => (names[i] !== undefined && base.filter((b) => b === l).length > 1 && quality[i] ? `${l} · ${quality[i]}` : l));
  return withQuality.map((l, i) => (!l ? `${i + 1}` : withQuality.filter((w) => w === l).length > 1 ? `${l} (${i + 1})` : l));
}

const video = (s: MediaSource): MediaStream | undefined => s.MediaStreams?.find((m) => m.Type === 'Video');

// "4K HDR · HEVC · Atmos": resolution and dynamic range, video codec, the default audio's best feature.
function qualityOf(s: MediaSource): string {
  const v = video(s);
  const a = defaultAudioStream(s);
  const picture = [v ? resolution(v.Width ?? 0, v.Height ?? 0) : undefined, v ? dynamicRange(v) : undefined].filter(Boolean).join(' ');
  return [picture || undefined, v?.Codec ? videoCodec(v.Codec) : undefined, a ? audioFeature(a) : undefined].filter(Boolean).join(' · ');
}

export function resolution(width: number, height: number): string | undefined {
  if (width >= 3200 || height >= 1800) return '4K';
  if (width >= 1700 || height >= 900) return '1080p';
  if (width >= 1200 || height >= 650) return '720p';
  if (width > 0 || height > 0) return 'SD';
  return undefined;
}

// The details page range chip's short form ("Dolby Vision", "HDR10"…).
const RANGE: Record<Exclude<HdrKind, 'sdr'>, string> = { dv: 'Dolby Vision', 'hdr10+': 'HDR10+', hdr10: 'HDR10', hlg: 'HLG' };
function dynamicRange(v: MediaStream): string | undefined {
  const kind = hdrFromStream(v)?.kind;
  return kind && kind !== 'sdr' ? RANGE[kind] : undefined;
}

function videoCodec(c: string): string {
  const k = c.toLowerCase();
  return ({ hevc: 'HEVC', h265: 'HEVC', h264: 'H.264', avc: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1' } as Record<string, string>)[k] ?? c.toUpperCase();
}

function audioFeature(a: MediaStream): string | undefined {
  // Profile ("TrueHD + Atmos") is sent by both servers, though the shared model leaves it out.
  const text = [(a as MediaStream & { Profile?: string }).Profile, a.DisplayTitle, a.Title].filter(Boolean).join(' ');
  const codec = a.Codec?.toLowerCase();
  if (/atmos/i.test(text)) return 'Atmos';
  if (/DTS[:-]X/i.test(text)) return 'DTS:X';
  if (codec === 'truehd') return 'TrueHD';
  if ((codec === 'dts' || codec === 'dca') && text.includes('MA')) return 'DTS-HD MA';
  if (codec === 'dts' || codec === 'dca') return 'DTS';
  if ((a.Channels ?? 0) >= 8) return '7.1';
  if ((a.Channels ?? 0) >= 6) return '5.1';
  return undefined;
}

// ISO 639-2 to 639-1 for the audio languages line. Old TV engines have no Intl.DisplayNames: the bibliographic codes
// (Android's table) and the terminology codes servers use most; anything else stays as the server wrote it.
const ISO2: Record<string, string> = {
  fre: 'fr', ger: 'de', dut: 'nl', chi: 'zh', cze: 'cs', gre: 'el', per: 'fa', rum: 'ro', slo: 'sk', alb: 'sq', arm: 'hy',
  baq: 'eu', bur: 'my', geo: 'ka', ice: 'is', mac: 'mk', mao: 'mi', may: 'ms', tib: 'bo', wel: 'cy',
  eng: 'en', fra: 'fr', deu: 'de', spa: 'es', ita: 'it', jpn: 'ja', kor: 'ko', por: 'pt', rus: 'ru', zho: 'zh', ara: 'ar',
  hin: 'hi', nld: 'nl', swe: 'sv', nor: 'no', nob: 'nb', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ces: 'cs', ell: 'el',
  heb: 'he', hun: 'hu', ron: 'ro', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', msa: 'ms', cat: 'ca', hrv: 'hr', srp: 'sr',
  slk: 'sk', slv: 'sl', bul: 'bg', est: 'et', lav: 'lv', lit: 'lt', fas: 'fa', isl: 'is', tam: 'ta', tel: 'te',
};

function iso2(lang: string): string | undefined {
  const l = lang.toLowerCase().split('-')[0];
  if (!l || l === 'und' || l === 'mis' || l === 'zxx') return undefined;
  return l.length === 2 ? l : (ISO2[l] ?? l);
}

// "FR/EN": the audio languages, as two-letter codes.
export function languages(s: MediaSource): string {
  const out: string[] = [];
  for (const m of s.MediaStreams ?? []) {
    const code = m.Type === 'Audio' && m.Language ? iso2(m.Language) : undefined;
    if (code && !out.includes(code)) out.push(code);
  }
  return out.map((c) => c.toUpperCase()).join('/');
}

// A source name worth showing: not empty, not just the title (and year), no file extension.
function cleanName(title: string, s: MediaSource): string | undefined {
  let n = (s.Name ?? '').trim();
  if (!n) return undefined;
  n = n.replace(/\.(mkv|mp4|m4v|avi|ts|m2ts|mov|webm|iso)$/i, '');
  if (title.trim() && n.toLowerCase().startsWith(title.toLowerCase())) n = n.slice(title.length);
  n = n.replace(/^\s+/, '').replace(/^\(\d{4}\)/, '');
  n = n.replace(/^[\s\-–—_.:|·]+|[\s\-–—_.:|·]+$/g, '');
  return n || undefined;
}

// The server's pick, unless an audio-description track has a plain twin (or the reverse, per Settings).
export function defaultAudioStream(s: MediaSource): MediaStream | undefined {
  const audio = (s.MediaStreams ?? []).filter((m) => m.Type === 'Audio');
  const d = audio.find((m) => m.Index === s.DefaultAudioStreamIndex) ?? audio.find((m) => m.IsDefault) ?? audio[0];
  if (!d) return undefined;
  const i = accessibleIndex(s.MediaStreams ?? [], d.Index);
  return audio.find((m) => m.Index === i);
}

// -1 = off. The server's pick already applies the user's language, subtitle mode and forced rules, and it is what
// PlaybackInfo plays; only "Prefer SDH subtitles" swaps it for its SDH twin (desktop track-selection.ts).
export function defaultSubtitleIndex(s: MediaSource): number {
  const d = s.DefaultSubtitleStreamIndex;
  return d != null && (s.MediaStreams ?? []).some((m) => m.Type === 'Subtitle' && m.Index === d) ? accessibleIndex(s.MediaStreams ?? [], d) : -1;
}

// ---- The choice, remembered per item; the version picked in the player, per series (X-02, written by the player)

function hdrKind(v: MediaStream | undefined): HdrKind {
  return hdrFromStream(v)?.kind ?? 'sdr';
}

export function signature(s: MediaSource): string {
  const v = video(s);
  return versionSignature(v, hdrKind(v));
}

// The version picked for this item, else the one picked in the player for its series, else the server's default.
export function selected(item: BaseItem): MediaSource | undefined {
  const list = item.MediaSources ?? [];
  if (list.length <= 1) return list[0];
  const id = load<Record<string, string>>('versions', {})[item.Id];
  const sig = item.SeriesId ? load<Record<string, string>>('series_versions', {})[item.SeriesId]?.split('|')[0] : undefined;
  return list.find((s) => s.Id === id) ?? (sig ? list.find((s) => signature(s) === sig) : undefined) ?? list[0];
}

export function select(itemId: string, sourceId: string): void {
  save('versions', { ...load<Record<string, string>>('versions', {}), [itemId]: sourceId });
}

// Audio / subtitle picked on the details page, handed to the next PlaybackInfo.
export interface TrackPick {
  audio?: number;
  subtitle?: number;
}

const picks = new Map<string, TrackPick>();

export function pick(itemId: string, sourceId: string | undefined): TrackPick | undefined {
  return picks.get(`${itemId}|${sourceId}`);
}

export function setPick(itemId: string, sourceId: string | undefined, p: TrackPick): void {
  picks.set(`${itemId}|${sourceId}`, p);
}
