// Music, the player side (music-spec §4.1, MU-02): the twin of livetv/live-player.ts. playback-service.ts (HOT)
// only calls in: prepare (a track's load options), onTime (gapless prefetch), onEnded (the queue's next),
// command (queue edits, shuffle, repeat, radio), queueChanged (play next / add to queue) and state().
// Gapless: while track n plays, n+1 is appended to mpv's playlist; when mpv moves on by itself, n is reported
// Stopped at its full length, then n+1 Playing, with no reload. Any failure there leaves the plain path:
// 'ended' → onEnded → startItem (a short gap, never a stop).
import { randomUUID } from 'node:crypto';
import { TICKS_PER_MS, type MusicState, type PlaybackCommand, type PlaybackState, type PlayRequest } from '../../shared/contract';
import type { BaseItem, MediaSource } from '../../shared/models';
import { nextIndex, type Repeat } from '../../shared/music-queue';
import { userItem } from '../connection/user-routes';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { PlayQueue } from '../playback/play-queue';
import { nowPlaying, redirectTarget, validId, type Current, type PlaybackDeps, type StartOptions } from '../playback/playback-model';
import type { ActivePlayer, LoadParams, MusicLoad } from '../playback/player';
import { MpvAudioPlayer, type GainInfo } from './mpv-audio-player';

const log = logger.scope('music');

// Prefetch the next track this long before the current one ends (at once for a shorter track).
const PREFETCH_MS = 20_000;
// Radio (MU-06): top the queue up once this few tracks are left, by this many.
const RADIO_LOW = 3;
const RADIO_ADD = 20;
const SAVE_EVERY_MS = 5000;

// What the playback service lends the music module (its own fields, read and written in place).
export interface MusicHost {
  readonly deps: PlaybackDeps;
  current: Current | null;
  readonly state: PlaybackState;
  readonly player: ActivePlayer | null;
  readonly queue: PlayQueue;
  publish(now?: boolean): void;
  reportStopped(): Promise<void>;
  reportStart(): void;
  startItem(opts: StartOptions): Promise<void>;
  play(req: PlayRequest): Promise<void>;
  stop(): Promise<void>;
}

interface Prefetched {
  index: number;
  id: string;
  item: BaseItem;
  playSessionId: string;
  local: boolean;
}

// D8: the queue as it was, restored paused at start-up.
interface SavedQueue {
  serverId?: string;
  ids: string[];
  index: number;
  positionMs: number;
  repeat: Repeat;
  unshuffled: string[] | null;
  radio: boolean;
}

export class MusicPlayback {
  private next: Prefetched | null = null;
  private prefetching = false;
  private watched: ActivePlayer | null = null;
  private gain: GainInfo | undefined;
  private radio = false;
  private toppingUp = false;
  // Ids played this run: radio never brings them back.
  private readonly played = new Set<string>();
  private lastSeed = '';
  private readonly albumGains = new Map<string, number | undefined>();
  private readonly saved: JsonStore<SavedQueue | null> | null;
  private savedAt = 0;
  private restoring: SavedQueue | null = null;
  private restored = false;
  private waitingPage = false;

  constructor(private readonly host: MusicHost) {
    this.saved = host.deps.musicQueueFile ? new JsonStore<SavedQueue | null>(host.deps.musicQueueFile, null) : null;
    // Preamp, clipping, gapless and the output follow the settings while a track plays.
    host.deps.settings.on('change', () => {
      const p = host.player;
      if (p instanceof MpvAudioPlayer) void p.applySettings();
    });
  }

  // A track is playing (the state's item, so it holds between a Stopped report and the next track).
  get active(): boolean {
    return Boolean(this.host.state.active && this.host.state.item?.type === 'Audio');
  }

  state(): MusicState {
    const q = this.host.queue;
    return { shuffle: q.unshuffled !== null, repeat: q.repeat, queue: { ids: [...q.ids], index: q.index }, radio: this.radio, gain: this.gain };
  }

  // startItem, for a track: its loudness and, when the queue comes back at start-up, a paused start.
  async prepare(item: BaseItem): Promise<MusicLoad> {
    const player = this.host.player;
    this.watch(player);
    // A fresh load replaces mpv's playlist: nothing is prefetched any more.
    this.next = null;
    const r = this.restoring;
    this.restoring = null;
    if (r) {
      this.host.queue.repeat = r.repeat;
      this.host.queue.unshuffled = r.unshuffled;
      this.radio = r.radio;
    }
    const load = { ...(await this.gainFor(item)), paused: Boolean(r) };
    // The built-in player reads no tags: what it applies is known now. mpv says once the file is open ('gain').
    this.gain = player?.kind === 'html' ? { source: load.untagged, db: load.htmlGainDb } : undefined;
    this.save(r?.positionMs ?? 0);
    return load;
  }

  // Loudness (spec §4.1.1, D2): the file's ReplayGain tags in the chosen mode (mpv); without tags the server's
  // gain (Jellyfin NormalizationGain, the album's in album mode), else the fallback; the preamp on top.
  private async gainFor(item: BaseItem): Promise<Omit<MusicLoad, 'paused'>> {
    const m = this.host.deps.settings.value.music;
    // Auto: album gain while an album plays in order, track gain once shuffled.
    const mode = m.replayGain === 'auto' ? (this.host.queue.unshuffled ? 'track' : 'album') : m.replayGain;
    let server = typeof item.NormalizationGain === 'number' ? item.NormalizationGain : undefined;
    if (mode === 'album' && item.AlbumId) server = (await this.albumGain(item.AlbumId)) ?? server;
    if (mode === 'off') return { replayGain: 'no', untaggedDb: 0, untagged: 'none', preampDb: 0, htmlGainDb: 0 };
    return { replayGain: mode, untaggedDb: (server ?? m.fallbackDb) + m.preampDb, untagged: server === undefined ? 'none' : 'server', preampDb: m.preampDb, htmlGainDb: (server ?? 0) + m.preampDb };
  }

  // Emby sends no loudness field (spec §3.6, unverified for 4.9): only Jellyfin is asked.
  private async albumGain(albumId: string): Promise<number | undefined> {
    if (this.albumGains.has(albumId)) return this.albumGains.get(albumId);
    const api = this.api();
    if (api?.kind !== 'jellyfin' && api?.kind !== 'navidrome') return undefined;
    const album = await userItem<BaseItem>(api, this.userId(), albumId).catch(() => null);
    const db = typeof album?.NormalizationGain === 'number' ? album.NormalizationGain : undefined;
    this.albumGains.set(albumId, db);
    return db;
  }

  private api() {
    return this.host.deps.connection.onlineApi(this.host.queue.serverId);
  }

  private userId(): string {
    return this.host.deps.connection.userIdFor(this.host.queue.serverId);
  }

  private watch(p: ActivePlayer | null): void {
    if (!p || p === this.watched) return;
    this.watched = p;
    p.on('advance', () => void this.onAdvance(p).catch((err) => log.warn('gapless advance failed', err)));
    p.on('gain', (g: GainInfo) => {
      if (this.host.player !== p) return;
      this.gain = g;
      this.host.publish();
    });
  }

  // Every time update while a track plays: the prefetch once the end is near, the saved position now and then.
  onTime(): void {
    if (!this.active) return;
    this.radioCheck();
    const s = this.host.state;
    if (Date.now() - this.savedAt > SAVE_EVERY_MS) this.save(s.positionMs);
    if (s.durationMs > 0 && s.durationMs - s.positionMs <= PREFETCH_MS) void this.prefetch();
  }

  private still(p: ActivePlayer, index: number, id: string): boolean {
    const q = this.host.queue;
    return this.host.player === p && nextIndex(q.qs) === index && q.ids[index] === id;
  }

  // The next track into mpv's playlist. Direct play only: a stream the server transcodes or caps (or a gapless
  // setting turned off) keeps the plain path.
  private async prefetch(): Promise<void> {
    const p = this.host.player;
    const c = this.host.current;
    if (!(p instanceof MpvAudioPlayer) || p.prefetched || this.next || this.prefetching || !c || c.offline || c.playMethod !== 'DirectPlay') return;
    if (!this.host.deps.settings.value.music.gapless) return;
    this.prefetching = true;
    try {
      let i = nextIndex(this.host.queue.qs);
      if (i < 0 && this.radio) i = await this.topUp();
      const id = this.host.queue.ids[i];
      const api = this.api();
      if (i < 0 || !id || !api) return;
      const item = await userItem<BaseItem>(api, this.userId(), id);
      if (!this.still(p, i, id) || item.MediaType !== 'Audio' || !validId(item.Id)) return;
      const local = this.host.deps.downloads.findDone(id, this.host.queue.serverId)?.filePath;
      const playSessionId = randomUUID().replace(/-/g, '');
      let url = local ?? api.url(`/Audio/${item.Id}/stream`, { Static: true, MediaSourceId: item.MediaSources?.[0]?.Id ?? item.Id, PlaySessionId: playSessionId, DeviceId: this.host.deps.deviceId });
      let headers = local ? [] : api.mediaAuthHeaders();
      // As startItem: a redirect to another origin is played without the auth header.
      const target = local ? null : await redirectTarget(api, url);
      if (target) [url, headers] = [target, []];
      const music = { ...(await this.gainFor(item)), paused: false };
      if (!this.still(p, i, id)) return;
      const params: LoadParams = { url, isHls: false, httpHeaders: headers, startMs: 0, title: item.Name, volume: this.host.state.volume, muted: this.host.state.muted, audioIndex: null, subtitleIndex: null, embeddedAudio: [], embeddedSubtitles: [], externalSubtitles: [], tracksFixed: false, hdr: null, music };
      await p.append(params);
      this.next = { index: i, id, item, playSessionId, local: Boolean(local) };
      log.info(`prefetched queue entry ${i}`);
      // Edited while it was being appended.
      if (!this.still(p, i, id)) this.queueChanged();
    } catch (err) {
      log.debug(`prefetch failed: ${String(err)}`);
    } finally {
      this.prefetching = false;
    }
  }

  // mpv moved on to the prefetched entry: n Stopped at its full length (scrobbling plugins count it, spec §3.9),
  // then n+1 Playing, no reload.
  private async onAdvance(p: ActivePlayer): Promise<void> {
    const n = this.next;
    this.next = null;
    const host = this.host;
    if (host.player !== p || !n) return;
    const s = host.state;
    s.positionMs = s.durationMs;
    const userId = host.current?.userId;
    await host.reportStopped();
    if (host.player !== p) return;
    const sid = host.queue.serverId;
    host.queue.index = n.index;
    const source: MediaSource = n.item.MediaSources?.[0] ?? ({ Id: n.item.Id } as MediaSource);
    host.current = { item: n.item, source, playSessionId: n.playSessionId, playMethod: 'DirectPlay', offline: false, local: n.local, serverId: sid, userId, audioIndex: null, subtitleIndex: null, kind: 'mpv', trailer: false };
    Object.assign(s, { item: nowPlaying(n.item, sid), positionMs: 0, durationMs: (n.item.RunTimeTicks ?? 0) / TICKS_PER_MS, queueIndex: n.index, queueLength: host.queue.ids.length, buffering: false, playMethod: 'DirectPlay' });
    this.gain = undefined;
    host.publish(true);
    host.reportStart();
    this.save(0);
  }

  // The end of a track that had nothing prefetched: the queue's next (repeat, radio), or the end.
  async onEnded(): Promise<void> {
    let i = nextIndex(this.host.queue.qs);
    if (i < 0 && this.radio) i = await this.topUp();
    if (i < 0) {
      this.saved?.set(null);
      return this.host.stop();
    }
    this.host.queue.index = i;
    await this.host.startItem({ player: this.host.player?.kind });
  }

  // Radio: the instant mix of the queue's last track joins it (spec §3.3: /Items/{id}/InstantMix everywhere), at
  // most RADIO_ADD tracks, none already queued or played this run.
  private async topUp(): Promise<number> {
    const q = this.host.queue;
    const api = this.api();
    const seed = q.ids[q.ids.length - 1];
    if (!api || !seed || this.toppingUp) return -1;
    this.toppingUp = true;
    try {
      this.lastSeed = seed;
      const userKey = api.kind === 'jellyfin' ? 'userId' : 'UserId';
      const mix = await api.get<{ Items?: BaseItem[] }>(`/Items/${seed}/InstantMix`, { [userKey]: this.userId(), Limit: 50 }).catch(() => null);
      const add = [...new Set((mix?.Items ?? []).map((x) => x.Id))].filter((id) => validId(id) && !q.ids.includes(id) && !this.played.has(id)).slice(0, RADIO_ADD);
      if (!add.length) return -1;
      q.apply({ op: 'append', ids: add });
      Object.assign(this.host.state, { queueLength: q.ids.length });
      log.info(`radio added ${add.length} tracks`);
      this.queueChanged();
      return nextIndex(q.qs);
    } finally {
      this.toppingUp = false;
    }
  }

  // Radio on and RADIO_LOW tracks or fewer left: one top-up per seed (a mix that adds nothing is not asked again).
  private radioCheck(): void {
    const q = this.host.queue;
    if (q.id) this.played.add(q.id);
    if (!this.radio || this.toppingUp || q.ids.length - 1 - q.index > RADIO_LOW || q.ids[q.ids.length - 1] === this.lastSeed) return;
    void this.topUp();
  }

  // Queue edits, shuffle, repeat, radio, and next / jump within the queue. False: not a music command now.
  async command(cmd: PlaybackCommand): Promise<boolean> {
    if (!this.active) return false;
    const q = this.host.queue;
    const kind = this.host.player?.kind;
    switch (cmd.type) {
      case 'queue-move':
        q.apply({ op: 'move', from: cmd.from, to: cmd.to });
        break;
      case 'queue-clear-upcoming':
        q.apply({ op: 'clearUpcoming' });
        break;
      case 'repeat':
        q.apply({ op: 'repeat', mode: cmd.mode });
        break;
      case 'shuffle':
        q.apply(cmd.value ? { op: 'shuffle', seed: Date.now() } : { op: 'unshuffle' });
        break;
      case 'radio':
        this.radio = cmd.value;
        this.lastSeed = '';
        this.radioCheck();
        break;
      case 'queue-remove': {
        if (cmd.index !== q.index) {
          q.apply({ op: 'remove', index: cmd.index });
          break;
        }
        // The playing track: the next one plays; it was the last one: the end.
        const last = cmd.index === q.ids.length - 1;
        await this.host.reportStopped();
        q.apply({ op: 'remove', index: cmd.index });
        if (last || !q.ids.length) await this.host.stop();
        else await this.host.startItem({ player: kind });
        return true;
      }
      case 'queue-jump':
      case 'next': {
        const i = cmd.type === 'next' ? nextIndex(q.qs, true) : cmd.index;
        if (i < 0 || i >= q.ids.length) return true;
        await this.host.reportStopped();
        q.index = i;
        await this.host.startItem({ player: kind });
        return true;
      }
      default:
        return false;
    }
    this.queueChanged();
    return true;
  }

  // After any queue change: a prefetched entry that no longer follows leaves mpv's playlist, the state follows.
  queueChanged(): void {
    if (!this.active) return;
    const q = this.host.queue;
    const i = nextIndex(q.qs);
    if (this.next && q.ids[i] === this.next.id) this.next.index = i;
    else if (this.next) {
      this.next = null;
      const p = this.host.player;
      if (p instanceof MpvAudioPlayer) void p.dropNext();
    }
    Object.assign(this.host.state, { queueIndex: q.index, queueLength: q.ids.length });
    this.save(this.host.state.positionMs);
    this.host.publish(true);
    this.onTime();
  }

  private save(positionMs: number): void {
    if (!this.saved) return;
    this.savedAt = Date.now();
    const q = this.host.queue;
    this.saved.set({ serverId: q.serverId, ids: q.ids.slice(0, 1000), index: q.index, positionMs: Math.round(positionMs), repeat: q.repeat, unshuffled: q.unshuffled, radio: this.radio });
  }

  // D8: once per run, when the saved queue's server is signed in and nothing plays: back, paused.
  restore(): void {
    const s = this.saved?.value;
    const h = this.host;
    if (this.restored || h.state.active || !h.deps.settings.value.music.resumeQueue) return;
    if (!s || !Array.isArray(s.ids) || !s.ids.length || !Number.isInteger(s.index)) return;
    if (h.deps.connection.sessionFor(s.serverId)?.status !== 'signed-in') return;
    // The built-in engine plays in the page: not before the page can take the stream.
    const page = h.deps.windows.main?.webContents;
    if (page?.isLoading()) {
      if (!this.waitingPage) page.once('did-stop-loading', () => ((this.waitingPage = false), this.restore()));
      this.waitingPage = true;
      return;
    }
    this.restored = true;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
    this.restoring = { ...s, repeat: (['off', 'all', 'one'] as const).includes(s.repeat) ? s.repeat : 'off', unshuffled: strings(s.unshuffled), radio: s.radio === true };
    const positionMs = Number.isFinite(s.positionMs) && s.positionMs > 0 ? s.positionMs : 0;
    log.info('restoring the music queue, paused');
    void h
      // play() rewinds every resume by 5 s (a film's recap): a song comes back where it stopped (MU-04 AC7).
      .play({ itemIds: s.ids, serverId: s.serverId, startIndex: s.index, startPositionTicks: positionMs ? Math.round((positionMs + 5000) * TICKS_PER_MS) : undefined })
      .catch((err) => log.warn('queue restore failed', err))
      // Consumed by prepare(); a start that failed before it must not pause the next one.
      .finally(() => (this.restoring = null));
  }
}
