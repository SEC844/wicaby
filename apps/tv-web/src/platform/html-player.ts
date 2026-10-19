import { Emitter, type Aspect, type Track, type VideoPlayer } from './player';

// <video>-based player: webOS (its media pipeline decodes HEVC/HDR in hardware) and the dev build.
export class HtmlPlayer extends Emitter implements VideoPlayer {
  constructor(private readonly video: HTMLVideoElement) {
    super();
    video.addEventListener('timeupdate', () => this.emit('time', this.positionMs));
    video.addEventListener('waiting', () => this.emit('buffering', true));
    video.addEventListener('playing', () => this.emit('buffering', false));
    video.addEventListener('ended', () => this.emit('ended'));
    video.addEventListener('error', () => this.emit('error', video.error?.message || `media error ${video.error?.code ?? ''}`));
  }

  async open(url: string, startMs = 0): Promise<void> {
    this.video.src = url;
    await new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(this.video.error?.message || 'media error')); };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', done);
        this.video.removeEventListener('error', fail);
      };
      this.video.addEventListener('loadedmetadata', done);
      this.video.addEventListener('error', fail);
    });
    if (startMs > 0) this.video.currentTime = startMs / 1000;
  }

  play(): void { void this.video.play(); }
  pause(): void { this.video.pause(); }
  seek(ms: number): void { this.video.currentTime = Math.max(0, ms / 1000); }

  stop(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  get durationMs(): number { return Number.isFinite(this.video.duration) ? this.video.duration * 1000 : 0; }
  get positionMs(): number { return this.video.currentTime * 1000; }
  get paused(): boolean { return this.video.paused; }

  // Track lists are not exposed by every engine; the server-side stream selection covers the rest.
  audioTracks(): Track[] {
    const list = (this.video as HTMLVideoElement & { audioTracks?: ArrayLike<{ language: string; label: string }> }).audioTracks;
    return list ? Array.from(list, (t, index) => ({ index, language: t.language, label: t.label })) : [];
  }

  textTracks(): Track[] {
    return Array.from(this.video.textTracks, (t, index) => ({ index, language: t.language, label: t.label }));
  }

  selectAudio(index: number): void {
    const list = (this.video as HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks;
    if (list) Array.from(list).forEach((t, i) => (t.enabled = i === index));
  }

  readonly aspects: Aspect[] = ['fit', 'fill', 'stretch', 'zoom'];

  setAspect(a: Aspect): void {
    this.video.style.objectFit = a === 'fit' ? 'contain' : a === 'stretch' ? 'fill' : 'cover';
    this.video.style.transform = a === 'zoom' ? 'scale(1.333)' : '';
  }

  selectText(index: number | null): void {
    Array.from(this.video.textTracks).forEach((t, i) => (t.mode = i === index ? 'showing' : 'disabled'));
  }
}
