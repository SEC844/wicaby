// One live TV session (Android core livetv/LiveSession.kt and ZapController.kt, desktop main/livetv): the channel
// playing, the tune (PlaybackInfo, then /LiveStreams/Open when the tuner asks for it), the stream URL for the platform
// player, CH+/CH- with the shared zap reducer (merged presses, held keys preview, the last channel) and number entry
// with the shared digit buffer. Break-before-make: the stream playing is released before the next tune, so a server
// with one tuner zaps too. Every LiveStreamId is released once: an adopted stream by its Stopped report, any other by
// /LiveStreams/Close. A tune the TV cannot play climbs the ladder: server remux (rung 1), then full conversion (2).
import type { MediaSource } from '$shared/models';
import * as D from '$shared/livetv/dialect';
import { zapEntry, type ChannelRow, type ServerKind } from '$shared/livetv/model';
import { digitIndex, digitReduce, zapInit, zapReduce, type DigitEvent, type DigitPreview, type DigitState, type ZapEvent, type ZapState } from '$shared/livetv/zap';
import { caps } from '../platform/caps';
import { onWifi } from '../platform/index';
import type { VideoPlayer } from '../platform/player';
import type { PlaybackInfo } from './api';
import { deviceProfile } from './device-profile';
import { deviceId } from './identity';
import { t } from './i18n.svelte';
import type { LiveTv } from './livetv.svelte';
import { reporter } from './reporter';
import { settings } from './settings.svelte';

type Rung = 0 | 1 | 2;
const PROGRESS_MS = 10_000;
const TICK_MS = 100;

interface Stream {
  channelId: string;
  playSessionId: string;
  mediaSourceId: string;
  liveStreamId?: string;
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
  adopted: boolean;
}

// What to play from a live source (desktop live-session.ts pickPlay): direct play of the static stream on rung 0,
// else the server's conversion, else the static stream of a DirectStream-only tuner (HDHomeRun, tvheadend).
function pickPlay(kind: ServerKind, ps: MediaSource, channelId: string, rung: Rung, playSessionId: string): { path: string; method: Stream['playMethod'] } | null {
  const container = (ps.Container ?? '').split(',')[0].trim().toLowerCase();
  const stat = () =>
    D.toUrl(
      D.staticStream(kind, {
        itemId: channelId,
        container: /^[a-z0-9]{1,10}$/.test(container) ? container : 'ts',
        mediaSourceId: ps.Id,
        liveStreamId: ps.LiveStreamId,
        deviceId,
        playSessionId,
      }),
    );
  if (rung === 0 && ps.SupportsDirectPlay) return { path: stat(), method: 'DirectPlay' };
  if (ps.TranscodingUrl) return { path: ps.TranscodingUrl, method: /videocodec=copy/i.test(ps.TranscodingUrl) ? 'DirectStream' : 'Transcode' };
  if (ps.SupportsDirectStream) return { path: stat(), method: 'DirectStream' };
  return null;
}

export class LiveSession {
  // The channel on screen (adopted, or being tuned).
  channelId = $state('');
  tuning = $state(true);
  playing = $state(false);
  buffering = $state(true);
  error = $state<string | null>(null);
  // The channel the banner shows: a merged CH+/- target before it tunes, else the channel playing.
  bannerId = $state('');
  // The number being typed and what it points at.
  digits = $state<{ buf: string; preview: DigitPreview | null } | null>(null);
  // A typed number that matches no channel ("No channel 57"), shown briefly.
  noMatch = $state<string | null>(null);

  private zap: ZapState;
  private digitState: DigitState | null = null;
  private readonly ix;
  private stream: Stream | null = null;
  private rung: Rung = 0;
  private seq = 0;
  private stopped = false;
  private timers: number[] = [];
  private offs: (() => void)[] = [];

  constructor(
    readonly repo: LiveTv,
    readonly player: VideoPlayer,
    // The zap list: the lineup in the order the user opened it from.
    readonly list: ChannelRow[],
    startId: string,
  ) {
    this.zap = zapInit(null);
    this.ix = digitIndex(list.map((c) => ({ id: c.id, number: c.number })));
    this.channelId = this.bannerId = startId;
  }

  private get entries() {
    return this.list.map(zapEntry);
  }

  get channel(): ChannelRow | undefined {
    return this.repo.channel(this.channelId) ?? this.list.find((c) => c.id === this.channelId);
  }

  // Where the channel sits in the zap list, 1-based.
  position(id: string): number {
    return this.list.findIndex((c) => c.id === id) + 1;
  }

  start(): void {
    this.offs.push(
      this.player.on('buffering', (on) => (this.buffering = on)),
      this.player.on('error', (m) => this.failed(m)),
      this.player.on('ended', () => this.failed(t('playback_error'))),
    );
    this.timers.push(
      window.setInterval(() => this.tick(), TICK_MS),
      window.setInterval(() => {
        if (this.stream?.adopted && !this.stopped) this.report('/Sessions/Playing/Progress');
      }, PROGRESS_MS),
    );
    this.apply({ type: 'tune', id: this.channelId, at: Date.now() });
  }

  // --- Zapping ---

  private apply(ev: ZapEvent): void {
    const { state, effects } = zapReduce(this.zap, ev, this.entries);
    this.zap = state;
    for (const e of effects) {
      if (e.type === 'banner') this.bannerId = e.id;
      else void this.tune(e.id);
    }
  }

  press(delta: 1 | -1, repeat: boolean): void {
    this.apply({ type: 'press', delta, at: Date.now(), repeat });
  }

  keyUp(): void {
    this.apply({ type: 'key-up', at: Date.now() });
  }

  lastChannel(): void {
    this.apply({ type: 'last-channel', at: Date.now() });
  }

  tuneTo(id: string): void {
    this.apply({ type: 'tune', id, at: Date.now() });
  }

  get hasLast(): boolean {
    return this.zap.last !== null;
  }

  // --- Number entry ---

  digit(ev: DigitEvent): boolean {
    const step = digitReduce(this.ix, this.digitState, ev);
    this.digitState = step.state;
    this.digits = step.state ? { buf: step.state.buf, preview: step.preview } : null;
    const r = step.result;
    if (r?.type === 'commit') this.tuneTo(r.id);
    else if (r?.type === 'fail') this.showNoMatch(r.number);
    else if (r?.type === 'last-channel') this.lastChannel();
    return step.state !== null || !!r;
  }

  get typing(): boolean {
    return this.digitState !== null;
  }

  private showNoMatch(n: string): void {
    this.noMatch = n;
    const shown = n;
    setTimeout(() => {
      if (this.noMatch === shown) this.noMatch = null;
    }, 2500);
  }

  private tick(): void {
    const at = Date.now();
    this.apply({ type: 'tick', at });
    if (this.digitState) this.digit({ type: 'tick', at });
  }

  // --- The tune ---

  private async tune(id: string, rung: Rung = 0): Promise<void> {
    const seq = ++this.seq;
    this.rung = rung;
    this.channelId = id;
    this.tuning = true;
    this.error = null;
    this.playing = false;
    // Break-before-make: one tuner is enough to zap.
    if (this.stream) this.release(this.stream);
    this.stream = null;
    if (rung === 0) this.player.stop();
    const kind = this.repo.api.kind;
    const userId = this.repo.api.userId ?? '';
    const mbps = onWifi() ? settings.mbpsWifi.value : settings.mbpsEthernet.value;
    const maxBitrate = mbps > 0 ? mbps * 1_000_000 : 200_000_000;
    let opened: Stream | null = null;
    try {
      const profile = deviceProfile(await caps(), kind, maxBitrate, 0, false);
      const info = await this.repo.send<PlaybackInfo>(D.tune(kind, { userId, channelId: id, maxBitrate, rung, deviceProfile: profile }));
      let ps = info.MediaSources?.[0];
      const playSessionId = info.PlaySessionId ?? '';
      if (info.ErrorCode || !ps) throw new Error(info.ErrorCode ? t('playback_error_code', info.ErrorCode) : t('no_playable_source'));
      if (ps.LiveStreamId) opened = this.streamOf(id, ps, playSessionId);
      if (seq !== this.seq) return this.drop(opened);
      if (ps.RequiresOpening && !ps.LiveStreamId) {
        const o = await this.repo.send<{ MediaSource?: MediaSource }>(
          D.open(kind, { userId, itemId: id, playSessionId, maxBitrate, openToken: ps.OpenToken ?? '', deviceProfile: profile }),
        );
        if (!o.MediaSource) throw new Error(t('no_playable_source'));
        ps = o.MediaSource;
        opened = this.streamOf(id, ps, playSessionId);
        if (seq !== this.seq) return this.drop(opened);
      }
      const play = pickPlay(kind, ps, id, rung, playSessionId);
      const url = play && this.repo.api.mediaUrl(play.path);
      if (!play || !url) throw new Error(t('no_playable_source'));
      const s: Stream = opened ?? this.streamOf(id, ps, playSessionId);
      s.playMethod = play.method;
      this.stream = s;
      opened = null;
      await this.player.open(url, 0);
      if (seq !== this.seq) return;
      this.player.play();
      s.adopted = true;
      this.tuning = false;
      this.playing = true;
      this.report('/Sessions/Playing');
      this.repo.watched(id);
      this.apply({ type: 'adopted', id });
    } catch (e) {
      this.drop(opened);
      if (seq !== this.seq) return;
      this.apply({ type: 'failed', id });
      this.tuning = false;
      this.error = e instanceof Error && e.message ? e.message : t('playback_error');
    }
  }

  private streamOf(channelId: string, ps: MediaSource, playSessionId: string): Stream {
    return { channelId, playSessionId, mediaSourceId: ps.Id, liveStreamId: ps.LiveStreamId, playMethod: 'DirectPlay', adopted: false };
  }

  private drop(s: Stream | null): void {
    if (s) this.release(s);
  }

  // The TV could not play it: the next rung of the same channel, else the error.
  private failed(message: string): void {
    if (this.stopped || !this.stream) return;
    if (this.rung < 2) return void this.tune(this.stream.channelId, (this.rung + 1) as Rung);
    this.playing = false;
    this.error = message || t('playback_error');
  }

  retry(): void {
    void this.tune(this.channelId, 0);
  }

  togglePause(): void {
    if (!this.stream?.adopted) return;
    if (this.player.paused) this.player.play();
    else this.player.pause();
    this.playing = !this.player.paused;
    this.report('/Sessions/Playing/Progress', this.playing ? 'Unpause' : 'Pause');
  }

  // --- Reports and release ---

  private body(s: Stream, event?: string): Record<string, unknown> {
    const b: Record<string, unknown> = {
      ItemId: s.channelId,
      MediaSourceId: s.mediaSourceId,
      PlaySessionId: s.playSessionId,
      PlayMethod: s.playMethod,
      IsPaused: this.player.paused,
      CanSeek: false,
    };
    if (s.liveStreamId) b.LiveStreamId = s.liveStreamId;
    if (event) b.EventName = event;
    return b;
  }

  private report(path: '/Sessions/Playing' | '/Sessions/Playing/Progress', event?: string): void {
    const s = this.stream;
    if (!s?.adopted) return;
    const body = this.body(s, event);
    if (path.endsWith('/Progress')) reporter.latest(() => this.repo.api.report(path, body));
    else void reporter.send(() => this.repo.api.report(path, body));
  }

  // Stopped releases an adopted stream; any other one is closed. A conversion is ended on the server at once.
  private release(s: Stream): void {
    const api = this.repo.api;
    if (s.adopted) {
      const body = this.body(s);
      void reporter.send(() => api.report('/Sessions/Playing/Stopped', body));
    } else if (s.liveStreamId) {
      const r = D.close(api.kind, { liveStreamId: s.liveStreamId, playSessionId: s.playSessionId });
      void reporter.send(() => this.repo.send(r));
    }
    if (s.playMethod !== 'DirectPlay') void api.stopEncoding(s.playSessionId).catch(() => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.seq++;
    this.timers.forEach(clearInterval);
    this.offs.forEach((off) => off());
    if (this.stream) this.release(this.stream);
    this.stream = null;
    this.player.stop();
  }
}
