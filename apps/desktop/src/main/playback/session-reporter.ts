// Server reporting for the playback service: Playing, Progress, Stopped and Ping, the 10 s progress
// timer, played marks, offline user data and the 'report' events Trakt scrobbles.
import { TICKS_PER_MS, type PlaybackState } from '../../shared/contract';
import type { ApiClient } from '../connection/api-client';
import { logger } from '../core/log';
import type { LivePlayback } from '../livetv/live-player';
import type { Current, PlaybackDeps } from './playback-model';

const log = logger.scope('playback');

// What the playback service lends the reporter (its own fields, read and written in place).
export interface ReportHost {
  readonly deps: PlaybackDeps;
  current: Current | null;
  readonly state: PlaybackState;
  // Server of the queue.
  readonly serverId: string | undefined;
  readonly lives: LivePlayback;
  // Every report also goes out as a 'report' event (Trakt scrobbling, features/trakt.ts).
  report(action: 'start' | 'pause' | 'stop', serverId: string | undefined, item: Current['item'], positionMs: number, durationMs: number): void;
}

export class SessionReporter {
  private progressTimer: NodeJS.Timeout | null = null;
  private pausedTicks = 0;

  constructor(private readonly host: ReportHost) {}

  private body(extra: Record<string, unknown> = {}, c = this.host.current): Record<string, unknown> | null {
    if (!c || c.trailer) return null;
    const state = this.host.state;
    return {
      ItemId: c.item.Id,
      MediaSourceId: c.source?.Id,
      PlaySessionId: c.playSessionId,
      LiveStreamId: c.source?.LiveStreamId,
      PositionTicks: Math.round(state.positionMs * TICKS_PER_MS),
      IsPaused: state.paused,
      IsMuted: state.muted,
      VolumeLevel: Math.round(state.volume),
      AudioStreamIndex: c.audioIndex ?? undefined,
      SubtitleStreamIndex: c.subtitleIndex ?? -1,
      PlayMethod: c.playMethod,
      PlaybackRate: state.rate,
      CanSeek: true,
      RunTimeTicks: c.item.RunTimeTicks,
      QueueableMediaTypes: ['Audio', 'Video'],
      ...extra,
    };
  }

  online(): ApiClient | null {
    return this.host.deps.connection.onlineApi(this.host.current?.serverId ?? this.host.serverId);
  }

  private scrobble(action: 'start' | 'pause' | 'stop', c: Current): void {
    this.host.report(action, c.serverId, c.item, this.host.state.positionMs, this.host.state.durationMs);
  }

  start(): void {
    const body = this.body();
    const api = this.online();
    if (body) this.scrobble('start', this.host.current!);
    if (body && api) api.post('/Sessions/Playing', undefined, body).catch((err) => log.warn('report start failed', err));
  }

  progress(event: string): void {
    const current = this.host.current;
    // A live stream reports nothing before its first frame (it may still be dropped).
    if (current?.live && !current.live.adopted) return;
    const body = this.body({ EventName: event });
    const api = this.online();
    if (body && (event === 'Pause' || event === 'Unpause')) this.scrobble(event === 'Pause' ? 'pause' : 'start', this.host.current!);
    if (body && api) api.post('/Sessions/Playing/Progress', undefined, body).catch((err) => log.debug(`report progress failed: ${String(err)}`));
  }

  // switching (X-02): the old session of an in-place reload, never marked played by Wicaby.
  async stopped(c = this.host.current, switching = false): Promise<void> {
    const host = this.host;
    const duration = host.state.durationMs;
    const pos = host.state.positionMs;
    const credits = host.state.markers?.creditsStartMs;
    const played = duration > 0 && (pos / duration >= 0.9 || (credits !== undefined && pos >= credits));
    // Resume points only between 5 % and 90 %, and never on items under 5 min.
    const keepResume = !played && duration >= 300_000 && pos / duration >= 0.05;
    const body = this.body(duration > 0 && !played && !keepResume ? { PositionTicks: 0 } : {}, c);
    if (c === host.current) host.current = null;
    if (!c) return;
    // releaseLive: the ledger releases each LiveStreamId once (a stream never adopted is closed, not stopped).
    if (!(await host.lives.releaseLive(c))) return;
    const api = host.deps.connection.onlineApi(c.serverId);
    if (c.trailer) {
      if (api && c.playMethod !== 'DirectPlay' && c.playSessionId) await host.lives.session.killEncodes(c.serverId ?? '', c.playSessionId);
      return;
    }
    if (!body) return;
    this.scrobble('stop', c);
    if (api) {
      await api.post('/Sessions/Playing/Stopped', undefined, body).catch((err) => log.warn('report stopped failed', err));
      // The server only applies its own 90 % rule, so stopping in the credits needs an explicit mark.
      const userId = api.userId;
      if (played && !switching && pos / duration < 0.9 && userId) {
        const path = api.kind === 'jellyfin' ? `/UserPlayedItems/${c.item.Id}` : `/Users/${userId}/PlayedItems/${c.item.Id}`;
        await api.post(path, api.kind === 'jellyfin' ? { userId } : undefined).catch((err) => log.warn('mark played failed', err));
      }
      if (c.live) await host.lives.endEncode(c);
      // Jellyfin 12 dropped DELETE /Videos/ActiveEncodings: off for that server after one 404/405
      // (live-session.ts), the Stopped report already ends the encode there.
      else if (c.playMethod !== 'DirectPlay' && c.playSessionId) await host.lives.session.killEncodes(c.serverId ?? '', c.playSessionId);
    } else if (c.serverId && c.userId) {
      host.deps.downloads.queueUserData({
        serverId: c.serverId,
        userId: c.userId,
        itemId: c.item.Id,
        positionTicks: keepResume ? Math.round(pos * TICKS_PER_MS) : 0,
        played,
        at: Date.now(),
      });
    }
  }

  // Keeps a paused transcode (and its PlaySessionId) alive: Jellyfin kills idle HLS jobs after 60 s.
  private ping(): void {
    const c = this.host.current;
    const api = this.online();
    if (c?.playSessionId && api) {
      api.post('/Sessions/Playing/Ping', { PlaySessionId: c.playSessionId }).catch((err) => log.debug(`ping failed: ${String(err)}`));
    }
  }

  startTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.pausedTicks = 0;
    this.progressTimer = setInterval(() => {
      if (!this.host.state.paused) {
        this.pausedTicks = 0;
        this.progress('TimeUpdate');
      } else if (++this.pausedTicks % 3 === 0) {
        this.ping();
      }
    }, 10_000);
  }

  clearTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }
}
