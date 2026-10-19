// What a title is made of, for the details page (Android tv ui/Detail.kt badges, core Trailers.kt, Comics.kt,
// Segments.kt resumeFrom).
import type { BaseItem, MediaSource, MediaStream } from '$shared/models';
import { comicPageFromTicks } from '$shared/contract';
import { hdrChip, hdrFromStream } from '$shared/hdr';
import { plural, t } from './i18n.svelte';
import { TICKS_PER_MS } from './format';

// The selected version's streams; "N versions" when there is a choice.
export function badges(item: BaseItem, source: MediaSource | undefined): string[] {
  const n = item.MediaSources?.length ?? 0;
  return [...(n > 1 ? [plural('versions_count', n, n)] : []), ...streamBadges(source?.MediaStreams ?? [])];
}

function streamBadges(streams: MediaStream[]): string[] {
  const video = streams.find((s) => s.Type === 'Video');
  const audio = streams.find((s) => s.Type === 'Audio' && s.IsDefault) ?? streams.find((s) => s.Type === 'Audio');
  const w = video?.Width;
  const c = audio?.Channels;
  const dv = hdrFromStream(video)?.dvProfile;
  const codec = audio?.Codec?.toLowerCase();
  return [
    w ? (w >= 3800 ? '4K' : w >= 1900 ? 'HD 1080p' : w >= 1260 ? 'HD 720p' : 'SD') : undefined,
    // "Dolby Vision · HDR10", "HDR10+", "HLG"… (none for SDR), then the DV profile.
    hdrChip(video) ?? undefined,
    dv ? t('dv_profile', dv) : undefined,
    video?.Codec?.toUpperCase(),
    c ? (c >= 8 ? '7.1' : c >= 6 ? '5.1' : c === 2 ? t('badge_stereo') : undefined) : undefined,
    codec === 'truehd' ? 'Dolby TrueHD' : codec === 'eac3' ? 'Dolby Digital+' : codec === 'ac3' ? 'Dolby Digital' : codec === 'dts' || codec === 'dca' ? 'DTS' : undefined,
    streams.some((s) => s.Type === 'Subtitle') ? t('badge_subtitles') : undefined,
  ].filter((b): b is string => !!b);
}

// Outside 5–90 % a resume point is noise (Emby libraries can change the server's own rule).
export function resumeMs(item: BaseItem): number {
  const pos = (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_MS;
  const dur = (item.RunTimeTicks ?? 0) / TICKS_PER_MS;
  if (dur <= 0 || pos <= 0) return Math.max(0, pos);
  const f = pos / dur;
  return f >= 0.05 && f <= 0.9 ? pos : 0;
}

// Books open the comic reader; the saved page replaces the resume time (core Comics.kt).
export const isBook = (item: BaseItem): boolean => item.Type === 'Book' || item.MediaType === 'Book';

// The 0-based page to resume from, or null when the book is unread or finished.
export function resumePage(item: BaseItem): number | null {
  const ud = item.UserData;
  if (!ud || ud.Played) return null;
  const page = comicPageFromTicks(ud.PlaybackPositionTicks);
  return page > 0 ? page : null;
}

// ---- Trailers (core Trailers.kt): local files play in Wicaby's player; remote ones are links.

export function hasTrailer(item: BaseItem): boolean {
  return (item.LocalTrailerCount ?? 0) > 0 || remoteTrailer(item) !== undefined;
}

const YOUTUBE = /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i;

// The first remote trailer, YouTube first, as an https URL.
export function remoteTrailer(item: BaseItem): string | undefined {
  const urls = (item.RemoteTrailers ?? []).map((r) => normalize(r.Url ?? '')).filter((u): u is string => !!u);
  return urls.find((u) => YOUTUBE.test(u)) ?? urls[0];
}

// NFO files often carry Kodi's plugin://plugin.video.youtube/?...videoid=ID form.
function normalize(raw: string): string | undefined {
  const url = raw.trim();
  if (!url) return undefined;
  const m = /plugin\.video\.youtube.*[?&](?:videoid|video_id)=([\w-]+)/i.exec(url);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return /^https?:\/\//i.test(url) ? url : undefined;
}
