// The music player (Android core MusicSession.kt, tv music/MusicService.kt Music): one session for the app, playing
// on while the user browses. The queue ($shared/music-queue, the same ops and vectors as Android's MusicQueue) is
// the truth; an <audio> element plays its current track straight from the server (/Audio/{id}/stream?static=true
// with DeviceId and PlaySessionId), the next one is fetched ahead. Each track reports Playing, Progress every 10 s
// and Stopped. A track that fails is skipped. Video playback ends the session (screens/Player.svelte).
import type { BaseItem } from '$shared/models';
import { lyricsFromJellyfin, parseLrc, type Lyrics } from '$shared/music';
import { applyQueueOp, nextIndex, type QueueOp, type QueueState } from '$shared/music-queue';
import type { Api } from './api';
import { buildQuery } from './api';
import { deviceId } from './identity';
import { nav } from './nav.svelte';
import { reporter } from './reporter';
import { setMusicTarget } from './remote-control';
import { scrobbleListened, scrobbleNowPlaying } from './scrobble.svelte';

const TICKS_PER_MS = 10_000;
const PROGRESS_MS = 10_000;
const NO_LYRICS: Lyrics = { synced: false, lines: [] };
const newSessionId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export class MusicSession {
  queue = $state<QueueState>({ ids: [], index: 0, repeat: 'off', unshuffled: null });
  // Every queued track by id (the queue row, the metadata).
  known = $state.raw<Map<string, BaseItem>>(new Map());
  playing = $state(false);
  positionMs = $state(0);
  durationMs = $state(0);
  released = $state(false);
  // Lyrics by track id, NO_LYRICS when the server has none.
  lyrics = $state.raw<Map<string, Lyrics>>(new Map());

  private readonly audio = new Audio();
  private readonly ahead = new Audio();
  private playSessionId = '';
  // The next track's URL as prefetched: loading it reuses the bytes already fetched.
  private aheadUrl: { id: string; url: string } | null = null;
  private reported = false;
  // Scrobbling: when the track started (Unix s) and how long it was heard (pauses and seeks not counted).
  private startedAt = 0;
  private heardMs = 0;
  private lastTime = -1;
  private errors = 0;
  private timer = 0;

  constructor(readonly api: Api, items: BaseItem[], start: number) {
    this.known = new Map(items.map((i) => [i.Id, i]));
    this.queue = { ids: items.map((i) => i.Id), index: Math.max(0, Math.min(start, items.length - 1)), repeat: 'off', unshuffled: null };
    this.ahead.preload = 'auto';
    this.audio.addEventListener('timeupdate', () => {
      const t = this.audio.currentTime * 1000;
      // Played time only: a jump (a seek) or a stall does not count.
      if (this.lastTime >= 0 && t > this.lastTime && t - this.lastTime < 2000) this.heardMs += t - this.lastTime;
      this.lastTime = t;
      this.positionMs = this.audio.currentTime * 1000;
      if (isFinite(this.audio.duration)) this.durationMs = this.audio.duration * 1000;
    });
    this.audio.addEventListener('play', () => this.onPlaying(true));
    this.audio.addEventListener('pause', () => this.onPlaying(false));
    this.audio.addEventListener('playing', () => (this.errors = 0));
    this.audio.addEventListener('ended', () => this.ended());
    this.audio.addEventListener('error', () => this.failed());
    this.timer = window.setInterval(() => {
      if (this.playing) this.report('/Sessions/Playing/Progress', 'TimeUpdate');
    }, PROGRESS_MS);
  }

  get currentId(): string | undefined {
    return this.queue.ids[this.queue.index];
  }

  get current(): BaseItem | undefined {
    const id = this.currentId;
    return id ? this.known.get(id) : undefined;
  }

  // --- Transport ---

  start(): void {
    this.load();
  }

  playPause(): void {
    if (this.audio.paused) {
      if (this.audio.ended) this.audio.currentTime = 0;
      void this.audio.play();
    } else this.audio.pause();
  }

  seek(ms: number): void {
    this.audio.currentTime = Math.max(0, Math.min(ms, this.durationMs || ms)) / 1000;
  }

  next(): void {
    const n = nextIndex(this.queue, true);
    if (n >= 0) this.jump(n);
  }

  // The previous entry within the first 5 s, else back to the start.
  previous(): void {
    const q = this.queue;
    const p = q.index > 0 ? q.index - 1 : q.repeat === 'all' ? q.ids.length - 1 : -1;
    if (this.positionMs > 5000 || p < 0) this.seek(0);
    else this.jump(p);
  }

  jump(i: number): void {
    if (i < 0 || i >= this.queue.ids.length || this.released) return;
    this.end(this.positionMs);
    this.queue = applyQueueOp(this.queue, { op: 'jump', index: i });
    this.load();
  }

  // --- Queue edits ---

  move(from: number, to: number): void {
    this.edit({ op: 'move', from, to });
  }

  remove(i: number): void {
    this.edit({ op: 'remove', index: i });
  }

  toggleShuffle(): void {
    this.edit(this.queue.unshuffled === null ? { op: 'shuffle', seed: Math.floor(Math.random() * 2 ** 31) } : { op: 'unshuffle' });
  }

  cycleRepeat(): void {
    const order = ['off', 'all', 'one'] as const;
    this.edit({ op: 'repeat', mode: order[(order.indexOf(this.queue.repeat) + 1) % order.length] });
  }

  // "Mix": the server's instant mix of the current track replaces what comes after it; the track plays on.
  async mix(): Promise<boolean> {
    const id = this.currentId;
    if (!id) return false;
    const mix = (await this.api.instantMix(id).catch(() => null))?.Items.filter((i) => i.Id !== id) ?? [];
    if (!mix.length || this.released) return false;
    this.add(mix);
    this.edit({ op: 'clearUpcoming' });
    this.edit({ op: 'append', ids: mix.map((i) => i.Id) });
    return true;
  }

  private add(items: BaseItem[]): void {
    const known = new Map(this.known);
    for (const i of items) known.set(i.Id, i);
    this.known = known;
  }

  // A queue operation: the track plays on unless the playing entry went.
  private edit(op: QueueOp): void {
    if (this.released) return;
    const was = this.currentId;
    this.queue = applyQueueOp(this.queue, op);
    if (!this.queue.ids.length) this.release();
    else if (this.currentId !== was) {
      this.end(this.positionMs);
      this.load();
    } else this.prefetch();
  }

  // --- Playback ---

  private url(id: string): string | null {
    const it = this.known.get(id);
    // The track's own source id (an Emby source id is not the item id), DeviceId and a PlaySessionId (Emby answers 400
    // without the DeviceId).
    return this.api.mediaUrl(`/Audio/${id}/stream${buildQuery({ static: true, MediaSourceId: it?.MediaSources?.[0]?.Id, PlaySessionId: newSessionId(), DeviceId: deviceId })}`);
  }

  private load(): void {
    const id = this.currentId;
    if (!id) return;
    const url = this.aheadUrl?.id === id ? this.aheadUrl.url : this.url(id);
    if (!url) return this.failed();
    this.playSessionId = new URL(url).searchParams.get('PlaySessionId') ?? newSessionId();
    this.positionMs = 0;
    this.durationMs = (this.known.get(id)?.RunTimeTicks ?? 0) / TICKS_PER_MS;
    this.audio.src = url;
    void this.audio.play().catch(() => {});
    this.reported = true;
    this.report('/Sessions/Playing', null);
    this.startedAt = Math.floor(Date.now() / 1000);
    this.heardMs = 0;
    this.lastTime = -1;
    const it = this.known.get(id);
    if (it) scrobbleNowPlaying(it);
    this.prefetch();
  }

  // The next track's first bytes, so the change of track does not wait for the network.
  private prefetch(): void {
    const n = nextIndex(this.queue);
    const id = n >= 0 && n !== this.queue.index ? this.queue.ids[n] : undefined;
    if (id && this.aheadUrl?.id === id) return;
    const url = id ? this.url(id) : null;
    this.aheadUrl = id && url ? { id, url } : null;
    if (url) this.ahead.src = url;
    else this.ahead.removeAttribute('src');
  }

  private onPlaying(on: boolean): void {
    this.playing = on;
    if (!this.audio.ended) this.report('/Sessions/Playing/Progress', on ? 'Unpause' : 'Pause');
  }

  private ended(): void {
    this.end((this.current?.RunTimeTicks ?? 0) / TICKS_PER_MS || this.positionMs);
    const n = nextIndex(this.queue);
    if (n < 0) {
      this.playing = false;
      return;
    }
    this.queue = applyQueueOp(this.queue, { op: 'jump', index: n });
    this.load();
  }

  private failed(): void {
    const n = nextIndex(this.queue, true);
    if (++this.errors <= this.queue.ids.length && n >= 0 && n !== this.queue.index) this.jump(n);
    else this.playing = false;
  }

  // --- Lyrics ---

  async loadLyrics(): Promise<void> {
    const id = this.currentId;
    if (!id || this.lyrics.has(id)) return;
    // The full item: Jellyfin's HasLyrics, Emby's subtitle streams.
    const full = await this.api.item(id).catch(() => null);
    const raw = full ? await this.api.lyricsText(full) : null;
    let lyrics: Lyrics | null = null;
    if (raw && 'jellyfin' in raw) lyrics = lyricsFromJellyfin(raw.jellyfin as Parameters<typeof lyricsFromJellyfin>[0]);
    else if (raw && 'lrc' in raw) lyrics = parseLrc(raw.lrc);
    const map = new Map(this.lyrics);
    map.set(id, lyrics && lyrics.lines.length ? lyrics : NO_LYRICS);
    this.lyrics = map;
  }

  // --- Reports: the server plugins scrobble from them ---

  private body(it: BaseItem, posMs: number, event: string | null): Record<string, unknown> {
    return {
      ItemId: it.Id,
      MediaSourceId: it.MediaSources?.[0]?.Id,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.round(posMs * TICKS_PER_MS),
      IsPaused: this.audio.paused,
      IsMuted: false,
      PlayMethod: 'DirectPlay',
      CanSeek: true,
      RepeatMode: 'RepeatNone',
      ...(event ? { EventName: event } : {}),
    };
  }

  private report(path: '/Sessions/Playing' | '/Sessions/Playing/Progress', event: string | null): void {
    const it = this.current;
    if (!it || this.released || !this.reported) return;
    const body = this.body(it, path === '/Sessions/Playing' ? 0 : this.positionMs, event);
    if (path.endsWith('/Progress')) reporter.latest(() => this.api.report(path, body));
    else void reporter.send(() => this.api.report(path, body));
  }

  // Stopped for the current track, once.
  private end(posMs: number): void {
    const it = this.current;
    if (!it || !this.reported) return;
    this.reported = false;
    scrobbleListened(it, this.startedAt, this.heardMs);
    const body = this.body(it, posMs, null);
    void reporter.send(() => this.api.report('/Sessions/Playing/Stopped', body));
  }

  release(): void {
    if (this.released) return;
    this.end(this.positionMs);
    this.released = true;
    this.playing = false;
    clearInterval(this.timer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.ahead.removeAttribute('src');
  }
}

// The app's one music session (Android object Music).
export const music = $state<{ session: MusicSession | null }>({ session: null });

export function playMusic(api: Api, items: BaseItem[], start = 0, shuffle = false): void {
  if (!items.length) return;
  music.session?.release();
  const s = new MusicSession(api, items, start);
  if (shuffle) s.toggleShuffle();
  music.session = s;
  s.start();
  // X-06: a controller's commands reach the music while no video plays.
  setMusicTarget({
    pause: () => s.playing && s.playPause(),
    unpause: () => s.playing || s.playPause(),
    playPause: () => s.playPause(),
    stop: stopMusic,
    seek: (ms) => s.seek(ms),
    next: () => s.next(),
    previous: () => s.previous(),
    audio: () => {},
    subtitle: () => {},
  });
}

export function stopMusic(): void {
  music.session?.release();
  music.session = null;
  setMusicTarget(null);
}

// Something to show: a session with a track.
export function musicActive(): boolean {
  return !!music.session && !music.session.released && !!music.session.current;
}

// Plays [item] in the music session and opens the now-playing screen (Android tv playMusic): a track on through its
// album from itself, an album, artist, playlist or genre from its first track.
export async function playMusicItem(api: Api, item: BaseItem, shuffle = false): Promise<boolean> {
  const isTrack = item.Type === 'Audio';
  const holder = isTrack && item.AlbumId ? ({ Id: item.AlbumId, Type: 'MusicAlbum' } as BaseItem) : item;
  const tracks = isTrack && !item.AlbumId ? [item] : await api.tracksOf(holder).catch(() => []);
  if (!tracks.length) return false;
  const start = isTrack ? Math.max(0, tracks.findIndex((t) => t.Id === item.Id)) : shuffle ? Math.floor(Math.random() * tracks.length) : 0;
  playMusic(api, tracks, start, shuffle);
  nav.push({ name: 'nowPlaying' });
  return true;
}
