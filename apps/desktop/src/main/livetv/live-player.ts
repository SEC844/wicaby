// Live TV, the player side of live-session.ts (livetv-spec-final.md §8.1, §8.2, §8.8, §21.3): loading a
// tuned channel, make-before-break, stall and pause watch, recovery, sleep. playback-service.ts (HOT)
// only calls in: openLive (startItem on a channel), its own adoptLive (first frame shown) and
// releaseLive (its Stopped report goes through the ledger).
import { writeFile } from 'node:fs';
import { join } from 'node:path';
import { app, powerMonitor } from 'electron';
import type { LiveState, PlaybackCommand, PlaybackState } from '../../shared/contract';
import type { BaseItem, MediaSource } from '../../shared/models';
import { isLanAddress } from '../../shared/network';
import { hdrFromStream } from '../../shared/hdr';
import { buildQuery, fetchServer, isServerOrigin, resolveServerUrl, serverPath, type ApiClient } from '../connection/api-client';
import { logger } from '../core/log';
import { t } from '../i18n';
import { buildDeviceProfile } from '../playback/device-profile';
import { QUALITY_PRESETS } from '../../shared/quality-presets';
import type { ActivePlayer, LoadParams, PlaybackStats, TimeUpdate } from '../playback/player';
import { idle, mediaApiUrl, nowPlaying, redirectTarget, toTrack, type Current, type PlaybackDeps, type StartOptions } from '../playback/playback-service';
import { rememberChoice, selectTracks, type TrackMemoryDoc } from '../playback/track-selection';
import {
  asLiveError,
  CADENCE_SETTLE_MS,
  CadenceGate,
  clampLiveSeek,
  clearLiveCache,
  FIRST_FRAME_MS,
  freeBytes,
  isBusyStream,
  LiveError,
  liveErrorKey,
  LiveSession,
  PAUSE_RELEASE_MS,
  QUIT_SWEEP_MS,
  rebaseBytes,
  rebaseDue,
  STALL_MS,
  TIMESHIFT_BEHIND_MS,
  TIMESHIFT_EDGE_MARGIN_MS,
  timeshiftPlan,
  timeshiftWall,
  timeshiftWindow,
  type LiveOpen,
  type Rung,
  type TimeshiftPlan,
} from './live-session';

const log = logger.scope('live');

// Current.live: the tuned stream, adopted once its first frame showed.
export interface LiveCurrent {
  open: LiveOpen;
  adopted: boolean;
  steps: number;
  load: LoadParams;
  // Timeshift of this channel (§8.8): a zap starts a new one, the buffer is lost.
  ts?: LiveTimeshift;
}

interface LiveTimeshift {
  plan: TimeshiftPlan;
  anchor: { wall: number; pos: number } | null; // first position seen after the first frame
  win: { start: number; end: number } | null;
  pos: number;
  overSince: number; // the disk cache file passed the rebase threshold at (0: not yet)
  boundary: number | null; // a due rebase waits for this programme end (or 10 min past the threshold)
}

const freshTs = (plan: TimeshiftPlan): LiveTimeshift => ({ plan, anchor: null, win: null, pos: 0, overSince: 0, boundary: null });

// StartOptions.live: stall recovery starts at this rung, after this many recovery steps.
export interface LiveRestart {
  rung: Rung;
  steps: number;
}

// What the playback service lends this module (its own fields, read and written in place).
export interface LiveHost {
  readonly deps: PlaybackDeps;
  current: Current | null;
  state: PlaybackState;
  readonly player: ActivePlayer | null;
  readonly seq: number;
  supersede(): void;
  readonly serverId: string | undefined;
  readonly queue: { index: number; length: number };
  setQueue(itemId: string, serverId: string | undefined): void;
  ensurePlayer(kind: 'mpv' | 'html'): Promise<ActivePlayer>;
  publish(immediate?: boolean): void;
  reportStopped(c?: Current | null): Promise<void>;
  startItem(opts: StartOptions): Promise<void>;
  fail(err: unknown): void;
  // adoptLive: Start report, progress timer, power, thumbar.
  adoptLive(video: boolean): void;
}

// mpv's load error carries no HTTP status ("loading failed"): ask the stream URL itself (§8.2, 503/429).
async function streamStatus(api: ApiClient, url: string, ownOrigin: boolean): Promise<number> {
  if (!/^https?:\/\//i.test(url)) return 0;
  try {
    const hop = await fetchServer(api, url, { method: 'GET', headers: ownOrigin ? api.authHeaders() : {}, timeoutMs: 2000 });
    if ('foreign' in hop) return 0;
    void hop.response.body?.cancel().catch(() => undefined);
    return hop.response.status;
  } catch {
    return 0;
  }
}

export class LivePlayback {
  readonly session: LiveSession;
  // Make-before-break: the channel being left, still open until the new one shows its first frame.
  private prev: { cur: Current; state: PlaybackState } | null = null;
  private tuning = 0;
  private wait: { fail: (message: string) => void } | null = null;
  // The stream was released while paused or asleep: play re-tunes.
  private released: 'pause' | 'sleep' | null = null;
  private releasedCur: Current | null = null; // its channel, still shown by the OSD
  private stall: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  // Audio and subtitle picks carry over between channels for the session (LT-22).
  private memory: TrackMemoryDoc = {};
  private fullAt = 0; // last "Pause trop longue" (the pause state lags the play command)
  // Display mode for live (§21.5): the cadence family the display was last matched to.
  private readonly cadence = new CadenceGate();
  private readonly host: LiveHost;
  // Disk-mode timeshift cache (§8.8), emptied at startup, on a zap and at stop.
  private readonly cacheDir = join(app.getPath('userData'), 'live-cache');
  // Dev builds: S21b forces a lower rebase threshold.
  private readonly rebaseOverride = app.isPackaged ? 0 : Number(process.env.WICABY_LIVE_REBASE_BYTES ?? 0);

  constructor(host: LiveHost) {
    this.host = host;
    const deps = host.deps;
    const dev = !app.isPackaged;
    clearLiveCache(this.cacheDir);
    const ledgerFile = join(app.getPath('userData'), 'live-ledger.json');
    this.session = new LiveSession({
      deviceId: deps.deviceId,
      settings: () => deps.settings.live,
      saveReleaseFirst: (serverId, until) => deps.settings.setReleaseFirst(serverId, until),
      notice: (key, params) => this.notice(key, params),
      api: (serverId) => deps.connection.onlineApi(serverId),
      log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e), debug: (m) => log.debug(m) },
      // Dev builds: the ledger for the mock scenarios (§16.3).
      devExport: dev ? (snap) => writeFile(ledgerFile, JSON.stringify(snap, null, 1), () => undefined) : null,
    });
    // Sleep: release the tuner now rather than let mpv retry a dead socket on resume (§21.3).
    powerMonitor.on('suspend', () => void this.suspend());
    powerMonitor.on('resume', () => this.resume());
    if (dev) Object.assign(globalThis, { __wicabyLiveMain: { ledger: () => this.session.snapshot(), suspend: () => this.suspend(), resume: () => this.resume() } });
  }

  private notice(key: string, params?: Record<string, string | number>): void {
    this.host.state.notice = { key, params, at: Date.now() };
    this.host.publish(true);
  }

  // ---- Hooks for playback-service.ts ----

  // openLive: tune a channel. Ladder and policy in live-session.ts; the channel being left keeps its
  // stream until the new first frame (adoptLive), then its Stopped report releases it (releaseLive).
  async openLive(seq: number, item: BaseItem, kind: 'mpv' | 'html', opts: StartOptions): Promise<void> {
    const h = this.host;
    this.wait?.fail('superseded');
    const sid = h.serverId;
    const api = h.deps.connection.apiFor(sid);
    const pb = h.deps.settings.value.playback;
    // A remote address or a mesh relay (the request URL is rewritten) takes the remote cap, from the first rung.
    const local = isLanAddress(api.address) && api.url('').startsWith(api.address);
    // X-02: the cap picked in the player's Quality sheet wins over the settings.
    const maxBitrate = opts.maxBitrate ?? Math.round((local ? pb.maxBitrateMbps : pb.maxBitrateRemoteMbps) * 1_000_000);
    // A picked preset caps the height too, as on the VOD path.
    const presetHeight = QUALITY_PRESETS.find((q) => q.bitrate === opts.maxBitrate)?.height;
    const maxHeight = presetHeight ? Math.min(presetHeight, pb.maxResolution || Infinity) : pb.maxResolution;
    const stale = () => seq !== h.seq;
    this.released = null;
    this.tuning++;
    let open: LiveOpen | null = null;
    try {
      open = await this.session.tune(
        {
          api,
          serverId: sid ?? '',
          channelId: item.Id,
          maxBitrate,
          deviceProfile: () => buildDeviceProfile(kind, maxBitrate, api.kind, maxHeight),
          startRung: opts.live?.rung,
          staticOk: kind === 'mpv',
          stale,
        },
        {
          hasCurrent: () => Boolean(this.prev || h.current?.live?.adopted),
          releaseCurrent: () => (this.prev ? this.releasePrev() : h.reportStopped()),
          play: (o) => this.load(seq, item, kind, o, opts),
        },
      );
    } catch (err) {
      if (stale()) return;
      const e = asLiveError(err);
      log.warn(`tune ${item.Name} failed: ${e.kind} ${e.message}`);
      // Make-before-break: back to the channel that is still open.
      if (await this.restorePrev()) return this.notice('player.live.zapFailed', { channel: item.Name });
      throw new Error(e.kind === 'failed' && e.message !== 'failed' ? e.message : t(liveErrorKey(e.kind)));
    } finally {
      this.tuning--;
    }
    const c = h.current;
    if (!open || stale() || c?.live?.open !== open) return;
    c.live.adopted = true;
    h.adoptLive(open.source.MediaStreams?.some((s) => s.Type === 'Video') ?? true);
    this.matchCadence(seq);
    await this.releasePrev();
    // The previous channel's timeshift file is closed now (mpv replaced the file).
    clearLiveCache(this.cacheDir);
  }

  // Stop: mpv has quit, so no cache file is held any more.
  clearCache(): void {
    clearLiveCache(this.cacheDir);
  }

  // releaseLive: before a Stopped report. False: send none (the ledger closed it, or it is released already).
  async releaseLive(c: Current): Promise<boolean> {
    if (c.live) {
      if (this.session.stopping(c.live.open, c.live.adopted)) return true;
      await this.session.closeUnadopted(c.live.open);
      return false;
    }
    // A programme or a recording in progress played through the VOD path.
    const id = c.source?.LiveStreamId;
    return !id || !this.session.has(id) || this.session.stopping({ liveStreamId: id }, true);
  }

  // After the Stopped report of a live stream: end its transcode (per server, off after one 404/405).
  async endEncode(c: Current): Promise<void> {
    if (c.live?.open.play.kind === 'transcode') await this.session.killEncodes(c.live.open.serverId, c.live.open.playSessionId);
  }

  // The VOD path opened a tuner stream (AutoOpenLiveStream or LiveStreams/Open): into the ledger, adopted
  // once it is the current item (adoptVod), closed if that start is superseded or fails (releasePrev).
  vodStream(api: ApiClient, serverId: string | undefined, itemId: string, playSessionId: string | undefined, ps: MediaSource, stale: boolean): boolean {
    this.session.recordVod(api, serverId ?? '', itemId, playSessionId ?? '', ps);
    if (stale) void this.session.closeOrphans();
    return !stale;
  }

  adoptVod(source: MediaSource | undefined): void {
    if (source?.LiveStreamId) this.session.adoptVod(source.LiveStreamId);
  }

  // Leaving live (or a stop): no tune waits any more.
  cancel(): void {
    this.wait?.fail('superseded');
    this.released = null;
    this.cadence.reset(); // stop restores the display mode
  }

  // startItem of anything that is not a channel: the live streams go now.
  async leave(): Promise<void> {
    this.wait?.fail('superseded');
    this.released = null;
    this.cadence.reset(); // the VOD path matches its own rate
    if (this.host.current?.live) await this.host.reportStopped();
    await this.releasePrev();
  }

  // The previous channel of a make-before-break zap, released by its Stopped report; and any stream
  // the VOD path opened for a start that never played.
  async releasePrev(): Promise<void> {
    const prev = this.prev;
    this.prev = null;
    if (prev) await this.host.reportStopped(prev.cur);
    await this.session.closeOrphans();
  }

  // Player events. True when live handled it.
  onEnded(): boolean {
    const c = this.host.current;
    // While a channel loads, the end is the stream being left (or a dead new one).
    if (c?.live && !c.live.adopted) this.wait?.fail('eof');
    else if (c?.live) void this.recover('eof');
    else return !c && this.tuning > 0;
    return true;
  }

  onFailure(message: string): boolean {
    const c = this.host.current;
    if (c?.live && !c.live.adopted) this.wait?.fail(message);
    else if (c?.live) void this.recover(message);
    else return !c && this.tuning > 0;
    return true;
  }

  // Adopted stream: a stall over 8 s re-tunes a rung lower; without timeshift a pause over 30 s
  // releases the tuner, with it the pause lasts the window (§8.8).
  onTime(u: TimeUpdate): void {
    const live = this.host.current?.live;
    if (!live?.adopted) return;
    const stalled = u.buffering && !u.paused;
    if (stalled && !this.stall) this.stall = setTimeout(() => ((this.stall = null), void this.recover('stall')), STALL_MS);
    else if (!stalled && this.stall) [this.stall] = [null, clearTimeout(this.stall)];
    // Without a usable window yet (no seekable range, no clock), the pause still releases after 30 s.
    const release = u.paused && !(live.ts?.win && live.ts.anchor);
    if (release && !this.pauseTimer) this.pauseTimer = setTimeout(() => ((this.pauseTimer = null), void this.releasePaused()), PAUSE_RELEASE_MS);
    else if (!release && this.pauseTimer) [this.pauseTimer] = [null, clearTimeout(this.pauseTimer)];
    if (live.ts) this.timeshiftTick(live, live.ts, u);
  }

  // ---- Timeshift (§8.8) ----

  private timeshiftTick(live: LiveCurrent, ts: LiveTimeshift, u: TimeUpdate): void {
    const now = Date.now();
    ts.pos = u.positionMs;
    if (!ts.anchor && !u.buffering && u.positionMs > 0) ts.anchor = { wall: now, pos: u.positionMs };
    ts.win = timeshiftWindow(u.positionMs, u.cache?.ranges ?? [], ts.plan.windowMs);
    if (!ts.win || !ts.anchor) return;
    // The pause outlasted the window, or the forward cache filled up: back to live.
    const full = ts.plan.mode === 'memory' && (u.cache?.fwBytes ?? 0) >= 0.95 * ts.plan.windowBytes;
    if (u.paused && now - this.fullAt > 3_000 && (u.positionMs < ts.win.start || full)) {
      this.fullAt = now;
      this.toEdge();
      this.notice('player.live.bufferFull');
      return;
    }
    // Disk mode: the cache file is append-only, so past its threshold it is reloaded at the edge (rebaseDue).
    // Same URL and LiveStreamId: no PlaybackInfo.
    const file = u.cache?.fileBytes ?? 0;
    const limit = rebaseBytes(ts.plan.windowBytes, this.rebaseOverride);
    if (ts.plan.mode !== 'disk' || file < limit) return;
    ts.overSince ||= now;
    ts.boundary ??= this.host.state.live?.now?.end ?? null;
    const atEdge = !u.paused && ts.win.end - u.positionMs <= TIMESHIFT_BEHIND_MS;
    if (!rebaseDue(file, limit, atEdge, now, ts.overSince, ts.boundary)) return;
    log.info(`timeshift cache at ${u.cache?.fileBytes} bytes: reloading the stream at the edge`);
    live.ts = freshTs(ts.plan);
    void this.host.player?.load(live.load).catch((err) => log.warn('timeshift rebase failed', err));
  }

  // Seek in live: the target clamped inside the window, or null without one (no seek).
  clampSeek(targetMs: number): number | null {
    const ts = this.host.current?.live?.ts;
    return ts?.win && ts.anchor ? clampLiveSeek(targetMs, ts.win, ts.pos) : null;
  }

  // "Revenir au direct" (End): to the edge of the window, playing.
  toEdge(): void {
    const p = this.host.player;
    const ts = this.host.current?.live?.ts;
    if (!p || this.command({ type: 'resume' })) return;
    if (ts?.win && ts.win.end - ts.pos > 2 * TIMESHIFT_EDGE_MARGIN_MS) p.seek(ts.win.end - TIMESHIFT_EDGE_MARGIN_MS);
    if (this.host.state.paused) p.play();
  }

  // LiveState.timeshift for the OSD timeline; undefined until the window and its clock exist.
  timeshift(): LiveState['timeshift'] {
    const ts = this.host.current?.live?.ts;
    if (!ts?.win || !ts.anchor) return undefined;
    return { ...timeshiftWall(ts.anchor, ts.pos, ts.win), windowMs: ts.plan.windowMs, ...(ts.plan.limited ? { limited: ts.plan.limited } : {}) };
  }

  // The released channel: the OSD keeps its live state and shows "Reprendre le direct" (pausedReleased).
  get releasedChannel(): Current | null {
    return this.released ? this.releasedCur : null;
  }

  // "Reprendre le direct": the paused (or slept) stream was released, so tune the channel again.
  command(cmd: PlaybackCommand): boolean {
    if (!this.released || (cmd.type !== 'toggle-pause' && cmd.type !== 'resume')) return false;
    this.released = null;
    void this.host.startItem({ player: this.host.player?.kind }).catch((err) => this.host.fail(err));
    return true;
  }

  // Track picks on a channel are kept for the session, not as a series default. True when live.
  rememberTrack(c: Current | null, kind: 'audio' | 'subtitle', index: number | null): boolean {
    if (!c?.live) return false;
    const stream = index === null ? null : (c.source?.MediaStreams ?? []).find((s) => s.Index === index);
    if (stream !== undefined) this.memory = rememberChoice(this.memory, `live:${c.serverId}`, kind, stream);
    return true;
  }

  clearTimers(): void {
    if (this.stall) clearTimeout(this.stall);
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.stall = this.pauseTimer = null;
  }

  // Quit, player window closed or crashed: every live stream still open is closed, pending tunes included (bounded).
  sweep(): Promise<void> {
    return this.session.sweep(QUIT_SWEEP_MS);
  }

  // ---- Player side ----

  // Loads one answer of the ladder and resolves on its first frame.
  private async load(seq: number, item: BaseItem, kind: 'mpv' | 'html', o: LiveOpen, opts: StartOptions): Promise<void> {
    const h = this.host;
    const sid = h.serverId;
    const api = h.deps.connection.apiFor(sid);
    let url: string | null;
    let ownOrigin = true;
    if (o.play.kind === 'static') {
      const { path, query } = o.play.req;
      url = kind === 'mpv' ? api.url(path, query) : mediaApiUrl(path + buildQuery(query), sid);
      const target = kind === 'mpv' ? await redirectTarget(api, url) : null;
      if (target) [url, ownOrigin] = [target, false];
    } else {
      ownOrigin = isServerOrigin(api, o.play.url);
      const rel = kind === 'mpv' ? null : serverPath(api, o.play.url);
      url = kind === 'mpv' ? resolveServerUrl(api, o.play.url) : rel === null ? null : mediaApiUrl(rel, sid);
    }
    if (!url) throw new LiveError('failed', t('errors.playback.noPlayMethod'));
    if (seq !== h.seq) throw new LiveError('superseded');
    const pb = h.deps.settings.value.playback;
    const streams = o.source.MediaStreams ?? [];
    const tracksFixed = o.play.kind === 'transcode';
    // The built-in player has no back buffer to seek in.
    const ts = kind === 'mpv' ? timeshiftPlan(h.deps.settings.live.timeshiftMinutes, o.source.Bitrate, () => freeBytes(this.cacheDir), this.cacheDir) : null;
    const picked = selectTracks(
      streams,
      { audio: o.source.DefaultAudioStreamIndex, subtitle: o.source.DefaultSubtitleStreamIndex },
      { audioLanguage: pb.preferredAudioLanguage, subtitleLanguage: pb.preferredSubtitleLanguage, mode: pb.subtitleMode, forced: pb.alwaysForced },
      this.memory[`live:${sid}`],
    );
    const load: LoadParams & { live: true; timeshift: [string, string][] } = {
      url,
      isHls: o.isHls,
      httpHeaders: kind === 'mpv' && ownOrigin ? api.mediaAuthHeaders() : [],
      startMs: 0,
      title: item.Name,
      volume: h.state.volume,
      muted: h.state.muted,
      audioIndex: tracksFixed ? null : picked.audio,
      subtitleIndex: tracksFixed ? null : picked.subtitle,
      embeddedAudio: streams.filter((s) => s.Type === 'Audio' && !s.IsExternal).map((s) => s.Index),
      embeddedSubtitles: streams.filter((s) => s.Type === 'Subtitle' && !s.IsExternal && s.DeliveryMethod !== 'External').map((s) => s.Index),
      externalSubtitles: [],
      tracksFixed,
      hdr: hdrFromStream(streams.find((s) => s.Type === 'Video')),
      rate: 1,
      live: true,
      timeshift: ts?.options ?? [],
    };
    const player = await h.ensurePlayer(kind);
    if (seq !== h.seq) throw new LiveError('superseded');
    const session = h.deps.connection.sessionFor(sid);
    // Make-before-break: the adopted channel keeps its tuner until this one shows a frame.
    if (h.current?.live?.adopted) this.prev = { cur: h.current, state: h.state };
    h.current = {
      item,
      source: o.source,
      playSessionId: o.playSessionId,
      playMethod: o.playMethod,
      offline: false,
      serverId: sid,
      userId: session?.user?.id ?? session?.server.userId,
      audioIndex: load.audioIndex,
      subtitleIndex: load.subtitleIndex,
      kind,
      trailer: false,
      live: { open: o, adopted: false, steps: opts.live?.steps ?? 0, load, ts: ts && ts.mode !== 'off' ? freshTs(ts) : undefined },
    };
    h.state = {
      ...idle(h.state.volume, h.state.muted),
      active: true,
      player: kind,
      item: nowPlaying(item, sid),
      buffering: true,
      audioTracks: streams.filter((s) => s.Type === 'Audio').map(toTrack),
      subtitleTracks: streams.filter((s) => s.Type === 'Subtitle').map(toTrack),
      audioIndex: load.audioIndex,
      subtitleIndex: load.subtitleIndex,
      playMethod: o.playMethod,
      queueIndex: h.queue.index,
      queueLength: h.queue.length,
      fullscreen: player.isFullscreen(),
      rate: 1,
      aspect: h.state.aspect,
      // A notice raised during the tune ("tuner released", "recovering") stays visible.
      notice: h.state.notice,
    };
    h.publish(true);
    log.info(`tuning ${item.Name} with ${kind} (rung ${o.rung}, ${o.playMethod})`);
    const loadedAt = Date.now();
    const busy = async (message: string, elapsed: number): Promise<boolean> =>
      elapsed <= 3_000 && (isBusyStream(message, elapsed) || isBusyStream(`HTTP ${await streamStatus(api, load.url, ownOrigin)}`, elapsed));
    await new Promise<void>((resolve, reject) => {
      const done = (err?: LiveError) => {
        clearTimeout(timer);
        player.off('first-frame', onFrame);
        player.off('time', onTime);
        if (this.wait === wait) this.wait = null;
        if (err) reject(err);
        else resolve();
      };
      const onFrame = () => done();
      // The built-in player has no first-frame event: time moving while not buffering.
      const onTime = (u: TimeUpdate) => player.kind === 'html' && !u.buffering && !u.paused && u.positionMs > 0 && done();
      const wait = {
        fail: (message: string) => {
          if (message === 'superseded') return done(new LiveError('superseded'));
          const elapsed = Date.now() - loadedAt;
          if (this.wait === wait) this.wait = null;
          // The probe is async: a newer tune or a stop meanwhile wins (done() runs once).
          void busy(message, elapsed).then((b) => done(new LiveError(b ? 'busy' : 'play', message)));
        },
      };
      const timer = setTimeout(() => done(new LiveError('play', 'no first frame')), FIRST_FRAME_MS);
      this.wait?.fail('superseded');
      this.wait = wait;
      player.on('first-frame', onFrame);
      player.on('time', onTime);
      player.load(load).catch((err: unknown) => wait.fail(err instanceof Error ? err.message : String(err)));
    });
  }

  // §21.5: the cadence mpv measured on the first decoded frames (estimated-vf-fps, after deinterlacing), not
  // MediaStream.RealFrameRate (DVB and IPTV say 25 for 50i). Follows the VOD setting "match refresh rate".
  private matchCadence(seq: number): void {
    const h = this.host;
    const player = h.player;
    if (player?.kind !== 'mpv' || !h.deps.settings.value.playback.matchRefreshRate) return;
    const since = Date.now();
    const off = () => (clearTimeout(timer), player.off('stats', onStats));
    const onStats = (s: PlaybackStats) => {
      if (seq !== h.seq || h.player !== player) return off();
      if (Date.now() - since < CADENCE_SETTLE_MS || !s.frameRate) return;
      off();
      const hz = this.cadence.next(s.frameRate);
      log.info(`cadence ${s.frameRate} fps: ${hz ? `display ${hz} Hz` : 'mode kept'}`);
      if (hz) void h.deps.display.matchContent(player.hostWindow, hz);
    };
    // Radio, or no estimate: give up.
    const timer = setTimeout(off, 5 * CADENCE_SETTLE_MS);
    player.on('stats', onStats);
  }

  // Every rung failed: play the previous channel again (its stream is still open). False when there is none.
  private async restorePrev(): Promise<boolean> {
    const h = this.host;
    const prev = this.prev;
    const back = prev?.cur ?? (h.current?.live?.adopted ? h.current : null);
    if (!back?.live) return false;
    h.setQueue(back.item.Id, back.serverId);
    if (prev) {
      this.prev = null;
      // The failed attempt, if still current, was closed by the ladder.
      h.current = prev.cur;
      h.state = { ...prev.state, notice: h.state.notice };
      if (back.live.ts) back.live.ts = freshTs(back.live.ts.plan); // reloaded: a new buffer
      await h.player?.load(back.live.load).catch((err) => log.warn('previous channel reload failed', err));
    }
    return true;
  }

  private async releasePaused(): Promise<void> {
    const h = this.host;
    if (!h.current?.live?.adopted || !h.state.paused || this.tuning) return;
    this.clearTimers();
    this.releasedCur = h.current;
    await h.reportStopped();
    this.released = 'pause';
    this.notice('player.live.pausedReleased');
  }

  // Stall, demuxer error or end of an adopted stream: release it and tune the channel again a rung
  // lower, at most two steps per tune.
  private async recover(reason: string): Promise<void> {
    const h = this.host;
    const c = h.current;
    if (!c?.live?.adopted || this.tuning) return;
    this.clearTimers();
    const steps = c.live.steps + 1;
    log.warn(`live stream lost (${reason}) on ${c.item.Name}, recovery step ${steps}`);
    if (steps > 2) return h.fail(new Error(t('errors.livetv.noStream')));
    this.notice('player.live.recovering');
    await h.reportStopped();
    await h.startItem({ player: c.kind, live: { rung: Math.min(2, c.live.open.rung + 1) as Rung, steps } }).catch((err) => h.fail(err));
  }

  // System sleep: Stopped report and ledger sweep now; on resume, "Reprendre le direct" re-tunes.
  private async suspend(): Promise<void> {
    const h = this.host;
    if (!h.current?.live && !this.prev && !this.tuning) return;
    this.releasedCur = h.current;
    h.supersede();
    this.wait?.fail('superseded');
    this.clearTimers();
    h.player?.pause();
    await h.reportStopped();
    await this.releasePrev();
    await this.sweep();
    this.released = 'sleep';
  }

  private resume(): void {
    if (this.released === 'sleep' && this.host.state.active) this.notice('player.live.resumedAfterSleep');
  }
}
