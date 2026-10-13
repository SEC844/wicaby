// Live TV session plumbing (livetv-spec-final.md §5.3, §8.1, §8.2, §8.9, §21.3): the tune ladder,
// LiveStreams Open and Close, the release ledger and the make-before-break / break-before-make
// policy. The playback service owns the player and the reports; this module decides what to ask
// the server, which URL to play, and which stream must be released and how.
//
// Ledger rule: every LiveStreamId is released exactly once. An adopted stream (its first frame was
// shown) is released by its Stopped report; any other one (superseded, timed out, late, failed rung,
// abandoned at quit) by POST /LiveStreams/Close with the ids in the query string. A stream that was
// never adopted never gets a Stopped report.
//
// No Electron import (types only): tools/checks drive this file against the mock with Node.
import fs from 'node:fs';
import path from 'node:path';
import { close as closeReq, killEncodes as killReq, open as openReq, staticStream, tune as tuneReq, type Req } from '../../shared/livetv/dialect';
import type { ServerKind } from '../../shared/livetv/model';
import type { MediaSource, PlaybackInfoResponse } from '../../shared/models';
import type { LiveSettings } from '../core/settings';

export type Rung = 0 | 1 | 2;
export type ZapPolicy = 'mbb' | 'bbm';
export type PlayMethodLive = 'DirectPlay' | 'DirectStream' | 'Transcode';

// mpv file-local options for a live stream (§8.9), passed with loadfile so VOD defaults stay as they are.
export const LIVE_MPV_OPTIONS: readonly (readonly [string, string])[] = [
  // DVB and HDHomeRun are 1080i / 576i; auto only deinterlaces interlaced frames.
  ['deinterlace', 'auto'],
  // Faster MPEG-TS start.
  ['demuxer-lavf-probesize', '1000000'],
  ['demuxer-lavf-analyzeduration', '1'],
  // First frame as soon as there is one (LT-25).
  ['cache-pause-initial', 'no'],
  // HLS rungs: the best variant.
  ['hls-bitrate', 'max'],
];

// ---- Timeshift (§8.8): mpv back buffer, wall-clock mapping, disk cache lifecycle ----

const GIB = 1024 ** 3;
// Memory mode: back + forward bytes never above 1 GiB of RAM, so each side gets half (a pause can last the window).
export const TIMESHIFT_MEMORY_CAP = GIB;
export const TIMESHIFT_MEMORY_MAX_MIN = 15; // above this, disk mode
export const TIMESHIFT_DEFAULT_BPS = 12_000_000; // when MediaSource.Bitrate is missing
export const TIMESHIFT_BEHIND_MS = 15_000; // "Revenir au direct" only further behind than this
export const TIMESHIFT_EDGE_MARGIN_MS = 2_000; // a seek never lands closer to the edge than this
export const REBASE_EDGE_MS = 10 * 60_000; // rebase this long after the threshold without a programme boundary
export const REBASE_FORCE = 1.05; // past threshold × this, rebase at the edge now (S21b: file ≤ 1.1 × threshold)

export interface TimeshiftPlan {
  mode: 'off' | 'memory' | 'disk';
  windowMs: number;
  windowBytes: number;
  // File-local mpv options (values may hold a path: the player quotes them).
  options: [string, string][];
  // Why the window is shorter than the setting: the 1 GiB memory cap, or too little disk space.
  limited?: 'memory' | 'space';
}

// minutes: live.timeshiftMinutes. freeBytes: free space under the cache dir (asked only above 15 min).
export function timeshiftPlan(minutes: number, bitrate: number | undefined, freeBytes: () => number, cacheDir: string): TimeshiftPlan {
  if (!(minutes > 0)) return { mode: 'off', windowMs: 0, windowBytes: 0, options: [] };
  const bytesPerS = ((bitrate && bitrate > 0 ? bitrate : TIMESHIFT_DEFAULT_BPS) / 8) * 1.2;
  const want = minutes * 60 * bytesPerS;
  const disk = minutes > TIMESHIFT_MEMORY_MAX_MIN && freeBytes() >= 3 * want + 2 * GIB;
  const bytes = Math.round(disk ? want : Math.min(Math.min(minutes, TIMESHIFT_MEMORY_MAX_MIN) * 60 * bytesPerS, TIMESHIFT_MEMORY_CAP / 2));
  const limited = minutes > TIMESHIFT_MEMORY_MAX_MIN && !disk ? 'space' : bytes < want ? 'memory' : undefined;
  return {
    mode: disk ? 'disk' : 'memory',
    windowMs: Math.round((bytes / bytesPerS) * 1000),
    windowBytes: bytes,
    options: [
      ['demuxer-seekable-cache', 'yes'],
      ['force-seekable', 'yes'],
      ['demuxer-max-back-bytes', String(bytes)],
      // Forward too, so a pause can last the whole window before the read stops.
      ['demuxer-max-bytes', String(bytes)],
      ...(disk ? ([['cache-on-disk', 'yes'], ['demuxer-cache-dir', cacheDir]] as [string, string][]) : []),
    ],
    ...(limited ? { limited } : {}),
  };
}

// The disk cache file is append-only: past this size it is rebased (reloaded) at the edge.
export function rebaseBytes(windowBytes: number, override?: number): number {
  return override && override > 0 ? override : Math.max(4 * windowBytes, 4 * GIB);
}

// Due at the edge once past the threshold: at the programme boundary, 10 min after the crossing, or at
// once past REBASE_FORCE × the threshold, so the file stays under 1.1 × it (S21b).
export function rebaseDue(fileBytes: number, limit: number, atEdge: boolean, now: number, overSince: number, boundary: number | null): boolean {
  return fileBytes >= limit && atEdge && (fileBytes >= REBASE_FORCE * limit || now >= (boundary ?? Infinity) || now - overSince >= REBASE_EDGE_MS);
}

// The seekable window around the playback position (ms of player time), from mpv's seekable ranges,
// at most windowMs long. Null while nothing is cached.
export function timeshiftWindow(posMs: number, ranges: readonly (readonly [number, number])[], windowMs: number): { start: number; end: number } | null {
  const r = ranges.find(([a, b]) => posMs >= a - 1_000 && posMs <= b + 1_000) ?? ranges.at(-1);
  if (!r || r[1] <= r[0]) return null;
  return { start: Math.max(r[0], r[1] - windowMs), end: r[1] };
}

// A seek target clamped inside the window (never past the edge margin). Null: no seek, as at the edge
// playback runs past win.end (the last keyframe) and a forward seek would clamp behind the position.
export function clampLiveSeek(targetMs: number, win: { start: number; end: number }, posMs: number): number | null {
  const to = Math.max(win.start, Math.min(win.end - TIMESHIFT_EDGE_MARGIN_MS, targetMs));
  return targetMs > posMs && to <= posMs ? null : to;
}

// wallAt(pos) = tuneWall + (pos − firstPos): the anchor is the first position seen after the first frame.
// mpv's seekable end is the last keyframe, so at the edge playback runs up to a GOP past it.
export function timeshiftWall(anchor: { wall: number; pos: number }, posMs: number, win: { start: number; end: number }) {
  const wallAt = (p: number) => Math.round(anchor.wall + (p - anchor.pos));
  const edge = Math.max(win.end, posMs);
  return { startWall: wallAt(win.start), endWall: wallAt(edge), posWall: wallAt(posMs), atEdge: edge - posMs <= TIMESHIFT_BEHIND_MS };
}

export function freeBytes(dir: string): number {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return 0; // unknown: memory mode
  }
}

// <userData>/live-cache: emptied at startup, on a zap and at stop. A file mpv still holds open
// (the current channel's, on Windows) cannot be removed and is left for the next pass.
export function clearLiveCache(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    try {
      fs.rmSync(path.join(dir, n), { force: true, recursive: true });
    } catch {
      // in use
    }
  }
}

// ---- Display mode for live (§21.5, DM-1) ----

export type CadenceFamily = 24 | 50 | 60;
export const CADENCE_SETTLE_MS = 1_000; // mpv's estimated-vf-fps needs a few frames after the first one

// The family of a cadence measured on the decoded frames (frames or fields per second), and the display rate
// it wants: 25i/50p → 50 Hz, 29.97i/59.94p → 59.94 Hz, 23.976/24 → 23.976/24 Hz. Null: unknown cadence.
export function cadenceTarget(fps: number | undefined): { family: CadenceFamily; hz: number } | null {
  if (!fps || !(fps >= 10)) return null;
  for (const [base, family] of [[24, 24], [25, 50], [30, 60]] as const) {
    for (const k of [1, 2, 4]) {
      const r = fps / (base * k);
      if (Math.abs(r - 1) < 0.015) return { family, hz: Math.round(family * r * 1000) / 1000 };
    }
  }
  return null;
}

// A mode switch blanks HDMI for 1–3 s: switch only when the family changes, never inside one.
export class CadenceGate {
  family: CadenceFamily | null = null;
  // The display rate to switch to, or null to keep the mode.
  next(fps: number | undefined): number | null {
    const c = cadenceTarget(fps);
    if (!c || c.family === this.family) return null;
    this.family = c.family;
    return c.hz;
  }
  reset(): void {
    this.family = null;
  }
}

export const TUNE_TIMEOUT_MS = 15_000; // PlaybackInfo and Open, then the tune is abandoned
export const LATE_LIMIT_MS = 120_000; // how long an abandoned request is still awaited to close its answer
export const FIRST_FRAME_MS = 12_000;
export const STALL_MS = 8_000;
export const PAUSE_RELEASE_MS = 30_000; // live.pauseReleaseS, fixed in v1
export const QUIT_SWEEP_MS = 1_500;
export const CLOSE_RETRY_MS = 2_000;
export const POLICY_MEMORY_MS = 7 * 86_400_000;

// The part of ApiClient this module uses (a fake in the checks).
export interface LiveApi {
  readonly kind: ServerKind;
  readonly userId?: string;
  request<T>(method: string, path: string, query?: Record<string, string>, body?: unknown, timeoutMs?: number): Promise<T>;
}

export type LiveFailure = 'busy' | 'timeout' | 'failed' | 'no-stream' | 'superseded' | 'play';

export class LiveError extends Error {
  readonly kind: LiveFailure;
  constructor(kind: LiveFailure, message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

// The errors.* key shown when a tune ends in this failure (a message of its own wins for 'failed').
export function liveErrorKey(kind: LiveFailure): string {
  return kind === 'busy' ? 'errors.livetv.tunerBusy' : kind === 'timeout' ? 'errors.livetv.tuneTimeout' : 'errors.livetv.noStream';
}

export const asLiveError = (err: unknown): LiveError =>
  err instanceof LiveError ? err : new LiveError('failed', err instanceof Error ? err.message : String(err));

// ---- Tuner-busy classification (§8.2) ----

// Broad on purpose (its only effect is "release the old stream and retry once"), but a plain tuner
// error ("Error opening the tuner stream") is a failed rung, not a busy pool.
const BUSY_TEXT = /\bno\b.*\b(available|free)\b|\b(available|free)\b.*\btuners?\b|\btuners?\b.*\b(busy|in use|unavailable|available|limit)|conflict|limit|maximum/i;
const BUSY_CODES = new Set(['NoCompatibleStream', 'RateLimitExceeded']);

export type AnswerClass = 'ok' | 'busy' | 'refused' | 'empty';

// A PlaybackInfo answer on a live channel. otherAdopted: another live stream of ours is open.
export function classifyAnswer(info: Partial<PlaybackInfoResponse> | null | undefined, otherAdopted: boolean): AnswerClass {
  if (info?.ErrorCode) return BUSY_CODES.has(info.ErrorCode) ? 'busy' : 'refused';
  if (!info?.MediaSources?.length) return otherAdopted ? 'busy' : 'empty';
  return 'ok';
}

// An HTTP error from PlaybackInfo or LiveStreams/Open.
export function isBusyHttp(status: number, text: string): boolean {
  return (status === 409 || status === 500 || status === 503) && BUSY_TEXT.test(text);
}

// The stream URL answering 503 or 429 right after the load.
export function isBusyStream(message: string, msSinceLoad: number): boolean {
  return msSinceLoad <= 3_000 && /\b(503|429)\b/.test(message);
}

// ---- What to play (§8.1 pick) ----

export interface LiveOpen {
  serverId: string;
  channelId: string;
  rung: Rung;
  playSessionId: string;
  liveStreamId?: string;
  source: MediaSource;
  // static: /Videos/{id}/stream.{container}?Static=true… (direct play, or a DirectStream-only tuner).
  play: { kind: 'static'; req: Req } | { kind: 'transcode'; url: string };
  playMethod: PlayMethodLive;
  isHls: boolean;
}

export function pickPlay(
  ps: MediaSource,
  a: { channelId: string; rung: Rung; deviceId: string; playSessionId: string; staticOk: boolean; kind: ServerKind },
): Pick<LiveOpen, 'play' | 'playMethod' | 'isHls'> | null {
  const container = (ps.Container ?? '').split(',')[0].trim().toLowerCase();
  const stat = (): { kind: 'static'; req: Req } => ({
    kind: 'static',
    req: staticStream(a.kind, {
      itemId: a.channelId,
      container: /^[a-z0-9]{1,10}$/.test(container) ? container : 'ts',
      mediaSourceId: ps.Id,
      liveStreamId: ps.LiveStreamId,
      deviceId: a.deviceId,
      playSessionId: a.playSessionId,
    }),
  });
  if (a.rung === 0 && ps.SupportsDirectPlay) return { play: stat(), playMethod: 'DirectPlay', isHls: false };
  if (ps.TranscodingUrl) {
    const isHls = (ps.TranscodingSubProtocol ?? '').toLowerCase() === 'hls' || /\.m3u8/i.test(ps.TranscodingUrl);
    return { play: { kind: 'transcode', url: ps.TranscodingUrl }, playMethod: /videocodec=copy/i.test(ps.TranscodingUrl) ? 'DirectStream' : 'Transcode', isHls };
  }
  // DirectStream-only sources (HDHomeRun, tvheadend): the same static URL. This was noPlayMethod.
  if (a.staticOk && ps.SupportsDirectStream) return { play: stat(), playMethod: 'DirectStream', isHls: false };
  if (a.staticOk && ps.SupportsDirectPlay) return { play: stat(), playMethod: 'DirectPlay', isHls: false };
  return null;
}

// ---- Ledger ----

export interface LedgerEntry {
  id: string;
  serverId: string;
  channelId: string;
  playSessionId: string;
  adopted: boolean;
  released: 'stop' | 'close' | null;
  transcoding: boolean;
  openedAt: number;
  // Why it was closed without being adopted.
  note?: 'superseded' | 'late' | 'failed' | 'busy' | 'sweep';
  // Opened by the VOD path (a programme, a recording in progress), not by a tune.
  vod?: true;
}

export interface LedgerSnapshot {
  at: number;
  open: LedgerEntry[];
  recent: LedgerEntry[];
  counters: Record<string, number>;
  killEncodesOff: string[];
  policy: Record<string, ZapPolicy>;
}

export interface LiveDeps {
  deviceId: string;
  settings(): LiveSettings;
  // Learned break-before-make for a server (until = epoch ms), or null to forget it.
  saveReleaseFirst(serverId: string, until: number | null): void;
  // A player notice (player.live.* key) for the OSD.
  notice(key: string, params?: Record<string, string | number>): void;
  // The client of a server for Close / killEncodes; null when it is offline.
  api(serverId: string): LiveApi | null;
  log: { info(msg: string): void; warn(msg: string, err?: unknown): void; debug(msg: string): void };
  // Dev builds: the ledger after each change (mock assertions, §16.3).
  devExport?: ((snap: LedgerSnapshot) => void) | null;
  now?: () => number;
}

export interface TuneRequest {
  api: LiveApi;
  serverId: string;
  channelId: string;
  maxBitrate: number;
  deviceProfile: (rung: Rung) => unknown;
  startRung?: Rung;
  // False for the built-in player, which cannot play a raw TS stream.
  staticOk: boolean;
  // A newer start (or a stop) superseded this tune.
  stale(): boolean;
}

export interface TuneHooks {
  // An adopted live stream of ours is still open (the channel being left).
  hasCurrent(): boolean;
  // Release it now (its Stopped report): break-before-make, or a busy tuner.
  releaseCurrent(): Promise<void>;
  // Load the answer and resolve on its first frame; reject with a LiveError otherwise.
  play(open: LiveOpen): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveSession {
  private readonly deps: LiveDeps;
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly apis = new Map<string, LiveApi>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly killEncodesOff = new Set<string>();
  // The rung that last played each channel (server/channel), for the session (§8.1).
  private readonly rungs = new Map<string, Rung>();
  private readonly counters: Record<string, number> = {
    tunes: 0,
    opened: 0,
    adopted: 0,
    stops: 0,
    closes: 0,
    closeErrors: 0,
    late: 0,
    superseded: 0,
    busy: 0,
    timeouts: 0,
    failedRungs: 0,
    killEncodes: 0,
    doubleReleaseAttempts: 0,
  };
  private exportTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: LiveDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- Zap policy (§8.1): Auto learns break-before-make per server for 7 days ----

  policy(serverId: string): ZapPolicy {
    const s = this.deps.settings();
    if (s.release === 'always') return 'bbm';
    if (s.release === 'never') return 'mbb';
    return (s.releaseFirst[serverId]?.until ?? 0) > this.now() ? 'bbm' : 'mbb';
  }

  // Returns true on the first learn (the caller shows the toast once).
  private learnBbm(serverId: string): boolean {
    if (this.deps.settings().release !== 'auto') return false;
    const first = this.policy(serverId) === 'mbb';
    this.deps.saveReleaseFirst(serverId, this.now() + POLICY_MEMORY_MS);
    return first;
  }

  // ---- Tune: policy, negotiation, ladder (§8.1) ----

  // Resolves with the adopted stream, or null when superseded. Rejects with a LiveError once every
  // rung failed; the caller then restores the previous channel (make-before-break) or shows the error.
  async tune(t: TuneRequest, hooks: TuneHooks): Promise<LiveOpen | null> {
    this.counters.tunes++;
    this.apis.set(t.serverId, t.api);
    const canRelease = () => hooks.hasCurrent() && this.deps.settings().release !== 'never';
    if (this.policy(t.serverId) === 'bbm' && hooks.hasCurrent()) await hooks.releaseCurrent();
    let rung: Rung = t.startRung ?? this.rungs.get(`${t.serverId}/${t.channelId}`) ?? 0;
    let retried = false;
    let last: LiveError | null = null;
    // One release-and-retry per tune when the pool is full (§8.2).
    const busyRetry = async (): Promise<boolean> => {
      if (retried || !canRelease()) return false;
      retried = true;
      this.deps.log.info(`no free tuner on ${t.serverId}: releasing the current channel and retrying`);
      if (this.learnBbm(t.serverId)) this.deps.notice('player.live.tunerReleased');
      await hooks.releaseCurrent();
      return true;
    };
    for (;;) {
      if (t.stale()) return null;
      let open: LiveOpen;
      try {
        open = await this.negotiate(t, rung, hooks.hasCurrent());
      } catch (err) {
        const e = asLiveError(err);
        if (e.kind === 'superseded' || t.stale()) return null;
        if (e.kind === 'busy') {
          if (await busyRetry()) continue;
          throw e;
        }
        // A tune that timed out is abandoned (its late answer is closed on arrival).
        if (e.kind === 'timeout') throw e;
        last = e;
        this.counters.failedRungs++;
        if (rung >= 2) throw last;
        rung = (rung + 1) as Rung;
        continue;
      }
      try {
        await hooks.play(open);
      } catch (err) {
        const e = asLiveError(err);
        await this.closeUnadopted(open, e.kind === 'superseded' ? 'superseded' : 'failed');
        if (e.kind === 'superseded' || t.stale()) return null;
        if (e.kind === 'busy' && (await busyRetry())) continue;
        last = e;
        this.counters.failedRungs++;
        this.deps.log.warn(`live rung ${rung} failed for ${t.channelId}: ${e.message}`);
        if (rung >= 2) throw last;
        rung = (rung + 1) as Rung;
        continue;
      }
      if (t.stale()) {
        await this.closeUnadopted(open, 'superseded');
        return null;
      }
      this.adopt(open);
      return open;
    }
  }

  // PlaybackInfo (AutoOpenLiveStream), then Open when the source requires it, then the URL pick.
  private async negotiate(t: TuneRequest, rung: Rung, otherAdopted: boolean): Promise<LiveOpen> {
    const { api } = t;
    const userId = api.userId ?? '';
    const profile = t.deviceProfile(rung);
    const pbi = tuneReq(api.kind, { userId, channelId: t.channelId, maxBitrate: t.maxBitrate, rung, deviceProfile: profile });
    const info = await this.answer<PlaybackInfoResponse>(api, pbi, (late) => void this.closeAnswer(t, late?.MediaSources ?? [], late?.PlaySessionId, 'late'));
    if (t.stale()) {
      await this.closeAnswer(t, info?.MediaSources ?? [], info?.PlaySessionId, 'superseded');
      throw new LiveError('superseded');
    }
    const cls = classifyAnswer(info, otherAdopted);
    if (cls !== 'ok') {
      await this.closeAnswer(t, info?.MediaSources ?? [], info?.PlaySessionId, cls === 'busy' ? 'busy' : 'failed');
      if (cls === 'busy') {
        this.counters.busy++;
        throw new LiveError('busy', info?.ErrorCode);
      }
      throw new LiveError(cls === 'empty' ? 'no-stream' : 'failed', info?.ErrorCode);
    }
    const playSessionId = info.PlaySessionId ?? '';
    let ps = info.MediaSources[0];
    // Only the first source is played; any other one the server opened is closed now.
    await this.closeAnswer(t, info.MediaSources.slice(1), playSessionId, 'failed');
    this.record(t, ps, playSessionId);
    if (ps.RequiresOpening && !ps.LiveStreamId) {
      const o = openReq(api.kind, { userId, itemId: t.channelId, playSessionId, maxBitrate: t.maxBitrate, openToken: ps.OpenToken ?? '', deviceProfile: profile });
      const opened = await this.answer<{ MediaSource?: MediaSource } | undefined>(api, o, (late) => void this.closeAnswer(t, late?.MediaSource ? [late.MediaSource] : [], playSessionId, 'late'));
      if (t.stale()) {
        await this.closeAnswer(t, opened?.MediaSource ? [opened.MediaSource] : [], playSessionId, 'superseded');
        throw new LiveError('superseded');
      }
      if (!opened?.MediaSource) {
        if (otherAdopted) {
          this.counters.busy++;
          throw new LiveError('busy');
        }
        throw new LiveError('failed');
      }
      ps = opened.MediaSource;
      this.record(t, ps, playSessionId);
    }
    const pick = pickPlay(ps, { channelId: t.channelId, rung, deviceId: this.deps.deviceId, playSessionId, staticOk: t.staticOk, kind: api.kind });
    const open: LiveOpen | null = pick ? { serverId: t.serverId, channelId: t.channelId, rung, playSessionId, liveStreamId: ps.LiveStreamId, source: ps, ...pick } : null;
    if (!open) {
      await this.closeAnswer(t, [ps], playSessionId, 'failed');
      throw new LiveError('no-stream');
    }
    // The transcode flag decides killEncodes for an abandoned stream.
    const e = ps.LiveStreamId ? this.ledger.get(ps.LiveStreamId) : undefined;
    if (e) e.transcoding = open.play.kind === 'transcode';
    return open;
  }

  // A request with the tune deadline. After it the tune is abandoned, but the request keeps going so
  // that a late answer can still be closed (onLate).
  private answer<T>(api: LiveApi, r: Req, onLate: (late: T) => void): Promise<T> {
    const p = api.request<T>(r.method, r.path, r.query, r.body, LATE_LIMIT_MS);
    this.track(p);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        this.counters.timeouts++;
        reject(new LiveError('timeout'));
      }, TUNE_TIMEOUT_MS);
      p.then(
        (v) => {
          clearTimeout(timer);
          if (!done) {
            done = true;
            resolve(v);
            return;
          }
          this.counters.late++;
          this.deps.log.info(`late ${r.path} answer: closing it`);
          onLate(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (done) return;
          done = true;
          const status = (err as { status?: number })?.status ?? 0;
          const text = err instanceof Error ? err.message : String(err);
          if (isBusyHttp(status, text)) {
            this.counters.busy++;
            reject(new LiveError('busy', text));
          } else reject(new LiveError('failed', text));
        },
      );
    });
  }

  private track<T>(p: Promise<T>): void {
    const settled = p.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    void settled.then(() => this.inflight.delete(settled));
  }

  private record(t: Pick<TuneRequest, 'serverId' | 'channelId'>, ps: MediaSource, playSessionId: string): void {
    const id = ps.LiveStreamId;
    if (!id || this.ledger.has(id)) return;
    this.counters.opened++;
    this.ledger.set(id, {
      id,
      serverId: t.serverId,
      channelId: t.channelId,
      playSessionId,
      adopted: false,
      released: null,
      transcoding: Boolean(ps.TranscodingUrl),
      openedAt: this.now(),
    });
    this.changed();
  }

  // Every stream in an answer that will not be played.
  private async closeAnswer(t: TuneRequest, sources: readonly MediaSource[], playSessionId: string | undefined, note: LedgerEntry['note']): Promise<void> {
    for (const ps of sources) {
      if (!ps?.LiveStreamId) continue;
      this.record(t, ps, playSessionId ?? '');
      await this.closeId(ps.LiveStreamId, note);
    }
  }

  // ---- VOD path: a programme or a recording in progress can come with a tuner stream ----

  recordVod(api: LiveApi, serverId: string, itemId: string, playSessionId: string, ps: MediaSource): void {
    if (!ps.LiveStreamId) return;
    this.apis.set(serverId, api);
    this.record({ serverId, channelId: itemId }, ps, playSessionId);
    const e = this.ledger.get(ps.LiveStreamId);
    if (e && !e.released) e.vod = true;
  }

  // It became the current item: its Stopped report releases it.
  adoptVod(id: string): void {
    const e = this.ledger.get(id);
    if (!e?.vod || e.released) return;
    e.adopted = true;
    this.changed();
  }

  // A VOD start that never played (superseded, failed): its streams are closed.
  async closeOrphans(): Promise<void> {
    for (const e of [...this.ledger.values()]) if (e.vod && !e.adopted && !e.released) await this.closeId(e.id, 'superseded');
  }

  has(liveStreamId: string): boolean {
    return this.ledger.has(liveStreamId);
  }

  private adopt(o: LiveOpen): void {
    this.counters.adopted++;
    this.rungs.set(`${o.serverId}/${o.channelId}`, o.rung);
    const e = o.liveStreamId ? this.ledger.get(o.liveStreamId) : undefined;
    if (e) e.adopted = true;
    this.changed();
  }

  // ---- Release ----

  // Before a Stopped report: true when this report releases the stream (adopted, not yet released),
  // and the ledger then counts it as released by 'stop'. False: send no Stopped report.
  stopping(o: Pick<LiveOpen, 'liveStreamId'>, adopted: boolean): boolean {
    if (!o.liveStreamId) return adopted;
    const e = this.ledger.get(o.liveStreamId);
    if (!e || !e.adopted) return false;
    if (e.released) {
      this.counters.doubleReleaseAttempts++;
      return false;
    }
    e.released = 'stop';
    this.counters.stops++;
    this.changed();
    return true;
  }

  // A stream that was never adopted (or one whose Stopped report is no longer possible).
  closeUnadopted(o: LiveOpen, note: LedgerEntry['note'] = 'failed'): Promise<void> {
    return o.liveStreamId ? this.closeId(o.liveStreamId, note) : Promise.resolve();
  }

  private closeId(id: string, note: LedgerEntry['note']): Promise<void> {
    const e = this.ledger.get(id);
    if (!e) return Promise.resolve();
    if (e.released) {
      if (e.released === 'close' || !e.adopted) return Promise.resolve();
      this.counters.doubleReleaseAttempts++;
      return Promise.resolve();
    }
    e.released = 'close';
    e.note = note;
    if (note === 'superseded') this.counters.superseded++;
    this.changed();
    const p = this.sendClose(e);
    this.track(p);
    return p;
  }

  // Query string only (a body gives 400); 404 means it is gone already; other errors: one retry after 2 s.
  private async sendClose(e: LedgerEntry): Promise<void> {
    const api = this.deps.api(e.serverId) ?? this.apis.get(e.serverId);
    if (!api) {
      this.deps.log.warn(`live stream ${e.id}: server ${e.serverId} offline, cannot close it`);
      return;
    }
    const r = closeReq(api.kind, { liveStreamId: e.id, playSessionId: e.playSessionId });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api.request(r.method, r.path, r.query, undefined, 10_000);
        this.counters.closes++;
        break;
      } catch (err) {
        const status = (err as { status?: number })?.status ?? 0;
        if (status === 404) break;
        this.counters.closeErrors++;
        this.deps.log.warn(`LiveStreams/Close ${e.id} failed (attempt ${attempt + 1})`, err);
        if (attempt === 0) await sleep(CLOSE_RETRY_MS);
      }
    }
    if (e.transcoding) await this.killEncodes(e.serverId, e.playSessionId);
    this.changed();
  }

  // Best effort, and off for a server after one 404/405 (Jellyfin 12.2 dropped the route; its Close
  // and Stopped already end the transcode).
  async killEncodes(serverId: string, playSessionId: string): Promise<void> {
    if (!playSessionId || this.killEncodesOff.has(serverId)) return;
    const api = this.deps.api(serverId) ?? this.apis.get(serverId);
    if (!api) return;
    const r = killReq(api.kind, { deviceId: this.deps.deviceId, playSessionId });
    try {
      await api.request(r.method, r.path, r.query, undefined, 10_000);
      this.counters.killEncodes++;
    } catch (err) {
      const status = (err as { status?: number })?.status ?? 0;
      if (status === 404 || status === 405) {
        this.killEncodesOff.add(serverId);
        this.deps.log.info(`DELETE /Videos/ActiveEncodings answered ${status} on ${serverId}: not called again this session`);
      }
    }
  }

  // Quit, OSD crash, sleep: close every stream not yet released, then wait (bounded) for the
  // requests still in flight, whose answers close themselves on arrival.
  async sweep(deadlineMs = QUIT_SWEEP_MS): Promise<void> {
    const until = this.now() + deadlineMs;
    for (const e of this.ledger.values()) if (!e.released) void this.closeId(e.id, 'sweep');
    while (this.inflight.size > 0 && this.now() < until) {
      await Promise.race([Promise.allSettled([...this.inflight]), sleep(Math.max(0, until - this.now()))]);
    }
    this.flushExport();
  }

  isOpen(liveStreamId: string | undefined): boolean {
    const e = liveStreamId ? this.ledger.get(liveStreamId) : undefined;
    return Boolean(e && !e.released);
  }

  snapshot(): LedgerSnapshot {
    const all = [...this.ledger.values()];
    const policy: Record<string, ZapPolicy> = {};
    for (const id of new Set(all.map((e) => e.serverId))) policy[id] = this.policy(id);
    return {
      at: this.now(),
      open: all.filter((e) => !e.released),
      recent: all.filter((e) => e.released).slice(-20),
      counters: { ...this.counters, inflight: this.inflight.size },
      killEncodesOff: [...this.killEncodesOff],
      policy,
    };
  }

  private changed(): void {
    // Released entries are kept a while (double-release protection, dev export), then pruned.
    if (this.ledger.size > 300) {
      for (const [id, e] of this.ledger) {
        if (this.ledger.size <= 200) break;
        if (e.released) this.ledger.delete(id);
      }
    }
    if (!this.deps.devExport || this.exportTimer) return;
    this.exportTimer = setTimeout(() => this.flushExport(), 50);
  }

  private flushExport(): void {
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.exportTimer = null;
    try {
      this.deps.devExport?.(this.snapshot());
    } catch {
      // dev only
    }
  }
}
