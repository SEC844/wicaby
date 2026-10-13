import type { EventEmitter } from 'node:events';
import type { BaseWindow } from 'electron';
import type { PlaybackStats, VideoAspect } from '../../shared/contract';
import type { HdrFormat } from './hdr';

// Exit transition timings, matched by the CSS in OsdWindow.svelte and Player.svelte.
export const EXIT_FADE_MS = 220;
export const EXIT_REVEAL_MS = 200;

export interface ExternalSubtitle {
  index: number;
  url: string;
  label: string;
  language?: string;
}

export interface LoadParams {
  // mpv: absolute http(s) URL or local file path. html: wicaby-media:// URL.
  url: string;
  isHls: boolean;
  httpHeaders: string[];
  startMs: number;
  title: string;
  volume: number;
  muted: boolean;
  audioIndex: number | null;
  subtitleIndex: number | null;
  // Server stream indexes of embedded tracks, used to map onto player track ids.
  embeddedAudio: number[];
  embeddedSubtitles: number[];
  externalSubtitles: ExternalSubtitle[];
  // True when the server already muxed the selected tracks (transcode).
  tracksFixed: boolean;
  // HDR format announced by the server, null when it does not say.
  hdr: HdrFormat | null;
  // Starting playback speed ("Vitesse par défaut").
  rate?: number;
  // A music track (music/music-playback.ts): no window, its loudness, and whether it starts paused (D8).
  music?: MusicLoad;
}

export interface MusicLoad {
  // mpv --replaygain for this file (its ReplayGain tags).
  replayGain: 'no' | 'track' | 'album';
  // dB for a file without tags (mpv --replaygain-fallback): the server's gain or the fallback, preamp included.
  untaggedDb: number;
  untagged: 'server' | 'none';
  preampDb: number;
  // The built-in <audio> reads no tags: the server's gain and the preamp only.
  htmlGainDb: number;
  paused: boolean;
}

export interface TimeUpdate {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  buffering: boolean;
  // mpv only: demuxer-cache-state (live timeshift, §8.8). Ranges in ms of player time.
  cache?: { ranges: [number, number][]; fileBytes: number; fwBytes: number };
}

// Events: 'time' (TimeUpdate), 'volume' ({volume, muted}), 'stats' (PlaybackStats),
// 'ended', 'failure' (message), 'closed' (window closed by the user).
export interface ActivePlayer extends EventEmitter {
  readonly kind: 'mpv' | 'html';
  readonly hostWindow: BaseWindow | null;
  load(params: LoadParams): Promise<void>;
  play(): void;
  pause(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setRate(rate: number): void;
  // Returns false when the player cannot switch on its own and the stream must be restarted.
  setAudio(index: number): Promise<boolean>;
  setSubtitle(index: number | null): Promise<boolean>;
  setFullscreen(value: boolean): void;
  isFullscreen(): boolean;
  // mpv only; the <video> page reads the format from the playback state.
  setAspect(aspect: VideoAspect): void;
  // Exit transition, before destroy(): the page the player was opened from is shown and painted under the
  // player, which fades away over it (instantly when reduced). `phase` publishes PlaybackState.exiting.
  leave(reduced: boolean, phase: (p: 'out' | 'reveal') => void): Promise<void>;
  destroy(): Promise<void>;
}

export type { PlaybackStats };
