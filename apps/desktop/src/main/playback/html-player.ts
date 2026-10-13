import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BaseWindow } from 'electron';
import { Channels, type HtmlPlayerCommand, type HtmlPlayerEvent, type HtmlPlayerLoad } from '../../shared/contract';
import { stripTokenParams } from '../connection/api-client';
import type { WindowManager } from '../windows/window-manager';
import { EXIT_FADE_MS, EXIT_REVEAL_MS, type ActivePlayer, type LoadParams } from './player';

// Adapter for the <video> element that lives in the main window's renderer.
// The playback service drives it exactly like mpv, so reporting, queueing,
// taskbar buttons and remote control share one code path.
export class HtmlPlayer extends EventEmitter implements ActivePlayer {
  readonly kind = 'html' as const;
  private params: LoadParams | null = null;

  constructor(private readonly windows: WindowManager) {
    super();
  }

  get hostWindow(): BaseWindow | null {
    return this.windows.main;
  }

  private send(cmd: HtmlPlayerCommand): void {
    this.windows.send(this.windows.main, Channels.htmlPlayerCommand, cmd);
  }

  handleEvent(ev: HtmlPlayerEvent): void {
    switch (ev.type) {
      case 'time':
        this.emit('time', { positionMs: ev.positionMs, durationMs: ev.durationMs, paused: ev.paused, buffering: ev.buffering });
        break;
      case 'volume':
        this.emit('volume', { volume: ev.volume, muted: ev.muted });
        break;
      case 'stats':
        this.emit('stats', ev.stats);
        break;
      case 'ended':
        this.emit('ended');
        break;
      case 'error':
        this.emit('failure', ev.message, 'stream');
        break;
    }
  }

  async load(params: LoadParams): Promise<void> {
    this.params = params;
    // The renderer never sees a token: wicaby-media:// adds the auth headers in main.
    const load: HtmlPlayerLoad = {
      url: stripTokenParams(params.url),
      isHls: params.isHls,
      startMs: params.startMs,
      volume: params.volume,
      muted: params.muted,
      subtitles: params.externalSubtitles.map((s) => ({ index: s.index, url: stripTokenParams(s.url), label: s.label, language: s.language })),
      subtitleIndex: params.subtitleIndex,
      rate: params.rate,
      // A track plays in an <audio> element of the main window (music-spec §4.1.2), the page stays where it is.
      audio: params.music ? { gainDb: params.music.htmlGainDb, paused: params.music.paused } : undefined,
    };
    if (!params.music) this.windows.focusMain();
    this.windows.send(this.windows.main, Channels.htmlPlayerLoad, load);
  }

  play(): void {
    this.send({ type: 'play' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  seek(positionMs: number): void {
    this.send({ type: 'seek', positionMs });
  }

  setVolume(value: number): void {
    this.send({ type: 'volume', value });
  }

  setMuted(value: boolean): void {
    this.send({ type: 'mute', value });
  }

  setRate(value: number): void {
    this.send({ type: 'rate', value });
  }

  async setAudio(): Promise<boolean> {
    // Chromium exposes no audio track switching; the service restarts the stream.
    return false;
  }

  async setSubtitle(index: number | null): Promise<boolean> {
    if (index === null || index < 0) {
      this.send({ type: 'subtitle', index: null });
      return true;
    }
    if (!this.params?.externalSubtitles.some((s) => s.index === index)) return false;
    this.send({ type: 'subtitle', index });
    return true;
  }

  setAspect(): void {
    // Player.svelte applies state.aspect to the <video> element itself.
  }

  setFullscreen(value: boolean): void {
    this.windows.main?.setFullScreen(value);
  }

  isFullscreen(): boolean {
    return this.windows.main?.isFullScreen() ?? false;
  }

  // Back to the window first, under the paused picture; then Player.svelte fades out over the page kept under it.
  async leave(reduced: boolean, phase: (p: 'out' | 'reveal') => void): Promise<void> {
    // Music never opened the player page: nothing to fade.
    if (this.params?.music) return;
    const main = this.windows.main;
    if (main?.isFullScreen()) {
      const left = new Promise<void>((r) => main.once('leave-full-screen', () => r()));
      main.setFullScreen(false);
      await Promise.race([left, sleep(600)]);
    }
    if (reduced) return;
    phase('out');
    await sleep(EXIT_FADE_MS + EXIT_REVEAL_MS / 2);
  }

  async destroy(): Promise<void> {
    this.send({ type: 'unload' });
    if (this.windows.main?.isFullScreen()) this.windows.main.setFullScreen(false);
    this.removeAllListeners();
  }
}

// Codecs Chromium can decode as HDR (PQ, BT.2020) here, asked of the renderer once per run:
// HEVC needs the platform decoder, so the answer depends on the GPU and driver.
const HDR_PROBE = `(async () => {
  const types = {
    hevc: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
    av1: 'video/mp4; codecs="av01.0.13M.10"',
    vp9: 'video/webm; codecs="vp09.02.51.10.01.09.16.09.01"',
  };
  const out = [];
  for (const [codec, contentType] of Object.entries(types)) {
    if (!MediaSource.isTypeSupported(contentType)) continue;
    const r = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType, width: 3840, height: 2160, bitrate: 40000000, framerate: 24, transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' },
    }).catch(() => null);
    if (r && r.supported) out.push(codec);
  }
  return out;
})()`;

let hdrCodecs: Promise<Set<string>> | null = null;

export function chromiumHdrCodecs(windows: WindowManager): Promise<Set<string>> {
  const wc = windows.main?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(new Set());
  hdrCodecs ??= wc.executeJavaScript(HDR_PROBE).then(
    (list: unknown) => new Set(Array.isArray(list) ? list.map(String) : []),
    () => {
      hdrCodecs = null;
      return new Set<string>();
    },
  );
  return hdrCodecs;
}
