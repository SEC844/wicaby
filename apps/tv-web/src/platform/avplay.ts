import { Emitter, type Aspect, type Track, type VideoPlayer } from './player';

// Samsung AVPlay (webapis.avplay): the TV's own media pipeline, so HEVC, HDR10/HDR10+ and passthrough audio play as
// in the built-in apps. Video renders on a plane behind the page, through the <object type="application/avplayer">
// that mountAvplayObject() adds; the page above it stays transparent while playing.
interface AvTrackInfo { index: number; type: 'VIDEO' | 'AUDIO' | 'TEXT'; extra_info: string }
interface AvPlay {
  open(url: string): void;
  close(): void;
  prepareAsync(ok: () => void, fail: (e: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number, ok?: () => void, fail?: (e: unknown) => void): void;
  getDuration(): number;
  getCurrentTime(): number;
  getState(): 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED';
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setDisplayMethod(method: string): void;
  setStreamingProperty(name: string, value: string): void;
  getTotalTrackInfo(): AvTrackInfo[];
  setSelectTrack(type: 'AUDIO' | 'TEXT', index: number): void;
  setSilentSubtitle(silent: boolean): void;
  setListener(l: Record<string, (...a: never[]) => void>): void;
}

declare const webapis: { avplay: AvPlay } | undefined;

export function avplayAvailable(): boolean {
  return typeof webapis !== 'undefined' && !!webapis?.avplay;
}

export function mountAvplayObject(): void {
  if (document.getElementById('av-player')) return;
  const el = document.createElement('object');
  el.id = 'av-player';
  el.type = 'application/avplayer';
  el.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:-1';
  document.body.appendChild(el);
}

function language(info: AvTrackInfo): string {
  try {
    return (JSON.parse(info.extra_info) as { language?: string }).language ?? '';
  } catch {
    return '';
  }
}

export class AvPlayer extends Emitter implements VideoPlayer {
  private readonly av = webapis!.avplay;

  constructor() {
    super();
    mountAvplayObject();
  }

  open(url: string, startMs = 0): Promise<void> {
    if (this.av.getState() !== 'NONE') this.av.close();
    this.av.open(url);
    this.av.setDisplayRect(0, 0, 1920, 1080);
    this.av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
    // Lets the pipeline pick its UHD decoder; ignored on HD sets.
    try { this.av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch { /* HD-only model */ }
    this.av.setListener({
      onbufferingstart: () => this.emit('buffering', true),
      onbufferingcomplete: () => this.emit('buffering', false),
      oncurrentplaytime: (ms: number) => this.emit('time', ms),
      onstreamcompleted: () => this.emit('ended'),
      onerror: (type: string) => this.emit('error', String(type)),
    });
    return new Promise((resolve, reject) => {
      this.av.prepareAsync(
        // A failed initial seek still leaves a playable stream: start from the top rather than fail.
        () => (startMs > 0 ? this.av.seekTo(startMs, () => resolve(), () => resolve()) : resolve()),
        (e) => reject(new Error(`AVPlay prepare: ${String((e as { name?: string })?.name ?? e)}`)),
      );
    });
  }

  play(): void { this.av.play(); }
  pause(): void { this.av.pause(); }
  seek(ms: number): void { this.av.seekTo(Math.max(0, Math.round(ms))); }

  stop(): void {
    try { this.av.stop(); } finally { this.av.close(); }
  }

  get durationMs(): number { return this.av.getState() === 'NONE' ? 0 : this.av.getDuration(); }
  get positionMs(): number { return this.av.getState() === 'NONE' ? 0 : this.av.getCurrentTime(); }
  get paused(): boolean { return this.av.getState() !== 'PLAYING'; }

  private tracks(type: 'AUDIO' | 'TEXT'): Track[] {
    return this.av.getTotalTrackInfo()
      .filter((t) => t.type === type)
      .map((t) => ({ index: t.index, language: language(t), label: language(t) }));
  }

  audioTracks(): Track[] { return this.tracks('AUDIO'); }
  textTracks(): Track[] { return this.tracks('TEXT'); }
  selectAudio(index: number): void { this.av.setSelectTrack('AUDIO', index); }

  // The plane letterboxes or stretches; AVPlay has no crop mode.
  readonly aspects: Aspect[] = ['fit', 'stretch'];

  setAspect(a: Aspect): void {
    try {
      this.av.setDisplayMethod(a === 'stretch' ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX');
    } catch {
      // Not ready yet: the next open applies the letterbox default.
    }
  }

  selectText(index: number | null): void {
    if (index == null) return this.av.setSilentSubtitle(true);
    this.av.setSelectTrack('TEXT', index);
    this.av.setSilentSubtitle(false);
  }
}
