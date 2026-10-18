// A direct DLNA cast (cast-spec CA-07, §2.4-2.6): the renderer's own PlaybackInfo, a relay or token URL, the load,
// then the sender reports for the cast as its own session (Playing, Progress every 10 s and on each change, Ping
// every 30 s while transcoding, Stopped at the end) from GetPositionInfo polls. No GENA subscriptions.
// Songs play as a queue: the next one goes to the renderer ahead with SetNextAVTransportURI (gapless where the
// renderer has it; the action is optional in AVTransport:1), else it is loaded when the current one ends. Each song
// is reported as its own play (Stopped, then Playing), as the local music player does.
import { TICKS_PER_MS, type CastCommand, type CastStartOptions, type CastState, type CastTarget, type PlayMethod } from '../../shared/contract';
import type { BaseItem, MediaSource, PlaybackInfoResponse } from '../../shared/models';
import { stripTokenParams, type ApiClient } from '../connection/api-client';
import { userItem } from '../connection/user-routes';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { LocalPlayer } from './cast-manager';
import { didl, hms, load, parseHms, sinkOf, soap, UpnpError, type DidlInput, type DlnaDevice } from './dlna';
import type { TokenKind } from './ephemeral-token';
import { lanServerBase, localAddressFor } from './lan';
import { dlnaProfile, mimeFor } from './profiles';
import { relayPathAllowed, type Relay } from './relay';
import { controlsFor } from './targets';

const log = logger.scope('dlna');
const TICKS_PER_S = 1000 * TICKS_PER_MS;

// A start that did not take: the toast's i18n key.
export class CastFailure extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

export interface DlnaCastDeps {
  api: ApiClient;
  userId: string;
  device: DlnaDevice;
  target: CastTarget;
  // null: relay off (the URL carries the token, §2.6.3).
  relay: Relay | null;
  // The renderer came from the dev seed: loopback is a LAN address for it.
  seed: boolean;
  deviceId: string;
  token?: CastToken;
  publish: () => void;
  ended: (errorKey?: string) => void;
}

// CA-11: the cast's disposable token, minted on first use (undefined: use the user's).
export type CastToken = (kind: TokenKind) => Promise<string | undefined>;

interface Stream {
  url: string;
  didl: DidlInput;
  transcode: boolean;
  startTicks: number;
  playSessionId?: string;
  msid: string;
  // Its relay URLs (none with the relay off).
  nonce?: string;
}

// What the bar and the remote show of an item; a song adds its artists, album and cover (its album's first, as the
// music player does).
export function castItem(it: BaseItem): NonNullable<CastState['item']> {
  const base = { id: it.Id, name: it.Name ?? '', type: it.Type, seriesName: it.SeriesName, runTimeTicks: it.RunTimeTicks };
  if (it.MediaType !== 'Audio') return base;
  const art = it.AlbumId && it.AlbumPrimaryImageTag ? { imageItemId: it.AlbumId, imageTag: it.AlbumPrimaryImageTag } : it.ImageTags?.Primary ? { imageItemId: it.Id, imageTag: it.ImageTags.Primary } : {};
  const artists = it.Artists?.length ? it.Artists : (it.ArtistItems ?? []).map((a) => a.Name).filter((n): n is string => Boolean(n));
  return { ...base, ...(artists.length ? { artists } : {}), ...(it.Album ? { album: it.Album } : {}), ...art };
}

// A song's cover as a server path the relay allows (JPEG, 600 px). None for Plex (another image API) or without one.
export function artPath(api: ApiClient, it: BaseItem): string | undefined {
  const c = castItem(it);
  if (api.kind === 'plex' || it.MediaType !== 'Audio' || !c.imageItemId) return undefined;
  return `/Items/${c.imageItemId}/Images/Primary?${new URLSearchParams({ maxHeight: '600', quality: '90', format: 'jpg', ...(c.imageTag ? { tag: c.imageTag } : {}) })}`;
}

// A server URL (TranscodingUrl, DeliveryUrl) as a path under the API base, without token or /emby prefix.
export function serverPath(api: ApiClient, raw: string): string {
  let p = stripTokenParams(raw);
  if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(p)) {
    const u = new URL(p);
    if (u.origin !== new URL(api.address).origin) throw new CastFailure('cast.error.rejected');
    p = u.pathname.slice(new URL(api.address).pathname.replace(/\/+$/, '').length) + u.search;
  }
  if (!p.startsWith('/')) p = `/${p}`;
  const prefix = api.prefix;
  return prefix && p.toLowerCase().startsWith(`${prefix}/`) ? p.slice(prefix.length) : p;
}

// The URLs a renderer or Chromecast (`ip`) fetches: through the relay (no token at all; `prev`, the nonce of the
// stream being replaced, is closed), or with the token on the server's LAN address (relay off; ApiKey on Jellyfin,
// api_key on Emby): the cast's disposable token (CA-11) when `token` gives one, else the user's. seed: the device came
// from the dev seed, so loopback counts as LAN.
export async function deviceUrls(d: { api: ApiClient; relay: Relay | null; seed: boolean; ip: string; token?: CastToken }, paths: string[], prev?: string): Promise<{ urls: string[]; nonce?: string }> {
  const { api, relay } = d;
  if (relay) {
    if (!paths.every((p) => relayPathAllowed(p.split('?')[0]))) throw new CastFailure('cast.error.rejected');
    const host = localAddressFor(d.ip);
    if (!host) throw new CastFailure('cast.error.unreachable');
    const r = await relay.open(host, d.ip, api);
    if (prev) relay.close(prev);
    return { urls: paths.map((p) => r.base + p), nonce: r.nonce };
  }
  // A Plex token never goes into a URL (plex-spec §2): Plex casts through the relay only.
  if (api.kind === 'plex') throw new CastFailure('plex.errors.castNeedsRelay');
  // Same for Navidrome: its URLs would carry the password's token (t, s), so the relay signs them on this machine.
  if (api.kind === 'navidrome') throw new CastFailure('errors.navidrome.castNeedsRelay');
  // The mesh forwarder (127.0.0.1:<port>/tok/) is never a URL for a TV.
  const base = await lanServerBase(api, d.seed);
  if (!base) throw new CastFailure('cast.error.lanOnly');
  const key = api.kind === 'jellyfin' ? 'ApiKey' : 'api_key';
  const token = (await d.token?.('sender')) ?? api.token ?? '';
  return { urls: paths.map((p) => `${base}${api.prefix}${p}${p.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(token)}`) };
}

export class DlnaCast {
  // shortcut: 1 s always (§2.5 wants 5 s while the remote sheet is closed); add a sheet-open signal if TVs complain.
  static pollMs = 1000;
  static progressMs = 10_000;
  static pingMs = 30_000;
  static confirmMs = 8000;
  static missLimit = 3;

  status: CastState['status'] = 'starting';
  private item?: BaseItem;
  private ids: string[] = [];
  private index = 0;
  private stream?: Stream;
  // The song handed over with SetNextAVTransportURI; off once the renderer refused that action.
  private next?: { index: number; item: BaseItem; stream: Stream };
  private nextRefused = false;
  private queueing = false;
  private audio?: number;
  private sub?: number;
  private nonce?: string;
  private sink?: string;
  private positionTicks = 0;
  private at = Date.now();
  private paused = false;
  private volume?: number;
  private muted?: boolean;
  private playedOnce = false;
  private misses = 0;
  private polling = false;
  private restarting = false;
  private done = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly d: DlnaCastDeps) {}

  get target(): CastTarget {
    return this.d.target;
  }

  get state(): CastState {
    const moving = this.status === 'playing' && !this.paused && !this.restarting;
    let pos = moving ? this.positionTicks + (Date.now() - this.at) * TICKS_PER_MS : this.positionTicks;
    if (this.item?.RunTimeTicks) pos = Math.min(pos, this.item.RunTimeTicks);
    const it = this.item;
    return {
      target: this.d.target,
      status: this.status,
      item: it && castItem(it),
      ...(this.music ? { queue: { index: this.index, length: this.ids.length } } : {}),
      serverId: this.d.target.serverId!,
      positionTicks: Math.round(pos),
      paused: this.paused,
      volume: this.volume,
      muted: this.muted,
      audio: this.audio,
      sub: this.sub,
      controls: { ...controlsFor(this.d.target, this.d.api.kind, 1), nextPrev: this.music && this.ids.length > 1 },
    };
  }

  // A song queue: next and previous, the following song ahead or at the end.
  private get music(): boolean {
    return this.item?.MediaType === 'Audio';
  }

  // local: the player handed off (paused once the renderer took it, stopped once it plays); null from an item page.
  async start(o: CastStartOptions, local: LocalPlayer | null): Promise<void> {
    this.ids = o.itemIds;
    this.index = o.startIndex ?? 0;
    this.audio = o.audio;
    this.sub = o.sub;
    let paused = false;
    try {
      const api = this.d.api;
      this.item = await userItem<BaseItem>(api, this.d.userId, this.ids[this.index]);
      this.d.publish();
      this.sink = await sinkOf(this.d.device);
      await this.loadAt(o.positionTicks ?? 0, o.msid);
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
      this.report('Playing');
      this.timers.push(setInterval(() => void this.poll(), DlnaCast.pollMs));
      this.timers.push(setInterval(() => this.report('Progress', 'TimeUpdate'), DlnaCast.progressMs));
      this.timers.push(setInterval(() => this.stream?.transcode && this.report('Ping'), DlnaCast.pingMs));
      this.d.publish();
      void this.readVolume();
      void this.queueNext();
    } catch (err) {
      // Stopped while starting: stop() already ended it.
      if (this.done) return;
      const key = err instanceof CastFailure ? err.key : err instanceof UpnpError ? 'cast.error.rejected' : 'cast.error.unreachable';
      log.warn(`cast to ${this.d.device.name} failed: ${key}`, err instanceof CastFailure ? undefined : err);
      if (key === 'cast.error.relayBlocked') await soap(this.d.device, 'avt', 'Stop').catch(() => undefined);
      this.finish();
      if (paused) void local?.command({ type: 'resume' });
      this.d.ended(key);
    }
  }

  // PlaybackInfo with the renderer's profile, then the load. A transcode counts from startTicks.
  private async loadAt(startTicks: number, msid = this.stream?.msid): Promise<void> {
    const s = await this.prepare(Math.max(0, Math.round(startTicks)), msid);
    await load(this.d.device, s.didl, s.transcode);
    this.stream = s;
    this.positionTicks = startTicks;
    this.at = Date.now();
    this.paused = false;
  }

  // ahead: the next song's stream (SetNextAVTransportURI), on its own relay URLs while the current one plays.
  private async prepare(startTicks: number, msid?: string, item = this.item!, ahead = false): Promise<Stream> {
    const { api, device } = this.d;
    const max = 40_000_000;
    const audioItem = item.MediaType === 'Audio';
    const audio = ahead ? undefined : this.audio;
    const sub = ahead ? undefined : this.sub;
    const info = await api.post<PlaybackInfoResponse>(
      `/Items/${item.Id}/PlaybackInfo`,
      { UserId: this.d.userId, StartTimeTicks: startTicks, MaxStreamingBitrate: max, MediaSourceId: msid, AudioStreamIndex: audio, SubtitleStreamIndex: sub, IsPlayback: true },
      {
        DeviceProfile: dlnaProfile(this.sink ?? '', device.model),
        UserId: this.d.userId,
        StartTimeTicks: startTicks,
        MaxStreamingBitrate: max,
        MediaSourceId: msid,
        AudioStreamIndex: audio,
        SubtitleStreamIndex: sub,
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
    // Plex transcodes to HLS only here (decision.ts), which a DLNA renderer does not play: direct play or nothing.
    // shortcut: no progressive Plex transcode for DLNA; add one if PMS's http protocol is ever confirmed.
    if (!direct && api.kind === 'plex') throw new CastFailure('plex.errors.dlnaNeedsDirectPlay');
    const container = (direct ? src.Container : src.TranscodingContainer) || (audioItem ? 'mp3' : 'ts');
    let path: string;
    if (direct) {
      const q = new URLSearchParams({ Static: 'true', MediaSourceId: src.Id, ...(playSessionId ? { PlaySessionId: playSessionId } : {}), DeviceId: this.d.deviceId });
      path = `/${audioItem ? 'Audio' : 'Videos'}/${item.Id}/stream.${container.split(',')[0]}?${q}`;
    } else {
      if (!src.TranscodingUrl) throw new CastFailure('cast.error.rejected');
      path = serverPath(this.d.api, src.TranscodingUrl);
    }
    const subStream = sub !== undefined && sub >= 0 ? src.MediaStreams?.find((m) => m.Type === 'Subtitle' && m.Index === sub) : undefined;
    let subPath: string | undefined;
    if (subStream?.DeliveryMethod === 'External') {
      subPath = subStream.DeliveryUrl ? serverPath(this.d.api, subStream.DeliveryUrl) : `/Videos/${item.Id}/${src.Id}/Subtitles/${subStream.Index}/${api.kind === 'jellyfin' ? '0/' : ''}Stream.srt`;
      subPath = subPath.replace(/\/Stream\.\w+(\?|$)/i, '/Stream.srt$1');
    }
    const art = artPath(api, item);
    // A restart gets a new nonce (the old URLs answer 404 from then on); the next song gets its own beside this one.
    const r = await deviceUrls({ ...this.d, ip: this.d.device.ip }, [path, ...(subPath ? [subPath] : []), ...(art ? [art] : [])], ahead ? undefined : this.nonce);
    if (!ahead) this.nonce = r.nonce;
    const [url, ...rest] = r.urls;
    const subtitleUrl = subPath ? rest.shift() : undefined;
    const artUrl = art ? rest.shift() : undefined;
    const span = (src.RunTimeTicks ?? item.RunTimeTicks ?? 0) - (direct ? 0 : startTicks);
    const song = audioItem ? castItem(item) : undefined;
    const track = item.IndexNumber;
    return {
      url,
      transcode: !direct,
      startTicks: direct ? 0 : startTicks,
      playSessionId,
      msid: src.Id,
      nonce: r.nonce,
      didl: {
        title: item.Name ?? '',
        audio: audioItem,
        url,
        mime: mimeFor(container, audioItem, this.sink),
        durationSec: span > 0 ? span / TICKS_PER_S : undefined,
        subtitleUrl,
        ...(song?.artists ? { artist: song.artists.join(', ') } : {}),
        ...(song?.album ? { album: song.album } : {}),
        ...(audioItem && typeof track === 'number' && Number.isInteger(track) && track > 0 ? { track } : {}),
        ...(artUrl ? { artUrl } : {}),
      },
    };
  }

  // §2.4: GetTransportInfo PLAYING or TRANSITIONING and, through the relay, a request from the renderer, within 8 s
  // of Play. A relay nobody reached is a firewall: cast.error.relayBlocked, never a silent token fallback.
  private async confirm(): Promise<void> {
    const until = Date.now() + DlnaCast.confirmMs;
    let playing = false;
    for (;;) {
      if (this.done) return;
      const st = (await soap(this.d.device, 'avt', 'GetTransportInfo').catch(() => ({}) as Record<string, string>)).CurrentTransportState;
      playing = st === 'PLAYING' || st === 'TRANSITIONING';
      // A short song may end before the first poll: STOPPED then still ends it.
      if (st === 'PLAYING') this.playedOnce = true;
      const fetched = !this.d.relay || !this.nonce || this.d.relay.seen(this.nonce);
      if (playing && fetched) return;
      if (Date.now() >= until) throw new CastFailure(playing && !fetched ? 'cast.error.relayBlocked' : 'cast.error.rejected');
      await new Promise((r) => setTimeout(r, 250));
    }
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

  private report(kind: 'Playing' | 'Progress' | 'Stopped' | 'Ping', event?: string): Promise<unknown> {
    const api = this.d.api;
    const call =
      kind === 'Ping'
        ? api.post('/Sessions/Playing/Ping', { PlaySessionId: this.stream?.playSessionId ?? '' })
        : api.post(kind === 'Playing' ? '/Sessions/Playing' : `/Sessions/Playing/${kind}`, undefined, this.body(event ? { EventName: event } : {}));
    return call.catch((err) => log.debug(`report ${kind} failed: ${String(err)}`));
  }

  // The remote sheet's starting point.
  private async readVolume(): Promise<void> {
    if (!this.d.device.rc) return;
    const v = Number((await soap(this.d.device, 'rc', 'GetVolume', { Channel: 'Master' }).catch(() => ({}) as Record<string, string>)).CurrentVolume);
    const m = (await soap(this.d.device, 'rc', 'GetMute', { Channel: 'Master' }).catch(() => ({}) as Record<string, string>)).CurrentMute;
    if (Number.isFinite(v)) this.volume = Math.min(100, Math.max(0, v));
    if (m !== undefined) this.muted = m === '1' || m.toLowerCase() === 'true';
    this.d.publish();
  }

  // Ours while the TrackURI still names this stream (some renderers re-encode the URI they report).
  private ours(uri: string, s = this.stream!): boolean {
    const mark = s.nonce ?? s.playSessionId;
    if (!mark) return uri === s.url;
    try {
      return decodeURIComponent(uri).includes(mark);
    } catch {
      return uri.includes(mark);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.restarting || this.done) return;
    this.polling = true;
    const dev = this.d.device;
    try {
      const tr = await soap(dev, 'avt', 'GetTransportInfo');
      const pos = await soap(dev, 'avt', 'GetPositionInfo');
      if (this.done) return;
      this.misses = 0;
      const st = tr.CurrentTransportState;
      if (this.restarting) return;
      // The renderer moved on to the song handed over with SetNextAVTransportURI: no gap, no reload.
      if (this.next && pos.TrackURI && this.ours(pos.TrackURI, this.next.stream)) return this.shift();
      // Ended: STOPPED after PLAYING (then the next song, if any), or the renderer moved on to another URI.
      if (this.playedOnce && (st === 'STOPPED' || st === 'NO_MEDIA_PRESENT')) {
        if (!(await this.advance())) await this.end();
        return;
      }
      if (pos.TrackURI && this.stream && !this.ours(pos.TrackURI)) {
        await this.end();
        return;
      }
      if (st === 'PLAYING' || st === 'PAUSED_PLAYBACK') {
        this.playedOnce = true;
        const wasPaused = this.paused;
        this.paused = st === 'PAUSED_PLAYBACK';
        const rel = parseHms(pos.RelTime);
        if (Number.isFinite(rel)) this.positionTicks = (this.stream?.startTicks ?? 0) + Math.round(rel * TICKS_PER_S);
        this.at = Date.now();
        if (wasPaused !== this.paused) void this.report('Progress', this.paused ? 'Pause' : 'Unpause');
      }
      this.d.publish();
    } catch (err) {
      if (this.done) return;
      log.debug(`poll failed: ${String(err)}`);
      // Three in a row: the renderer is gone (Stopped at the last known position).
      if (++this.misses >= DlnaCast.missLimit) await this.end('cast.error.lost');
    } finally {
      this.polling = false;
    }
  }

  async control(cmd: CastCommand): Promise<void> {
    if (this.status !== 'playing' || this.done) return;
    const dev = this.d.device;
    const c = this.state.controls;
    const pos = this.state.positionTicks;
    switch (cmd.type) {
      case 'toggle-pause':
        return this.control({ type: this.paused ? 'resume' : 'pause' });
      case 'pause':
      case 'resume':
        await soap(dev, 'avt', cmd.type === 'pause' ? 'Pause' : 'Play', cmd.type === 'pause' ? {} : { Speed: 1 });
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
        // A direct stream seeks in place; a transcode restarts from there (the DLNA plugin does the same).
        if (this.stream?.transcode) await this.restart(ticks);
        else {
          await soap(dev, 'avt', 'Seek', { Unit: 'REL_TIME', Target: hms(ticks / TICKS_PER_S) });
          this.positionTicks = ticks;
          this.at = Date.now();
        }
        void this.report('Progress', 'TimeUpdate');
        break;
      }
      case 'volume': {
        if (!c.volume || !Number.isFinite(cmd.value)) throw new Error(t('cast.remote.unavailable'));
        const v = Math.round(Math.min(100, Math.max(0, cmd.value)));
        await soap(dev, 'rc', 'SetVolume', { Channel: 'Master', DesiredVolume: v });
        this.volume = v;
        void this.report('Progress', 'VolumeChange');
        break;
      }
      case 'mute':
        if (!c.mute) throw new Error(t('cast.remote.unavailable'));
        await soap(dev, 'rc', 'SetMute', { Channel: 'Master', DesiredMute: cmd.value ? 1 : 0 });
        this.muted = cmd.value;
        void this.report('Progress', 'VolumeChange');
        break;
      case 'next':
      case 'previous': {
        if (!this.state.controls.nextPrev) throw new Error(t('cast.remote.unavailable'));
        // Previous: back to the start past 5 s or on the first song (the music player's rule).
        if (cmd.type === 'previous' && (pos > 5000 * TICKS_PER_MS || this.index === 0)) return this.control({ type: 'seek', positionTicks: 0 });
        const i = this.index + (cmd.type === 'next' ? 1 : -1);
        if (i >= this.ids.length) throw new Error(t('cast.remote.unavailable'));
        await this.jump(i);
        break;
      }
      case 'audio':
      case 'subtitle': {
        // A track change is a restart at the same position (§2.3).
        if (!Number.isInteger(cmd.index) || cmd.index < (cmd.type === 'audio' ? 0 : -1)) return;
        if (cmd.type === 'audio') this.audio = cmd.index;
        else this.sub = cmd.index;
        await this.restart(pos);
        void this.report('Progress', cmd.type === 'audio' ? 'AudioTrackChange' : 'SubtitleTrackChange');
        break;
      }
      default:
        throw new Error(t('cast.remote.unavailable'));
    }
    this.d.publish();
  }

  // shortcut: the old transcode is left to the server's idle timeout, not killed; kill it if servers pile them up.
  private async restart(ticks: number): Promise<void> {
    this.restarting = true;
    this.d.publish();
    try {
      await this.loadAt(ticks);
      this.playedOnce = false;
    } finally {
      this.restarting = false;
    }
  }

  // The next song to the renderer ahead, once per song. A refusal (401 Invalid Action, 501…) turns that off for the
  // cast: songs are then loaded when the one before ends.
  private async queueNext(): Promise<void> {
    const i = this.index + 1;
    if (!this.music || this.nextRefused || this.queueing || this.next || i >= this.ids.length || this.done) return;
    this.queueing = true;
    let s: Stream | undefined;
    try {
      const item = await userItem<BaseItem>(this.d.api, this.d.userId, this.ids[i]);
      if (item.MediaType !== 'Audio' || this.done || this.index + 1 !== i) return;
      s = await this.prepare(0, undefined, item, true);
      if (this.done || this.index + 1 !== i) return;
      await soap(this.d.device, 'avt', 'SetNextAVTransportURI', { NextURI: s.url, NextURIMetaData: didl(s.didl) });
      this.next = { index: i, item, stream: s };
      s = undefined;
    } catch (err) {
      if (err instanceof UpnpError) this.nextRefused = true;
      log.debug(`next song not handed over: ${String(err)}`);
    } finally {
      this.queueing = false;
      if (s?.nonce) this.d.relay?.close(s.nonce);
    }
  }

  // The song handed over ahead plays now: the last one is reported at its full length, this one as a new play.
  private shift(): void {
    const n = this.next!;
    this.next = undefined;
    this.positionTicks = this.item?.RunTimeTicks ?? this.positionTicks;
    void this.report('Stopped');
    if (this.nonce) this.d.relay?.close(this.nonce);
    this.item = n.item;
    this.index = n.index;
    this.stream = n.stream;
    this.nonce = n.stream.nonce;
    this.audio = undefined;
    this.sub = undefined;
    this.positionTicks = 0;
    this.at = Date.now();
    this.paused = false;
    void this.report('Playing');
    this.d.publish();
    void this.queueNext();
  }

  // The end of a song: the next one, loaded now (no SetNextAVTransportURI). False: nothing follows, or it failed.
  private async advance(): Promise<boolean> {
    if (!this.music || this.index + 1 >= this.ids.length) return false;
    this.positionTicks = this.item?.RunTimeTicks ?? this.positionTicks;
    try {
      await this.jump(this.index + 1);
      return true;
    } catch (err) {
      log.warn('next song failed', err);
      return false;
    }
  }

  // Song i of the queue now: Stopped for this one, the load, Playing for that one.
  private async jump(i: number): Promise<void> {
    this.restarting = true;
    this.d.publish();
    try {
      const item = await userItem<BaseItem>(this.d.api, this.d.userId, this.ids[i]);
      this.dropNext();
      await this.report('Stopped');
      this.item = item;
      this.index = i;
      this.stream = undefined;
      this.audio = undefined;
      this.sub = undefined;
      await this.loadAt(0);
      this.playedOnce = false;
    } finally {
      this.restarting = false;
    }
    void this.report('Playing');
    this.d.publish();
    void this.queueNext();
  }

  private dropNext(): void {
    const n = this.next;
    this.next = undefined;
    if (n?.stream.nonce) this.d.relay?.close(n.stream.nonce);
  }

  // The renderer stops, the server gets Stopped.
  async stop(): Promise<void> {
    if (this.done) return;
    const playing = this.status === 'playing';
    const loaded = Boolean(this.stream);
    this.finish();
    if (loaded) await soap(this.d.device, 'avt', 'Stop').catch((err) => log.warn('Stop to the renderer failed', err));
    if (playing) await this.report('Stopped');
    this.d.ended();
  }

  // The end of the media, or the renderer lost.
  private async end(errorKey?: string): Promise<void> {
    if (this.done) return;
    this.finish();
    await this.report('Stopped');
    this.d.ended(errorKey);
  }

  private finish(): void {
    this.done = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.dropNext();
    if (this.nonce) this.d.relay?.close(this.nonce);
    this.nonce = undefined;
  }

  // "Reprendre ici": where the renderer was, with the same version and tracks.
  playHere(): { itemIds: string[]; startIndex: number; positionTicks: number; msid?: string; audio?: number; sub?: number } {
    return { itemIds: this.ids, startIndex: this.index, positionTicks: this.state.positionTicks, msid: this.stream?.msid, audio: this.audio, sub: this.sub };
  }
}
