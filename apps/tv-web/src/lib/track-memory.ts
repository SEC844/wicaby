// X-05: the audio and subtitle picked by hand during an episode, replayed on the rest of the series (core
// TrackMemory.kt), with the desktop's pure rules and JSON (shared/track-selection.ts): nothing matching, the server
// default. And the accessibility preferences (Settings > Audio and Subtitles) applied to the server's defaults,
// which know nothing of them: an audio-description track gives way to its plain twin (or the reverse), a subtitle
// to its SDH twin.
import type { MediaStream } from '$shared/models';
import { accessible, isAd, isSdh, matchIntent, migrateChoice, rememberChoice, type TrackMemoryDoc } from '$shared/track-selection';
import { t } from './i18n.svelte';
import { settings } from './settings.svelte';
import { load, save } from './storage';

const KEY = 'track_memory';

export const a11y = () => ({ sdh: settings.preferSdh.value, audioDescription: settings.audioDescription.value });

// The server default swapped for its accessible twin; the index itself when it fits or has none.
export const accessibleIndex = (streams: MediaStream[], index: number): number => accessible(streams, index, a11y());

// What the memory picks for this series: an audio index, a subtitle index (-1 = off); undefined where nothing matches.
export function memoryPick(seriesId: string, streams: MediaStream[]): { audio?: number; subtitle?: number } {
  const choice = migrateChoice(load<TrackMemoryDoc>(KEY, {})[seriesId]);
  if (!choice) return {};
  return {
    audio: choice.audio ? matchIntent(streams, 'Audio', choice.audio) : undefined,
    subtitle: choice.subtitle === null ? -1 : choice.subtitle ? matchIntent(streams, 'Subtitle', choice.subtitle) : undefined,
  };
}

// A manual pick: it becomes the series default. stream null = subtitles off; untagged audio is not remembered.
export function recordTrack(seriesId: string, kind: 'audio' | 'subtitle', stream: MediaStream | null, streams: MediaStream[]): void {
  save(KEY, rememberChoice(load<TrackMemoryDoc>(KEY, {}), seriesId, kind, stream, Date.now(), streams));
}

// The picker badge: "SDH" on a subtitle, "AD" on an audio track (one string in every language).
export function trackBadge(s: MediaStream): string | undefined {
  if (s.Type === 'Subtitle' && isSdh(s)) return 'SDH';
  if (s.Type === 'Audio' && isAd(s)) return 'AD';
  return undefined;
}

// A track's name in the pickers, with its accessibility badge (Detail.kt, PlayerActivity.kt trackName).
export function trackName(s: MediaStream): string {
  return [s.DisplayTitle || s.Title || s.Language || t('track_unknown', s.Index), trackBadge(s)].filter(Boolean).join(' · ');
}
