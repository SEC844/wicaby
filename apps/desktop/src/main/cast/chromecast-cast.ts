// A Chromecast cast over CASTV2 (cast-spec CA-09, §2.4-2.6). Two receivers:
// - Jellyfin: its own receiver app (user.Configuration.CastReceiverId, else F007D354) gets a urn:x-cast:com.connectsdk
//   PlayNow with the whole queue, the server's LAN address and a token (as jellyfin-web sends; the receiver calls the
//   API itself, so the relay cannot serve it). The receiver reports progress; the sender only mirrors MEDIA_STATUS.
//   If it does not launch (LAUNCH_ERROR, region, firmware), the Default Media Receiver takes over.
// - Emby (and that fallback): the Default Media Receiver CC1AD845 gets a LOAD of a stream built from the Cast
//   PlaybackInfo (castProfile, 20 Mbps), through the LAN relay by default, with text subtitles as VTT tracks. The
//   sender reports for the cast as its own session (Playing, Progress every 10 s and on each change, Ping every 30 s
//   while transcoding, Stopped at IDLE/close/loss).
import { TICKS_PER_MS, type CastCommand, type CastStartOptions, type CastState, type CastTarget, type PlayMethod } from '../../shared/contract';
import type { BaseItem, MediaSource, PlaybackInfoResponse } from '../../shared/models';
import type { ApiClient } from '../connection/api-client';
import { userItem, userItems } from '../connection/user-routes';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { LocalPlayer } from './cast-manager';
import { CastChannel, CastError, NS, RECEIVER, type Payload } from './castv2';
import { CastFailure, deviceUrls, serverPath, type CastToken } from './dlna-cast';
import { lanServerBase } from './lan';
import type { CastDevice } from './mdns';
import { castProfile, type CastPrefs } from './profiles';
import type { Relay } from './relay';
import { controlsFor } from './targets';

const log = logger.scope('chromecast');
const TICKS_PER_S = 1000 * TICKS_PER_MS;
export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const TEXT_SUBS = /^(srt|subrip|ass|ssa|vtt|webvtt|mov_text|text)$/i;
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', aac: 'audio/mp4', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg' };

export interface ChromecastDeps {
  api: ApiClient;
  userId: string;
  device: CastDevice;
  target: CastTarget;
  // null: relay off (the URLs carry the token, §2.6.3).
  relay: Relay | null;
  // The device came from the dev seed: loopback is a LAN address for it.
  seed: boolean;
  deviceId: string;
  token?: CastToken;
  prefs: CastPrefs;
  server: { id: string; version: string };
  publish: () => void;
  ended: (errorKey?: string) => void;
}

interface Stream {
  transcode: boolean;
  // An HLS playlist spans the whole runtime (seeks stay in it); a progressive transcode counts from startTicks.
  hls: boolean;
  // HEVC on Jellyfin goes out in fMP4 segments (§2.6.6).
  fmp4: boolean;
  startTicks: number;
  playSessionId?: string;
  msid: string;
  // Stream index -> Cast trackId of the text subtitles loaded with it.
  tracks: Map<number, number>;
}

interface MediaStatus {
  mediaSessionId?: number;
  playerState?: string;
  idleReason?: string;
  currentTime?: number;
  volume?: { level?: number; muted?: boolean };
  currentItemIndex?: number;
  media?: { contentId?: string };
}

export class ChromecastCast {
  // The Jellyfin receiver when the user has not set another one (Stable; 6F511C87 is Unstable).
  static jellyfinReceiver = 'F007D354';
  static statusMs = 5000;
  static progressMs = 10_000;
  static pingMs = 30_000;
  static confirmMs = 8000;

  status: CastState['status'] = 'starting';
  // receiver: the Jellyfin receiver plays and reports; dmr: the Default Media Receiver, the sender reports.
  mode: 'receiver' | 'dmr' = 'dmr';
  private ch = new CastChannel();
  private transportId = '';
  private sessionId = '';
  private mediaSessionId?: number;
  private playerState?: string;
  private item?: BaseItem;
  private queue: BaseItem[] = [];
  private ids: string[] = [];
  private index = 0;
  private stream?: Stream;
  private serverAddress = '';
  private accessToken = '';
  private audio?: number;
  private sub?: number;
  private nonce?: string;
  private positionTicks = 0;
  private at = Date.now();
  private paused = false;
  private volume?: number;
  private muted?: boolean;
  private restarting = false;
  private done = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly d: ChromecastDeps) {}

  get target(): CastTarget {
    return this.d.target;
  }

  // The quit prompt and the "local playback stops the cast first" rule apply to sender-reported casts only (§2.5).
  get reports(): boolean {
    return this.mode === 'dmr';
  }

  get state(): CastState {
    const moving = this.status === 'playing' && !this.paused && !this.restarting && this.playerState === 'PLAYING';
    let pos = moving ? this.positionTicks + (Date.now() - this.at) * TICKS_PER_MS : this.positionTicks;
    if (this.item?.RunTimeTicks) pos = Math.min(pos, this.item.RunTimeTicks);
    const it = this.item;
    return {
      target: this.d.target,
      status: this.status,
      item: it && { id: it.Id, name: it.Name ?? '', type: it.Type, seriesName: it.SeriesName, runTimeTicks: it.RunTimeTicks },
      serverId: this.d.target.serverId!,
      positionTicks: Math.round(pos),
      paused: this.paused,
      volume: this.volume,
      muted: this.muted,
      audio: this.audio,
      sub: this.sub,
      controls: { ...controlsFor(this.d.target, this.d.api.kind, 1), nextPrev: this.mode === 'receiver' && this.ids.length > 1 },
    };
  }

  // local: the player handed off (paused once the device took it, stopped once it plays); null from an item page.
  async start(o: CastStartOptions, local: LocalPlayer | null): Promise<void> {
    this.ids = o.itemIds;
    this.index = o.startIndex ?? 0;
    this.audio = o.audio;
    this.sub = o.sub;
    let paused = false;
    try {
      const { api, device } = this.d;
      this.item = await userItem<BaseItem>(api, this.d.userId, this.ids[this.index]);
      this.d.publish();
      this.ch.on('message', (ns: string, p: Payload) => this.onMessage(ns, p));
      this.ch.once('lost', () => void this.end('cast.error.lost'));
      await this.ch.connect(device.ip, device.port);
      if (api.kind === 'jellyfin') {
        const appId = await this.receiverId();
        try {
          await this.launch(appId);
          this.mode = 'receiver';
        } catch (err) {
          log.info(`receiver ${appId} did not launch (${String(err)}): Default Media Receiver instead`);
        }
      }
      if (this.mode === 'receiver') await this.playNow(o);
      else {
        await this.launch(DEFAULT_MEDIA_RECEIVER);
        await this.loadAt(o.positionTicks ?? 0, o.msid);
      }
      if (local) {
        await local.command({ type: 'pause' });
        paused = true;
      }
      await this.confirm();
      if (this.done) return;
      // Stopped for the local session goes out before the cast's Playing (one DeviceId, §1).
      if (local) await local.stop();
      this.status = 'playing';
      this.at = Date.now();
      this.timers.push(setInterval(() => this.mediaRequest('GET_STATUS').catch(() => undefined), ChromecastCast.statusMs));
      if (this.reports) {
        void this.report('Playing');
        this.timers.push(setInterval(() => this.report('Progress', 'TimeUpdate'), ChromecastCast.progressMs));
        this.timers.push(setInterval(() => this.stream?.transcode && this.report('Ping'), ChromecastCast.pingMs));
      }
      this.d.publish();
    } catch (err) {
      // Stopped (or lost) while starting: that path already ended it.
      if (this.done) return;
      const key = err instanceof CastFailure ? err.key : err instanceof CastError && /LOAD|INVALID/.test(err.reply) ? 'cast.error.rejected' : 'cast.error.unreachable';
      log.warn(`cast to ${this.d.device.name} failed: ${key}`, err instanceof CastFailure ? undefined : err);
      await this.halt();
      if (paused) void local?.command({ type: 'resume' });
      this.d.ended(key);
    }
  }

  private async receiverId(): Promise<string> {
    const user = await this.d.api.get<{ Configuration?: { CastReceiverId?: string } }>(`/Users/${this.d.userId}`).catch(() => null);
    const id = user?.Configuration?.CastReceiverId;
    return typeof id === 'string' && /^[0-9A-F]{8}$/i.test(id) ? id.toUpperCase() : ChromecastCast.jellyfinReceiver;
  }

  private async launch(appId: string): Promise<void> {
    const r = await this.ch.request(NS.receiver, RECEIVER, { type: 'LAUNCH', appId });
    const apps = ((r.status as { applications?: { appId?: string; transportId?: string; sessionId?: string }[] } | undefined)?.applications ?? []).filter((a) => a.appId === appId);
    if (!apps[0]?.transportId) throw new CastError('LAUNCH_ERROR');
    this.transportId = apps[0].transportId;
    this.sessionId = apps[0].sessionId ?? '';
    this.applyReceiver(r);
    this.ch.send(NS.connection, this.transportId, { type: 'CONNECT' });
  }

  // The Jellyfin receiver: the whole queue, where to start, the server it plays from (§1, jellyfin-web's message).
  private async playNow(o: CastStartOptions): Promise<void> {
    const { api } = this.d;
    // shortcut: a server reached as localhost (same PC) is refused like the mesh; map it to this PC's LAN address if asked.
    const base = await lanServerBase(api, this.d.seed);
    if (!base) throw new CastFailure('cast.error.lanOnly');
    this.serverAddress = base;
    // CA-11: a disposable token when Jellyfin can make one, else the user's (as jellyfin-web sends).
    this.accessToken = (await this.d.token?.('receiver')) ?? api.token ?? '';
    const got = this.ids.length > 1 ? await userItems<{ Items?: BaseItem[] }>(api, this.d.userId, { Ids: this.ids.join(',') }).catch(() => null) : null;
    const byId = new Map((got?.Items ?? []).map((i) => [i.Id, i]));
    byId.set(this.item!.Id, this.item!);
    this.queue = this.ids.map((Id) => byId.get(Id) ?? ({ Id, Name: '' } as BaseItem));
    const items = this.queue.map((i) => ({ Id: i.Id, ServerId: this.d.server.id, Name: i.Name ?? '', Type: i.Type ?? '', MediaType: i.MediaType ?? 'Video', IsFolder: false }));
    this.positionTicks = Math.max(0, Math.round(o.positionTicks ?? 0));
    this.connectsdk('PlayNow', { items, startIndex: this.index, startPositionTicks: this.positionTicks, mediaSourceId: o.msid, audioStreamIndex: o.audio, subtitleStreamIndex: o.sub });
  }

  // Every connectsdk message carries the server and the credentials (the receiver needs them on each one).
  private connectsdk(command: string, options: Record<string, unknown>): void {
    const { device, server } = this.d;
    this.ch.send(NS.connectsdk, this.transportId, {
      command,
      options,
      userId: this.d.userId,
      deviceId: this.d.deviceId,
      accessToken: this.accessToken,
      serverAddress: this.serverAddress,
      serverId: server.id,
      serverVersion: server.version,
      receiverName: device.name,
    });
  }

  // The Default Media Receiver: PlaybackInfo with the Cast profile, then LOAD.
  private async loadAt(startTicks: number, msid = this.stream?.msid): Promise<void> {
    const ticks = Math.max(0, Math.round(startTicks));
    const { s, contentId, contentType, tracks } = await this.prepare(ticks, msid);
    const active = this.sub !== undefined && s.tracks.has(this.sub) ? [s.tracks.get(this.sub)!] : [];
    this.restarting = true;
    try {
      const r = await this.ch.request(NS.media, this.transportId, {
        type: 'LOAD',
        media: {
          contentId,
          contentType,
          streamType: 'BUFFERED',
          metadata: { metadataType: 0, title: this.item?.Name ?? '' },
          ...(this.item?.RunTimeTicks ? { duration: this.item.RunTimeTicks / TICKS_PER_S } : {}),
          ...(tracks.length ? { tracks } : {}),
          ...(s.hls ? { hlsVideoSegmentFormat: s.fmp4 ? 'fmp4' : 'mpeg2_ts' } : {}),
        },
        currentTime: (ticks - s.startTicks) / TICKS_PER_S,
        autoplay: true,
        activeTrackIds: active,
      });
      this.stream = s;
      this.mediaSessionId = undefined;
      this.restarting = false;
      this.onMessage(NS.media, r);
    } finally {
      this.restarting = false;
    }
    this.positionTicks = ticks;
    this.at = Date.now();
    this.paused = false;
  }

  private async prepare(startTicks: number, msid?: string): Promise<{ s: Stream; contentId: string; contentType: string; tracks: Record<string, unknown>[] }> {
    const { api, device } = this.d;
    const item = this.item!;
    const max = 20_000_000;
    const audioItem = item.MediaType === 'Audio';
    const info = await api.post<PlaybackInfoResponse>(
      `/Items/${item.Id}/PlaybackInfo`,
      { UserId: this.d.userId, StartTimeTicks: startTicks, MaxStreamingBitrate: max, MediaSourceId: msid, AudioStreamIndex: this.audio, SubtitleStreamIndex: this.sub, IsPlayback: true },
      {
        DeviceProfile: castProfile(device.model, this.d.prefs, api.kind),
        UserId: this.d.userId,
        StartTimeTicks: startTicks,
        MaxStreamingBitrate: max,
        MediaSourceId: msid,
        AudioStreamIndex: this.audio,
        SubtitleStreamIndex: this.sub,
        IsPlayback: true,
        AutoOpenLiveStream: false,
        EnableDirectPlay: true,
        EnableDirectStream: true,
        EnableTranscoding: true,
      },
    );
    const src = (info.MediaSources?.find((m) => m.Id === msid) ?? info.MediaSources?.[0]) as (MediaSource & { TranscodingContainer?: string }) | undefined;
    if (!src || info.ErrorCode) throw new CastFailure('cast.error.rejected');
    const playSessionId = info.PlaySessionId;
    const direct = src.SupportsDirectPlay === true && !src.TranscodingUrl;
    let path: string;
    let contentType: string;
    let hls = false;
    let fmp4 = false;
    if (direct) {
      const container = (src.Container ?? (audioItem ? 'mp3' : 'mp4')).split(',')[0].toLowerCase();
      const q = new URLSearchParams({ Static: 'true', MediaSourceId: src.Id, ...(playSessionId ? { PlaySessionId: playSessionId } : {}), DeviceId: this.d.deviceId });
      path = `/${audioItem ? 'Audio' : 'Videos'}/${item.Id}/stream.${container}?${q}`;
      contentType = MIME[container] ?? (audioItem ? 'audio/mpeg' : 'video/mp4');
    } else {
      if (!src.TranscodingUrl) throw new CastFailure('cast.error.rejected');
      path = serverPath(api, src.TranscodingUrl);
      hls = src.TranscodingSubProtocol?.toLowerCase() === 'hls' || /\.m3u8(\?|$)/i.test(path);
      const container = (src.TranscodingContainer ?? '').toLowerCase();
      contentType = hls ? 'application/x-mpegurl' : (MIME[container] ?? (audioItem ? 'audio/mpeg' : 'video/mp4'));
      fmp4 = hls && container === 'mp4';
    }
    // Text subtitles as VTT side tracks (EDIT_TRACKS_INFO switches between them); image ones are burned in (restart).
    // shortcut: no side tracks from Plex (PMS serves its sidecars as SRT, not VTT); upgrade through its subtitle transcoder.
    const subs = api.kind === 'plex' ? [] : (src.MediaStreams ?? []).filter((m) => m.Type === 'Subtitle' && m.Index >= 0 && m.DeliveryMethod !== 'Encode' && (m.IsTextSubtitleStream === true || TEXT_SUBS.test(m.Codec ?? '')));
    const subPath = (i: number) => `/Videos/${item.Id}/${src.Id}/Subtitles/${i}/${api.kind === 'jellyfin' ? '0/' : ''}Stream.vtt`;
    const r = await deviceUrls({ ...this.d, ip: device.ip }, [path, ...subs.map((m) => subPath(m.Index))], this.nonce);
    this.nonce = r.nonce;
    const trackIds = new Map(subs.map((m) => [m.Index, m.Index + 1]));
    const tracks = subs.map((m, i) => ({
      trackId: m.Index + 1,
      type: 'TEXT',
      subtype: 'SUBTITLES',
      trackContentId: r.urls[i + 1],
      trackContentType: 'text/vtt',
      name: m.DisplayTitle ?? m.Language ?? String(m.Index),
      ...(m.Language ? { language: m.Language } : {}),
    }));
    const transcode = !direct;
    return {
      // A Plex HLS starts at the offset (StartTimeTicks), like a progressive transcode.
      s: { transcode, hls, fmp4, startTicks: transcode && (!hls || src.StartTimeTicks) ? startTicks : 0, playSessionId, msid: src.Id, tracks: trackIds },
      contentId: r.urls[0],
      contentType,
      tracks,
    };
  }

  // §2.4: a MEDIA_STATUS of PLAYING or BUFFERING and, through the relay, a request from the device, within 8 s.
  // A relay nobody reached is a firewall: cast.error.relayBlocked, never a silent token fallback.
  private async confirm(): Promise<void> {
    const until = Date.now() + ChromecastCast.confirmMs;
    for (;;) {
      if (this.done) return;
      const playing = this.playerState === 'PLAYING' || this.playerState === 'BUFFERING';
      const fetched = this.mode === 'receiver' || !this.d.relay || !this.nonce || this.d.relay.seen(this.nonce);
      if (playing && fetched) return;
      if (Date.now() >= until) throw new CastFailure(playing && !fetched ? 'cast.error.relayBlocked' : 'cast.error.rejected');
      if (!this.mediaSessionId) void this.mediaRequest('GET_STATUS').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private mediaRequest(type: string, extra: Record<string, unknown> = {}): Promise<Payload> {
    if (!this.transportId) return Promise.reject(new CastError('NO_APP'));
    const withSession = type === 'GET_STATUS' ? {} : { mediaSessionId: this.mediaSessionId };
    if (type !== 'GET_STATUS' && this.mediaSessionId === undefined) return Promise.reject(new CastError('NO_MEDIA_SESSION'));
    return this.ch.request(NS.media, this.transportId, { type, ...withSession, ...extra });
  }

  private applyReceiver(p: Payload): void {
    const st = p.status as { volume?: { level?: number; muted?: boolean }; applications?: { sessionId?: string }[] } | undefined;
    if (typeof st?.volume?.level === 'number') this.volume = Math.round(Math.min(1, Math.max(0, st.volume.level)) * 100);
    if (typeof st?.volume?.muted === 'boolean') this.muted = st.volume.muted;
    // Another sender launched something else: this cast is over.
    if (this.status === 'playing' && this.sessionId && Array.isArray(st?.applications) && !st.applications.some((a) => a.sessionId === this.sessionId)) void this.end();
  }

  private onMessage(ns: string, p: Payload): void {
    if (this.done) return;
    if (ns === NS.receiver && p.type === 'RECEIVER_STATUS') this.applyReceiver(p);
    else if (ns === NS.connection && p.type === 'CLOSE') void this.end();
    else if (ns === NS.media && p.type === 'MEDIA_STATUS' && Array.isArray(p.status)) {
      const s = (p.status as MediaStatus[])[0];
      if (!s) return;
      // While a new LOAD is on its way, the old media's last words (IDLE INTERRUPTED…) are not the end.
      if (this.restarting) return;
      if (typeof s.mediaSessionId === 'number') this.mediaSessionId = s.mediaSessionId;
      const was = this.paused;
      this.playerState = s.playerState;
      if (s.playerState === 'IDLE' && this.status === 'playing') {
        if (s.idleReason === 'FINISHED' || s.idleReason === 'CANCELLED' || s.idleReason === 'ERROR') void this.end(s.idleReason === 'ERROR' ? 'cast.error.rejected' : undefined);
        return;
      }
      if (s.playerState === 'PAUSED' || s.playerState === 'PLAYING' || s.playerState === 'BUFFERING') this.paused = s.playerState === 'PAUSED';
      if (typeof s.currentTime === 'number' && Number.isFinite(s.currentTime)) {
        this.positionTicks = (this.stream?.startTicks ?? 0) + Math.round(s.currentTime * TICKS_PER_S);
        this.at = Date.now();
      }
      if (typeof s.volume?.level === 'number') this.volume = Math.round(Math.min(1, Math.max(0, s.volume.level)) * 100);
      if (typeof s.volume?.muted === 'boolean') this.muted = s.volume.muted;
      // The receiver moved along the queue (NextTrack, PreviousTrack, the end of an item).
      if (this.mode === 'receiver') {
        const i = typeof s.currentItemIndex === 'number' ? s.currentItemIndex : this.ids.indexOf(s.media?.contentId ?? '');
        if (i >= 0 && i < this.queue.length && i !== this.index) {
          this.index = i;
          this.item = this.queue[i];
        }
      }
      if (this.status === 'playing' && was !== this.paused) void this.report('Progress', this.paused ? 'Pause' : 'Unpause');
      this.d.publish();
    }
  }

  async control(cmd: CastCommand): Promise<void> {
    if (this.status !== 'playing' || this.done) return;
    const pos = this.state.positionTicks;
    const receiver = this.mode === 'receiver';
    switch (cmd.type) {
      case 'toggle-pause':
        return this.control({ type: this.paused ? 'resume' : 'pause' });
      case 'pause':
      case 'resume':
        await this.mediaRequest(cmd.type === 'pause' ? 'PAUSE' : 'PLAY');
        this.positionTicks = pos;
        this.at = Date.now();
        this.paused = cmd.type === 'pause';
        void this.report('Progress', this.paused ? 'Pause' : 'Unpause');
        break;
      case 'seek':
      case 'seek-relative': {
        const to = cmd.type === 'seek' ? cmd.positionTicks : pos + cmd.deltaTicks;
        if (!Number.isFinite(to)) return;
        const ticks = Math.min(Math.max(0, Math.round(to)), this.item?.RunTimeTicks ?? Infinity);
        // A progressive transcode restarts from there; direct streams and HLS seek in place.
        if (!receiver && this.stream?.transcode && !this.stream.hls) await this.restart(ticks);
        else await this.mediaRequest('SEEK', { currentTime: (ticks - (this.stream?.startTicks ?? 0)) / TICKS_PER_S });
        this.positionTicks = ticks;
        this.at = Date.now();
        void this.report('Progress', 'TimeUpdate');
        break;
      }
      case 'volume': {
        if (!Number.isFinite(cmd.value)) return;
        const v = Math.round(Math.min(100, Math.max(0, cmd.value)));
        await this.ch.request(NS.receiver, RECEIVER, { type: 'SET_VOLUME', volume: { level: v / 100 } });
        this.volume = v;
        void this.report('Progress', 'VolumeChange');
        break;
      }
      case 'mute':
        await this.ch.request(NS.receiver, RECEIVER, { type: 'SET_VOLUME', volume: { muted: cmd.value } });
        this.muted = cmd.value;
        void this.report('Progress', 'VolumeChange');
        break;
      case 'next':
      case 'previous':
        if (!receiver || this.ids.length < 2) throw new Error(t('cast.remote.unavailable'));
        this.connectsdk(cmd.type === 'next' ? 'NextTrack' : 'PreviousTrack', {});
        break;
      case 'audio':
      case 'subtitle': {
        const audio = cmd.type === 'audio';
        if (!Number.isInteger(cmd.index) || cmd.index < (audio ? 0 : -1)) return;
        if (audio) this.audio = cmd.index;
        else this.sub = cmd.index;
        // The Jellyfin receiver switches by itself (§2.3); the DMR restarts for audio and image subtitles.
        if (receiver) this.connectsdk(audio ? 'SetAudioStreamIndex' : 'SetSubtitleStreamIndex', { index: cmd.index });
        else if (!audio && (cmd.index === -1 || this.stream?.tracks.has(cmd.index))) await this.mediaRequest('EDIT_TRACKS_INFO', { activeTrackIds: cmd.index === -1 ? [] : [this.stream!.tracks.get(cmd.index)!] });
        else await this.restart(pos);
        void this.report('Progress', audio ? 'AudioTrackChange' : 'SubtitleTrackChange');
        break;
      }
      default:
        throw new Error(t('cast.remote.unavailable'));
    }
    this.d.publish();
  }

  // shortcut: the old transcode is left to the server's idle timeout, not killed; kill it if servers pile them up.
  private async restart(ticks: number): Promise<void> {
    await this.loadAt(ticks);
  }

  private body(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const s = this.stream;
    const method: PlayMethod = s?.transcode ? 'Transcode' : 'DirectStream';
    return {
      ItemId: this.item?.Id,
      MediaSourceId: s?.msid,
      PlaySessionId: s?.playSessionId,
      PositionTicks: this.state.positionTicks,
      IsPaused: this.paused,
      IsMuted: this.muted ?? false,
      VolumeLevel: this.volume,
      AudioStreamIndex: this.audio,
      SubtitleStreamIndex: this.sub ?? -1,
      PlayMethod: method,
      CanSeek: true,
      RunTimeTicks: this.item?.RunTimeTicks,
      QueueableMediaTypes: [],
      ...extra,
    };
  }

  // The DMR only: the Jellyfin receiver reports for itself, and a second report would double-count (§2.5).
  private report(kind: 'Playing' | 'Progress' | 'Stopped' | 'Ping', event?: string): Promise<unknown> {
    if (!this.reports) return Promise.resolve();
    const api = this.d.api;
    const call =
      kind === 'Ping'
        ? api.post('/Sessions/Playing/Ping', { PlaySessionId: this.stream?.playSessionId ?? '' })
        : api.post(kind === 'Playing' ? '/Sessions/Playing' : `/Sessions/Playing/${kind}`, undefined, this.body(event ? { EventName: event } : {}));
    return call.catch((err) => log.debug(`report ${kind} failed: ${String(err)}`));
  }

  // "Arrêter la diffusion": the device stops its app, the server gets Stopped (DMR).
  async stop(): Promise<void> {
    if (this.done) return;
    const playing = this.status === 'playing';
    await this.halt();
    if (playing) await this.report('Stopped');
    this.d.ended();
  }

  // The end of the media, the app closed, or the device lost.
  private async end(errorKey?: string): Promise<void> {
    if (this.done) return;
    const playing = this.status === 'playing';
    await this.halt();
    if (playing) await this.report('Stopped');
    this.d.ended(errorKey);
  }

  // Timers off, the media and the app stopped on the device (best effort), the channel and the relay URLs closed.
  private async halt(): Promise<void> {
    this.done = true;
    for (const x of this.timers) clearInterval(x);
    this.timers = [];
    if (this.mediaSessionId !== undefined) await this.mediaRequest('STOP').catch(() => undefined);
    if (this.sessionId) await this.ch.request(NS.receiver, RECEIVER, { type: 'STOP', sessionId: this.sessionId }).catch(() => undefined);
    this.ch.close();
    if (this.nonce) this.d.relay?.close(this.nonce);
    this.nonce = undefined;
  }

  // Quit while the Jellyfin receiver plays: it carries on and reports for itself; only this channel goes.
  detach(): void {
    this.done = true;
    for (const x of this.timers) clearInterval(x);
    this.timers = [];
    this.ch.close();
  }

  // "Reprendre ici": where the device was, with the same version and tracks.
  playHere(): { itemIds: string[]; startIndex: number; positionTicks: number; msid?: string; audio?: number; sub?: number } {
    return { itemIds: this.ids, startIndex: this.index, positionTicks: this.state.positionTicks, msid: this.stream?.msid, audio: this.audio, sub: this.sub };
  }
}
