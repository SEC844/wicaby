// Playback for the web TV app: the desktop's playback service in miniature (main/playback/playback-service.ts).
// PlaybackInfo with the 'tv' device profile, then a direct or HLS URL for routes/Player.svelte's <video> (through
// the same htmlPlayer load/command/event messages), and the server's start / progress / stopped reports.
// shortcut: no up next, cinema mode, intro skip, quality sheet, trickplay or music engine; add them from
// playback-service.ts when the TV app needs them.
import { TICKS_PER_MS, type HtmlPlayerCommand, type HtmlPlayerEvent, type HtmlPlayerLoad, type NowPlayingItem, type PlaybackCommand, type PlaybackState, type PlayMethod, type PlayRequest, type Settings, type Track } from '../../desktop/src/shared/contract';
import { buildDeviceProfile } from '../../desktop/src/shared/device-profile';
import type { BaseItem, MediaSource, MediaStream } from '../../desktop/src/shared/models';
import { selectTracks } from '../../desktop/src/shared/track-selection';
import { t } from '../../desktop/src/renderer/lib/i18n.svelte';
import { demoVideoUrl, DEMO_ADDRESS } from './demo';
import { apiBase, buildQuery, request, type Identity, type StoredServer } from './http';
import { onTv } from './tv';

export interface PlaybackHost {
  server(id?: string): StoredServer | undefined;
  identity: Identity;
  settings(): Settings;
  load(l: HtmlPlayerLoad): void;
  command(c: HtmlPlayerCommand): void;
  publish(s: PlaybackState): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

interface PlaybackInfo {
  PlaySessionId?: string;
  ErrorCode?: string;
  MediaSources?: MediaSource[];
}

const PROGRESS_MS = 10_000;

export function idle(volume = 100, muted = false): PlaybackState {
  return { active: false, positionMs: 0, durationMs: 0, paused: false, buffering: false, volume, muted, rate: 1, audioTracks: [], subtitleTracks: [], audioIndex: null, subtitleIndex: null, queueIndex: 0, queueLength: 0, fullscreen: false, offline: false, stats: {} };
}

const label = (s: MediaStream) => s.DisplayTitle || [s.Language, s.Codec?.toUpperCase()].filter(Boolean).join(' · ') || `#${s.Index}`;
const toTrack = (s: MediaStream): Track => ({ index: s.Index, label: label(s), language: s.Language, codec: s.Codec, isDefault: Boolean(s.IsDefault), isForced: Boolean(s.IsForced), isExternal: Boolean(s.IsExternal) });

// A server URL (absolute or relative to the API base) with the token in the query, as <video> and hls.js cannot
// send headers. Only for the server's own origin; another origin gets no token.
export function mediaUrl(s: StoredServer, url: string): string | null {
  const base = apiBase(s);
  // Only http(s) or a server-relative path: never file:, data:, or a protocol-relative '//host'.
  if ((/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) || url.startsWith('//')) return null;
  let full: URL;
  try {
    const rel = url.startsWith('/') ? url : `/${url}`;
    // Emby's URLs may already carry the /emby prefix the base ends with.
    full = new URL(/^https?:\/\//i.test(url) ? url : `${base}${s.kind === 'emby' && /^\/emby\//i.test(rel) ? rel.slice(5) : rel}`);
  } catch {
    return null;
  }
  if (full.protocol !== 'http:' && full.protocol !== 'https:') return null;
  if (full.origin !== new URL(base).origin) return full.href;
  // Emby reads api_key; Jellyfin ApiKey (it dropped api_key in 10.11).
  if (s.token && !/[?&](api_key|ApiKey)=/i.test(full.search)) full.searchParams.set(s.kind === 'jellyfin' ? 'ApiKey' : 'api_key', s.token);
  return full.href;
}

export class WebPlayback {
  private state = idle();
  private queue: string[] = [];
  private serverId?: string;
  private index = 0;
  private item?: BaseItem;
  private source?: MediaSource;
  private playSessionId?: string;
  private playMethod: PlayMethod = 'DirectPlay';
  private lastProgress = 0;
  private started = false;
  private seq = 0;

  constructor(private readonly host: PlaybackHost) {}

  get value(): PlaybackState {
    return this.state;
  }

  private publish(): void {
    this.host.publish({ ...this.state });
  }

  private api<T>(method: string, path: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown): Promise<T> {
    const s = this.host.server(this.serverId);
    if (!s) return Promise.reject(new Error(t('errors.connection.noServerConnected')));
    return request<T>(s, this.host.identity, method, path, query, body);
  }

  async play(req: PlayRequest): Promise<void> {
    const ids = (req.itemIds ?? []).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id)).slice(0, 1000);
    if (!ids.length) throw new Error(t('errors.playback.nothingToPlay'));
    if ((req.command === 'PlayNext' || req.command === 'PlayLast') && this.state.active) {
      this.queue.splice(req.command === 'PlayNext' ? this.index + 1 : this.queue.length, 0, ...ids);
      this.state.queueLength = this.queue.length;
      this.publish();
      return;
    }
    await this.stopped();
    this.queue = ids;
    this.serverId = req.serverId;
    this.index = Math.min(req.startIndex ?? 0, ids.length - 1);
    // Resuming rewinds 5 s, like the desktop.
    const startMs = req.startPositionTicks ? Math.max(0, req.startPositionTicks / TICKS_PER_MS - 5000) : 0;
    try {
      await this.start({ startMs, mediaSourceId: req.mediaSourceId, audio: req.audioStreamIndex, subtitle: req.subtitleStreamIndex });
    } catch (err) {
      // The previous item is already reported stopped: unload it rather than leave it playing untracked.
      await this.stop();
      throw err;
    }
  }

  private async start(o: { startMs: number; mediaSourceId?: string; audio?: number; subtitle?: number; rate?: number }): Promise<void> {
    const seq = ++this.seq;
    const s = this.host.server(this.serverId);
    if (!s?.userId) throw new Error(t('errors.connection.notSignedIn'));
    const id = this.queue[this.index];
    // Jellyfin 10.9+ moved the per-user routes to ?userId= (lib/api.ts userRoute); its /Users/{id}/Items is obsolete.
    const item = await (s.kind === 'jellyfin' ? this.api<BaseItem>('GET', `/Items/${id}`, { userId: s.userId }) : this.api<BaseItem>('GET', `/Users/${s.userId}/Items/${id}`));
    if (seq !== this.seq) return;
    const pb = this.host.settings().playback;
    // A reload keeps the current speed; a new item gets "Vitesse par défaut" if it is a film or episode, as on the desktop.
    const rate = o.rate ?? (item.MediaType === 'Video' && item.Type !== 'TvChannel' ? pb.defaultSpeed : 1);
    let source = item.MediaSources?.find((m) => m.Id === o.mediaSourceId) ?? item.MediaSources?.[0];
    const streams0 = source?.MediaStreams ?? item.MediaStreams ?? [];
    const picked = selectTracks(
      streams0,
      { audio: source?.DefaultAudioStreamIndex, subtitle: source?.DefaultSubtitleStreamIndex },
      { audioLanguage: pb.preferredAudioLanguage, subtitleLanguage: pb.preferredSubtitleLanguage, mode: pb.subtitleMode, forced: pb.alwaysForced },
      undefined,
      o.audio,
      o.subtitle,
    );
    const maxBitrate = Math.round(pb.maxBitrateMbps * 1_000_000);
    const ticks = Math.round(o.startMs * TICKS_PER_MS);
    // A desktop browser (the Pages demo, a laptop) gets the desktop's <video> profile; a TV its own.
    const profile = buildDeviceProfile(onTv ? 'tv' : 'html', maxBitrate, s.kind, pb.maxResolution);
    const audio = streams0.filter((m) => m.Type === 'Audio');
    const defaultAudio = (audio.find((a) => a.IsDefault) ?? audio[0])?.Index;
    // <video> plays the default audio track only: another one needs the server to remux.
    const forceStream = picked.audio !== null && defaultAudio !== undefined && picked.audio !== defaultAudio;
    const info = await this.api<PlaybackInfo>(
      'POST',
      `/Items/${id}/PlaybackInfo`,
      { UserId: s.userId, StartTimeTicks: ticks, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: maxBitrate, MediaSourceId: source?.Id, AudioStreamIndex: picked.audio ?? undefined, SubtitleStreamIndex: picked.subtitle ?? undefined },
      {
        DeviceProfile: profile,
        UserId: s.userId,
        MediaSourceId: source?.Id,
        AudioStreamIndex: picked.audio ?? undefined,
        SubtitleStreamIndex: picked.subtitle ?? undefined,
        MaxStreamingBitrate: maxBitrate,
        StartTimeTicks: ticks,
        IsPlayback: true,
        AutoOpenLiveStream: true,
        EnableDirectPlay: !forceStream && !pb.forceTranscode,
        EnableDirectStream: !pb.forceTranscode,
        EnableTranscoding: true,
        AllowVideoStreamCopy: !pb.forceTranscode,
        AllowAudioStreamCopy: true,
      },
    );
    if (seq !== this.seq) return;
    if (info.ErrorCode) throw new Error(t('errors.playback.refused', { code: info.ErrorCode }));
    const ps = info.MediaSources?.find((m) => m.Id === source?.Id) ?? info.MediaSources?.[0];
    if (!ps) throw new Error(t('errors.playback.noMediaSource'));
    source = ps;
    const streams = ps.MediaStreams ?? streams0;
    let url: string | null;
    let isHls = false;
    let startMs = o.startMs;
    let subtitleIndex = picked.subtitle;
    if (s.address === DEMO_ADDRESS) {
      url = demoVideoUrl();
      this.playMethod = 'DirectPlay';
    } else if (ps.SupportsDirectPlay && !forceStream && !pb.forceTranscode) {
      const kind = item.MediaType === 'Audio' ? 'Audio' : 'Videos';
      url = mediaUrl(s, `/${kind}/${id}/stream${buildQuery({ Static: true, MediaSourceId: ps.Id, PlaySessionId: info.PlaySessionId, DeviceId: this.host.identity.deviceId, LiveStreamId: ps.LiveStreamId })}`);
      this.playMethod = 'DirectPlay';
    } else if (ps.TranscodingUrl) {
      url = mediaUrl(s, ps.TranscodingUrl);
      isHls = (ps.TranscodingSubProtocol ?? '').toLowerCase() === 'hls' || /\.m3u8/i.test(ps.TranscodingUrl);
      this.playMethod = /videocodec=copy/i.test(ps.TranscodingUrl) ? 'DirectStream' : 'Transcode';
      // Emby and Jellyfin HLS playlists cover the whole runtime: seek to startMs. Only a server that echoes
      // StartTimeTicks (a stream cut at the resume point, as Plex) starts there (playback-service.ts baseMs).
      if (ps.StartTimeTicks) startMs = Math.max(0, startMs - ps.StartTimeTicks / TICKS_PER_MS);
    } else url = null;
    if (!url) throw new Error(t('errors.playback.noPlayMethod'));
    const external = streams
      .filter((m) => m.Type === 'Subtitle' && m.DeliveryMethod === 'External' && m.DeliveryUrl)
      .flatMap((m) => {
        const u = mediaUrl(s, m.DeliveryUrl!);
        return u ? [{ index: m.Index, url: u, label: label(m), language: m.Language }] : [];
      });
    // A burnt-in subtitle is part of the picture; one the transcode cannot carry is off.
    if (this.playMethod !== 'DirectPlay' && subtitleIndex !== null && !external.some((e) => e.index === subtitleIndex) && streams.find((m) => m.Index === subtitleIndex)?.DeliveryMethod !== 'Encode') subtitleIndex = null;

    this.item = item;
    this.source = ps;
    this.playSessionId = info.PlaySessionId;
    this.started = false;
    this.lastProgress = 0;
    const video = streams.find((m) => m.Type === 'Video');
    const now: NowPlayingItem = {
      id: item.Id,
      serverId: this.serverId,
      name: item.Name ?? '',
      type: item.Type,
      seriesName: item.SeriesName,
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
      year: item.ProductionYear,
      imageItemId: item.ImageTags?.Primary ? item.Id : item.SeriesId,
      imageTag: item.ImageTags?.Primary ?? item.SeriesPrimaryImageTag,
      chapters: [],
    } as NowPlayingItem;
    this.state = {
      ...idle(this.state.volume, this.state.muted),
      active: true,
      player: 'html',
      item: now,
      durationMs: (ps.RunTimeTicks ?? item.RunTimeTicks ?? 0) / TICKS_PER_MS,
      positionMs: o.startMs,
      buffering: true,
      audioTracks: streams.filter((m) => m.Type === 'Audio').map(toTrack),
      subtitleTracks: streams.filter((m) => m.Type === 'Subtitle').map(toTrack),
      audioIndex: picked.audio,
      subtitleIndex,
      playMethod: this.playMethod,
      queueIndex: this.index,
      queueLength: this.queue.length,
      rate,
      stats: { resolution: video?.Width ? `${video.Width}×${video.Height}` : undefined, videoCodec: video?.Codec },
    };
    this.publish();
    this.host.load({ url, isHls, startMs, volume: this.state.volume, muted: this.state.muted, subtitles: external, subtitleIndex: external.some((e) => e.index === subtitleIndex) ? subtitleIndex : null, rate });
  }

  private reportBody(): Record<string, unknown> {
    return {
      ItemId: this.item?.Id,
      MediaSourceId: this.source?.Id,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.round(this.state.positionMs * TICKS_PER_MS),
      IsPaused: this.state.paused,
      IsMuted: this.state.muted,
      VolumeLevel: this.state.volume,
      PlayMethod: this.playMethod,
      AudioStreamIndex: this.state.audioIndex ?? undefined,
      SubtitleStreamIndex: this.state.subtitleIndex ?? undefined,
      CanSeek: true,
      QueueableMediaTypes: ['Video'],
    };
  }

  private report(path: string): void {
    if (!this.item) return;
    this.api('POST', path, undefined, this.reportBody()).catch((err: unknown) => this.host.log('warn', `report ${path}: ${String(err)}`));
  }

  private async stopped(): Promise<void> {
    if (!this.item) return;
    const body = this.reportBody();
    this.item = undefined;
    await this.api('POST', '/Sessions/Playing/Stopped', undefined, body).catch((err: unknown) => this.host.log('warn', `report stopped: ${String(err)}`));
  }

  onEvent(ev: HtmlPlayerEvent): void {
    if (!this.state.active) return;
    switch (ev.type) {
      case 'time': {
        const changed = ev.paused !== this.state.paused;
        Object.assign(this.state, { positionMs: ev.positionMs, paused: ev.paused, buffering: ev.buffering });
        if (ev.durationMs > 0 && this.playMethod === 'DirectPlay') this.state.durationMs = ev.durationMs;
        if (!this.started && !ev.buffering && ev.positionMs >= 0) {
          this.started = true;
          this.report('/Sessions/Playing');
        } else if (this.started && (changed || Date.now() - this.lastProgress > PROGRESS_MS)) {
          this.lastProgress = Date.now();
          this.report('/Sessions/Playing/Progress');
        }
        break;
      }
      case 'volume':
        Object.assign(this.state, { volume: ev.volume, muted: ev.muted });
        break;
      case 'stats':
        this.state.stats = { ...this.state.stats, ...ev.stats };
        break;
      case 'ended':
        void this.advance(1, true);
        return;
      case 'error':
        this.host.log('error', `player: ${ev.message}`);
        this.state.error = ev.message;
        // Published before stop() resets the state, so the bridge toasts it.
        this.publish();
        void this.stop();
        return;
    }
    this.publish();
  }

  private async advance(delta: 1 | -1, ended = false): Promise<void> {
    const next = this.index + delta;
    if (ended && this.item) this.state.positionMs = this.state.durationMs;
    if (next < 0 || next >= this.queue.length || (ended && !this.host.settings().playback.autoPlayNext)) return this.stop();
    // Moved before the await, so a second Next during the Stopped report counts.
    this.index = next;
    await this.stopped();
    await this.start({ startMs: 0 }).catch((err: unknown) => this.fail(err));
  }

  private fail(err: unknown): void {
    this.host.log('error', `playback: ${String(err)}`);
    this.state.error = err instanceof Error ? err.message : String(err);
    this.publish();
    void this.stop();
  }

  async stop(): Promise<void> {
    this.seq++;
    await this.stopped();
    this.host.command({ type: 'unload' });
    this.state = idle(this.state.volume, this.state.muted);
    this.queue = [];
    this.publish();
  }

  async command(c: PlaybackCommand): Promise<void> {
    const st = this.state;
    switch (c.type) {
      case 'toggle-pause':
        return this.host.command({ type: st.paused ? 'play' : 'pause' });
      case 'pause':
        return this.host.command({ type: 'pause' });
      case 'resume':
        return this.host.command({ type: 'play' });
      case 'seek':
      case 'seek-relative': {
        const to = Math.max(0, c.type === 'seek' ? c.positionMs : Math.min(st.durationMs || Infinity, st.positionMs + c.deltaMs));
        // Set now: while paused no 'time' event comes until seeked, and the next press must start from here.
        st.positionMs = to;
        this.publish();
        return this.host.command({ type: 'seek', positionMs: to });
      }
      case 'stop':
        return this.stop();
      case 'next':
        return this.advance(1);
      case 'previous':
        return st.positionMs > 5000 || this.index === 0 ? this.host.command({ type: 'seek', positionMs: 0 }) : this.advance(-1);
      case 'volume':
        return this.host.command({ type: 'volume', value: c.value });
      case 'mute':
        return this.host.command({ type: 'mute', value: c.value });
      case 'rate':
        st.rate = c.value;
        this.publish();
        return this.host.command({ type: 'rate', value: c.value });
      case 'subtitle': {
        const external = st.subtitleTracks.find((s) => s.index === c.index)?.isExternal;
        if (c.index < 0 || (external && this.playMethod === 'DirectPlay')) {
          st.subtitleIndex = c.index < 0 ? null : c.index;
          this.publish();
          return this.host.command({ type: 'subtitle', index: st.subtitleIndex });
        }
        // An embedded subtitle: the server extracts or burns it in, from here.
        return this.reload({ subtitle: c.index });
      }
      case 'audio':
        return this.reload({ audio: c.index });
      default:
        // Desktop-only commands (mpv delays, PiP, aspect, sleep timer, live TV) do nothing here.
        return;
    }
  }

  private async reload(o: { audio?: number; subtitle?: number }): Promise<void> {
    // Paused first, so the old stream stops moving past the position the new one resumes from.
    this.host.command({ type: 'pause' });
    const at = this.state.positionMs;
    await this.stopped();
    await this.start({ startMs: at, mediaSourceId: this.source?.Id, audio: o.audio ?? this.state.audioIndex ?? undefined, subtitle: o.subtitle ?? this.state.subtitleIndex ?? -1, rate: this.state.rate }).catch((err: unknown) => this.fail(err));
  }
}
