// The active cast (cast-spec CA-04): one at a time, dispatched by target kind: Sessions API (CA-04), direct DLNA
// (CA-07, dlna-cast.ts, through the LAN relay unless the setting turns it off), Chromecast over CASTV2 (CA-09,
// chromecast-cast.ts). A session target reports its own progress (§2.5): the
// sender only mirrors it, by polling GET /Sessions?DeviceId= every 2 s and, through the server socket, by
// SessionsStart pushes; polling pauses while pushes for the session arrive and resumes after 3 s without one.
import { EventEmitter } from 'node:events';
import {
  TICKS_PER_MS,
  type CastCommand,
  type CastControls,
  type CastStartOptions,
  type CastState,
  type CastTarget,
  type PlaybackCommand,
  type PlayRequest,
  type ServerKind,
} from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import type { ApiClient } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import { userItem } from '../connection/user-routes';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { t } from '../i18n';
import { validId } from '../playback/playback-model';
import { ChromecastCast } from './chromecast-cast';
import { DlnaCast } from './dlna-cast';
import { fetchDescription, type DlnaDevice } from './dlna';
import type { Disposable, EphemeralTokens, TokenKind } from './ephemeral-token';
import { lanInterfaces } from './lan';
import { castSeeds, discoverCast, type CastDevice } from './mdns';
import { Relay } from './relay';
import { controllableSessions, requestFor, sendPlay, sendRequest, sessionsOfDevice } from './sessions-sender';
import { discover, seedLocations } from './ssdp';
import { controlsFor, mergeTargets, playQuery, sessionsOnly, sessionTargets, type SessionDto } from './targets';

const log = logger.scope('cast');

// What the player hands off (PlaybackService.castSnapshot): the queue without trailers, where it is, which tracks.
export interface CastSnapshot {
  serverId: string;
  itemIds: string[];
  startIndex: number;
  positionTicks: number;
  msid?: string;
  audio?: number;
  sub?: number;
  live: boolean;
  // Live TV zap policy of the server (livetv-spec-final §8.1): bbm releases the tuner before the target tunes.
  policy: 'mbb' | 'bbm';
}

// The PlaybackService side a cast needs.
export interface LocalPlayer {
  castSnapshot(): CastSnapshot | null;
  command(cmd: PlaybackCommand): Promise<void>;
  stop(): Promise<void>;
  play(req: PlayRequest): Promise<void>;
}

export interface CastDeps {
  connection: Pick<ConnectionManager, 'onlineApi' | 'userIdFor' | 'sessionFor' | 'socketSend'>;
  local: LocalPlayer;
  deviceId: string;
  notify: (kind: 'info' | 'success' | 'error', message: string) => void;
  // cast.discovery (SSDP off without settings) and cast.relay (on without settings).
  settings?: Pick<SettingsService, 'value'>;
  // CA-11: disposable Jellyfin tokens for what a renderer gets (none: the user token, §2.6.3).
  tokens?: EphemeralTokens;
}

// A renderer found by SSDP or the dev seed, kept 60 s (§2.2), never written to disk.
interface Found {
  dev: DlnaDevice;
  seed: boolean;
  at: number;
}

// §2.3 for a direct DLNA target: RenderingControl gives volume and mute; tracks are a restart.
export function dlnaTarget(dev: DlnaDevice): CastTarget {
  return {
    key: `d:${dev.udn}`,
    kind: 'dlna',
    section: 'dlna',
    name: dev.name,
    detail: dev.model,
    commands: [...(dev.rc ? ['SetVolume', 'Mute'] : []), 'SetAudioStreamIndex', 'SetSubtitleStreamIndex'],
    mediaTypes: ['Audio', 'Video'],
  };
}

// §2.3 for a Chromecast: receiver volume and mute, tracks (VTT or a restart on the DMR, connectsdk on the Jellyfin
// receiver); next/previous only on the Jellyfin receiver with a queue (ChromecastCast.state).
export function castTarget(dev: CastDevice): CastTarget {
  return {
    key: `c:${dev.id}`,
    kind: 'cast',
    section: 'chromecast',
    name: dev.name,
    detail: dev.model,
    commands: ['SetVolume', 'Mute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex'],
    mediaTypes: dev.video ? ['Audio', 'Video'] : ['Audio'],
  };
}

interface Active {
  target: CastTarget;
  sessionId: string;
  deviceId: string;
  api: ApiClient;
  server: ServerKind;
  ids: string[];
  sentId: string;
  live: boolean;
  status: CastState['status'];
  controls: CastControls;
  item?: CastState['item'];
  positionTicks: number;
  at: number;
  paused: boolean;
  volume?: number;
  muted?: boolean;
  audio?: number;
  sub?: number;
  msid?: string;
  lastPush: number;
  lastPoll: number;
  polling: boolean;
  // SessionsStart sent: SessionsStop goes at the end.
  pushing: boolean;
  // Polls or pushes in a row without the session (or, once playing, without an item).
  misses: number;
  confirm?: () => void;
  timer: NodeJS.Timeout;
}

const finiteOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Options from the renderer: ids checked like any remote id, numbers finite.
function cleanOptions(o: unknown): CastStartOptions {
  const r = (o ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(r.itemIds) ? r.itemIds.filter(validId).slice(0, 1000) : [];
  if (ids.length === 0) throw new Error(t('errors.playback.nothingToPlay'));
  const startIndex = Math.min(Math.max(0, Math.trunc(finiteOr(r.startIndex) ?? 0)), ids.length - 1);
  return { itemIds: ids, startIndex, positionTicks: finiteOr(r.positionTicks), msid: typeof r.msid === 'string' && /^[\w-]{1,128}$/.test(r.msid) ? r.msid : undefined, audio: finiteOr(r.audio), sub: finiteOr(r.sub) };
}

export class CastManager extends EventEmitter {
  static confirmTimeoutMs = 10_000;
  static pollMs = 2000;
  static pushStaleMs = 3000;
  static tickMs = 500;
  static missLimit = 3;
  static discoveryMs = 3000;
  static foundTtlMs = 60_000;
  // The interfaces SSDP searches on (the checks set none: they never multicast on a real LAN).
  static ssdpInterfaces = (): string[] => lanInterfaces();
  static mdnsInterfaces = (): string[] => lanInterfaces();

  // The picker's last rows and the item they were listed for.
  private known = new Map<string, CastTarget>();
  private pickerItem: (Pick<BaseItem, 'Id' | 'Type' | 'MediaType'> & { ChannelId?: string; Status?: string; serverId: string }) | null = null;
  private active: Active | null = null;
  // The direct cast (DLNA or Chromecast), when one is active.
  private direct: DlnaCast | ChromecastCast | null = null;
  private found = new Map<string, Found>();
  private foundCast = new Map<string, { dev: CastDevice; seed: boolean; at: number }>();
  private relay: Relay | null = null;
  private listing = 0;
  // The direct cast's disposable token (CA-11), and whether "Arrêter la diffusion" is ending it.
  private minted: Disposable | null = null;
  private stopping = false;

  constructor(private readonly deps: CastDeps) {
    super();
  }

  // CA-11: revokes the disposable tokens a crash, a quit or a receiver left behind (index.ts: on each session change;
  // also when the picker opens). A receiver's waits until its session is gone.
  cleanupTokens(): Promise<void> {
    return this.deps.tokens?.cleanup((id) => this.deps.connection.onlineApi(id), (tok) => tok === this.minted?.token) ?? Promise.resolve();
  }

  // §2.2 section 1 (sections 2 and 3 arrive with CA-07 and CA-09), from the server that owns the item.
  async targets(itemId: string, serverId?: string): Promise<CastTarget[]> {
    const conn = this.deps.connection;
    const api = conn.onlineApi(serverId);
    const sid = serverId ?? conn.sessionFor()?.server.id;
    if (!api || !sid || !validId(itemId)) return [];
    void this.cleanupTokens();
    const uid = conn.userIdFor(sid);
    const [item, sessions] = await Promise.all([
      userItem<BaseItem & { ChannelId?: string; Status?: string }>(api, uid, itemId).catch(() => null),
      controllableSessions(api, uid).catch((err) => {
        log.warn('could not list the controllable sessions', err);
        return [] as SessionDto[];
      }),
    ]);
    this.pickerItem = item ? { Id: item.Id, Type: item.Type, MediaType: item.MediaType, ChannelId: item.ChannelId, Status: item.Status, serverId: sid } : null;
    const rows = sessionTargets(sessions, { serverId: sid, serverName: conn.sessionFor(sid)?.server.name ?? '', ownDeviceId: this.deps.deviceId, mediaType: item?.MediaType });
    // Direct DLNA and Cast rows (CA-07, CA-09) are dropped for channels, programmes and recordings in progress.
    const direct = !sessionsOnly(item);
    const seq = ++this.listing;
    const list = () => {
      const now = Date.now();
      const dlna = direct ? [...this.found.values()].filter((f) => now - f.at < CastManager.foundTtlMs).map((f) => dlnaTarget(f.dev)) : [];
      const media = this.pickerItem?.MediaType;
      const cast = direct
        ? [...this.foundCast.values()].filter((f) => now - f.at < CastManager.foundTtlMs && (media !== 'Video' || f.dev.video)).map((f) => castTarget(f.dev))
        : [];
      const all = mergeTargets(rows, dlna, cast);
      if (seq === this.listing) {
        this.known = new Map(all.map((r) => [r.key, r]));
        this.emit('targets', all);
      }
      return all;
    };
    list();
    if (direct) await Promise.all([this.discoverDlna(list), this.discoverCast(list)]);
    return list();
  }

  // SSDP (when the setting allows it) and the dev seed: rows are added as renderers answer; complete after 3 s.
  private async discoverDlna(update: () => void): Promise<void> {
    // Without settings (the checks) SSDP stays off: only the dev seed.
    const on = this.deps.settings?.value.cast?.discovery === true;
    const seeds = new Set(seedLocations());
    const pending: Promise<void>[] = [];
    const onFound = (location: string): void => {
      const p = fetchDescription(location)
        .then((dev) => {
          if (!dev) return;
          this.found.set(`d:${dev.udn}`, { dev, seed: seeds.has(location), at: Date.now() });
          update();
        })
        .catch((err: unknown) => log.debug(`description ${location}: ${String(err)}`));
      pending.push(p);
    };
    let failed = false;
    if (on) failed = (await discover(onFound, CastManager.discoveryMs, CastManager.ssdpInterfaces())).failed;
    else seeds.forEach(onFound);
    await Promise.all(pending);
    if (failed) this.deps.notify('info', t('cast.picker.firewall'));
  }

  // mDNS (when the setting allows it) and the dev seed, alongside SSDP.
  private async discoverCast(update: () => void): Promise<void> {
    const seeds = new Set(castSeeds().map((d) => d.id));
    const onFound = (dev: CastDevice): void => {
      this.foundCast.set(`c:${dev.id}`, { dev, seed: seeds.has(dev.id), at: Date.now() });
      update();
    };
    if (this.deps.settings?.value.cast?.discovery === true) await discoverCast(onFound, CastManager.discoveryMs, CastManager.mdnsInterfaces());
    else castSeeds().forEach(onFound);
  }

  get state(): CastState | null {
    if (this.direct) return this.direct.state;
    const a = this.active;
    if (!a) return null;
    const moving = a.status === 'playing' && !a.paused;
    let positionTicks = moving ? a.positionTicks + (Date.now() - a.at) * TICKS_PER_MS : a.positionTicks;
    if (a.item?.runTimeTicks) positionTicks = Math.min(positionTicks, a.item.runTimeTicks);
    return {
      target: a.target,
      status: a.status,
      item: a.item,
      serverId: a.target.serverId!,
      positionTicks: Math.round(positionTicks),
      paused: a.paused,
      volume: a.volume,
      muted: a.muted,
      audio: a.audio,
      sub: a.sub,
      controls: a.controls,
    };
  }

  // A sender-reported cast (direct DLNA, Cast DMR: CA-07, CA-09) asks before quitting (§2.5); session targets
  // report for themselves and keep playing.
  get senderReported(): CastTarget | null {
    // The Jellyfin receiver reports for itself, like a session target.
    if (this.direct) return this.direct instanceof ChromecastCast && !this.direct.reports ? null : this.direct.target;
    return this.active && this.active.target.kind !== 'session' ? this.active.target : null;
  }

  // Local playback starting (PlaybackService.beforePlay): a sender-reported cast reports Stopped first (§1), so two
  // /Sessions/Playing streams never share this DeviceId.
  async stopSenderReported(): Promise<void> {
    if (this.senderReported) await this.stop();
  }

  private publish(): void {
    this.emit('state', this.state);
  }

  // options absent: hand off what the player is playing (§2.4). Resolves once the target took it or the attempt
  // failed; failures are toasts, not errors.
  async start(key: string, options?: unknown): Promise<void> {
    const target = this.known.get(key);
    if (target?.kind === 'dlna' || target?.kind === 'cast') return this.startDirect(target, options);
    if (!target || target.kind !== 'session' || !target.serverId) throw new Error(t('errors.ipc.invalidId'));
    const snap = options === undefined ? this.deps.local.castSnapshot() : null;
    if (options === undefined && !snap) throw new Error(t('errors.playback.nothingToPlay'));
    // The picker lists the item's own server: a session elsewhere does not know these ids.
    if (snap && snap.serverId !== target.serverId) throw new Error(t('errors.ipc.invalidId'));
    const opts: CastStartOptions = snap ? { itemIds: snap.itemIds, startIndex: snap.startIndex, positionTicks: snap.positionTicks, msid: snap.msid, audio: snap.audio, sub: snap.sub } : cleanOptions(options);
    let live = snap ? snap.live : sessionsOnly(this.pickerItem) && this.pickerItem?.Id === opts.itemIds[0];
    // A programme is cast as its channel.
    if (!snap && this.pickerItem?.Type === 'Program' && this.pickerItem.Id === opts.itemIds[0] && validId(this.pickerItem.ChannelId)) {
      opts.itemIds = [this.pickerItem.ChannelId];
      opts.startIndex = 0;
      live = true;
    }
    if (this.pickerItem?.Type === 'TvChannel' && this.pickerItem.Id === opts.itemIds[0]) live = true;

    const api = this.deps.connection.onlineApi(target.serverId);
    if (!api) throw new Error(t('cast.error.unreachable', { device: target.name }));
    await this.stop();
    const sessionId = key.split(':')[2];
    const startIndex = opts.startIndex ?? 0;
    const a: Active = {
      target,
      sessionId,
      deviceId: target.deviceId ?? '',
      api,
      server: api.kind,
      ids: opts.itemIds,
      sentId: opts.itemIds[startIndex],
      live,
      status: 'starting',
      controls: controlsFor(target, api.kind, live ? 1 : opts.itemIds.length),
      positionTicks: live ? 0 : (opts.positionTicks ?? 0),
      at: Date.now(),
      paused: false,
      lastPush: 0,
      lastPoll: 0,
      polling: false,
      pushing: false,
      misses: 0,
      timer: setInterval(() => void this.tick(), CastManager.tickMs),
    };
    this.active = a;
    this.publish();

    // Break-before-make (a server that reported "tuner busy"): the sender's tuner goes before the target tunes.
    const releaseFirst = Boolean(snap?.live && snap.policy === 'bbm');
    if (releaseFirst) await this.deps.local.stop();
    try {
      await sendPlay(api, sessionId, playQuery(opts, live));
    } catch (err) {
      log.warn(`Play to ${target.name} failed`, err);
      return this.fail(a, releaseFirst, 'cast.error.rejected');
    }
    // The 204 only says the server relayed it (§2.4): pause here, stop once the target shows the item.
    if (snap && !releaseFirst) await this.deps.local.command({ type: 'pause' });
    this.deps.connection.socketSend(target.serverId, 'SessionsStart', '0,1500');
    a.pushing = true;
    const confirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CastManager.confirmTimeoutMs);
      a.confirm = () => (clearTimeout(timer), resolve(true));
      void this.poll(a);
    });
    a.confirm = undefined;
    if (this.active !== a) return;
    if (!confirmed) return this.fail(a, releaseFirst, 'cast.error.unreachable', Boolean(snap));
    // Reports Stopped at the handoff position (the player is paused there).
    if (snap && !releaseFirst) await this.deps.local.stop();
    a.status = 'playing';
    a.at = Date.now();
    this.publish();
    this.deps.notify('success', t('cast.toast.started', { device: target.name }));
  }

  // resumeLocal: a handoff that paused the player resumes it. A break-before-make channel stays as a failed cast,
  // whose bar offers "Reprendre ici" (re-tunes here).
  private fail(a: Active, releasedFirst: boolean, key: string, resumeLocal = false): void {
    const name = a.target.name;
    if (releasedFirst) {
      this.quiet(a);
      a.status = 'failed';
      this.publish();
    } else this.end(a);
    if (resumeLocal && !releasedFirst) void this.deps.local.command({ type: 'resume' });
    this.deps.notify('error', t(key, { device: name }));
  }

  // No more mirroring.
  private quiet(a: Active): void {
    clearInterval(a.timer);
    a.confirm = undefined;
    if (a.pushing) this.deps.connection.socketSend(a.target.serverId!, 'SessionsStop', '');
    a.pushing = false;
  }

  private end(a: Active): void {
    this.quiet(a);
    if (this.active === a) {
      this.active = null;
      this.publish();
    }
  }

  async control(cmd: CastCommand): Promise<void> {
    if (this.direct) return this.direct.control(cmd);
    const a = this.active;
    if (!a || a.status !== 'playing') return;
    const pos = this.state!.positionTicks;
    const req = requestFor(cmd, { server: a.server, controls: a.controls, positionTicks: pos });
    if (!req) throw new Error(t('cast.remote.unavailable'));
    await sendRequest(a.api, a.sessionId, req);
    // Shown at once; the next push or poll corrects it.
    const now = Date.now();
    if (cmd.type === 'pause' || cmd.type === 'resume' || cmd.type === 'toggle-pause') {
      a.positionTicks = pos;
      a.at = now;
      a.paused = cmd.type === 'pause' || (cmd.type === 'toggle-pause' && !a.paused);
    } else if ('playstate' in req && req.seekTicks !== undefined) {
      a.positionTicks = req.playstate === 'SeekRelative' ? Math.max(0, pos + req.seekTicks) : req.seekTicks;
      a.at = now;
    } else if (cmd.type === 'volume') a.volume = Math.round(Math.min(100, Math.max(0, cmd.value)));
    else if (cmd.type === 'mute') a.muted = cmd.value;
    else if (cmd.type === 'audio') a.audio = cmd.index;
    else if (cmd.type === 'subtitle') a.sub = cmd.index;
    this.publish();
  }

  // "Arrêter la diffusion": the target stops, the cast ends.
  async stop(): Promise<void> {
    if (this.direct) {
      this.stopping = true;
      try {
        return await this.direct.stop();
      } finally {
        this.stopping = false;
      }
    }
    const a = this.active;
    if (!a) return;
    this.end(a);
    if (a.status !== 'failed') await sendRequest(a.api, a.sessionId, { playstate: 'Stop' }).catch((err) => log.warn('Stop to the target failed', err));
  }

  // "Reprendre ici" (§2.4): the target's position, stop it, then play here from there. A channel re-tunes.
  async takeBack(): Promise<void> {
    if (this.direct) {
      const d = this.direct;
      const h = d.playHere();
      const serverId = d.target.serverId;
      await this.stop();
      return this.deps.local.play({
        itemIds: h.itemIds,
        startIndex: h.startIndex,
        serverId,
        startPositionTicks: h.positionTicks ? h.positionTicks + 5000 * TICKS_PER_MS : undefined,
        mediaSourceId: h.msid,
        audioStreamIndex: h.audio,
        subtitleStreamIndex: h.sub,
      });
    }
    const a = this.active;
    const st = this.state;
    if (!a || !st) return;
    await this.stop();
    const id = st.item?.id && validId(st.item.id) ? st.item.id : a.sentId;
    const index = a.ids.indexOf(id);
    const same = id === a.sentId || index >= 0;
    await this.deps.local.play({
      itemIds: a.live || index < 0 ? [id] : a.ids,
      startIndex: a.live || index < 0 ? 0 : index,
      serverId: a.target.serverId,
      // play() rewinds a resume by 5 s; a handoff carries on where the target was.
      startPositionTicks: a.live || !st.positionTicks ? undefined : st.positionTicks + 5000 * TICKS_PER_MS,
      mediaSourceId: a.live || !same ? undefined : a.msid,
      audioStreamIndex: a.live || !same ? undefined : st.audio,
      subtitleStreamIndex: a.live || !same ? undefined : st.sub,
    });
  }

  // A Sessions push from the server's socket (routed by index.ts). Non-admins get only their own sessions (§3.8):
  // a push without ours leaves the polling to carry on.
  onSessions(serverId: string, data: unknown): void {
    const a = this.active;
    if (!a || serverId !== a.target.serverId || !Array.isArray(data)) return;
    const s = (data as SessionDto[]).find((x) => x?.Id === a.sessionId);
    if (!s) return;
    a.lastPush = Date.now();
    this.apply(a, s);
  }

  private async tick(): Promise<void> {
    const a = this.active;
    if (!a) return;
    const now = Date.now();
    if (now - a.lastPush >= CastManager.pushStaleMs && now - a.lastPoll >= CastManager.pollMs) await this.poll(a);
    if (this.active === a && a.status === 'playing' && !a.paused) this.publish();
  }

  private async poll(a: Active): Promise<void> {
    if (a.polling) return;
    a.polling = true;
    a.lastPoll = Date.now();
    try {
      const list = await sessionsOfDevice(a.api, a.deviceId);
      if (this.active === a) this.apply(a, list.find((s) => s.Id === a.sessionId) ?? null);
    } catch (err) {
      log.debug(`mirror poll failed: ${String(err)}`);
      if (this.active === a) this.apply(a, null);
    } finally {
      a.polling = false;
    }
  }

  private apply(a: Active, s: SessionDto | null): void {
    // Gone from the server, or (once playing) playing nothing: three times in a row ends the cast.
    if (!s || (a.status === 'playing' && !s.NowPlayingItem)) {
      // While starting, the confirmation timeout decides.
      if (a.status === 'starting') return;
      if (++a.misses < CastManager.missLimit) return;
      this.end(a);
      if (!s) this.deps.notify('error', t('cast.error.lost', { device: a.target.name }));
      return;
    }
    a.misses = 0;
    const n = s.NowPlayingItem;
    if (!n) return;
    const p = s.PlayState ?? {};
    a.item = { id: n.Id, name: n.Name ?? '', type: n.Type, seriesName: n.SeriesName, runTimeTicks: finiteOr(n.RunTimeTicks) };
    a.positionTicks = finiteOr(p.PositionTicks) ?? 0;
    a.at = Date.now();
    a.paused = Boolean(p.IsPaused);
    a.volume = finiteOr(p.VolumeLevel);
    a.muted = typeof p.IsMuted === 'boolean' ? p.IsMuted : undefined;
    a.audio = finiteOr(p.AudioStreamIndex);
    a.sub = finiteOr(p.SubtitleStreamIndex);
    a.msid = p.MediaSourceId;
    if (a.status === 'starting' && n.Id === a.sentId) a.confirm?.();
    this.publish();
  }

  // A direct cast (DLNA, dlna-cast.ts; Chromecast, chromecast-cast.ts): the item's server (the player's, or the
  // picker's), the device's own stream.
  private async startDirect(row: CastTarget, options: unknown): Promise<void> {
    const found = row.kind === 'dlna' ? this.found.get(row.key) : this.foundCast.get(row.key);
    const snap = options === undefined ? this.deps.local.castSnapshot() : null;
    if (options === undefined && !snap) throw new Error(t('errors.playback.nothingToPlay'));
    const opts: CastStartOptions = snap ? { itemIds: snap.itemIds, startIndex: snap.startIndex, positionTicks: snap.positionTicks, msid: snap.msid, audio: snap.audio, sub: snap.sub } : cleanOptions(options);
    const serverId = snap?.serverId ?? this.pickerItem?.serverId;
    // Channels, programmes and recordings in progress never go direct (the picker does not list them either).
    const live = snap ? snap.live : sessionsOnly(this.pickerItem) && this.pickerItem?.Id === opts.itemIds[opts.startIndex ?? 0];
    if (!found || !serverId || live) throw new Error(t('errors.ipc.invalidId'));
    const api = this.deps.connection.onlineApi(serverId);
    if (!api) throw new Error(t('cast.error.unreachable', { device: row.name }));
    await this.stop();
    const relayOn = this.deps.settings?.value.cast?.relay !== false;
    if (relayOn) this.relay ??= new Relay();
    // CA-11: minted once, the first time the cast needs a token for the device (not through the relay).
    let minting: Promise<Disposable | null> | null = null;
    const tokens = this.deps.tokens;
    const token = tokens
      ? async (kind: TokenKind) => {
          minting ??= tokens.mint(api, serverId, row.name, kind).then((m) => {
            if (m && this.direct === cast) this.minted = m;
            else if (m) void tokens.revoke(m, api);
            return m;
          });
          const m = await minting;
          // Stopped while minting: no URL goes out, least of all one with the user token.
          if (this.direct !== cast) throw new Error('cast ended');
          return m?.token;
        }
      : undefined;
    const common = {
      token,
      api,
      userId: this.deps.connection.userIdFor(serverId),
      target: { ...row, serverId },
      relay: relayOn ? this.relay : null,
      seed: found.seed,
      deviceId: this.deps.deviceId,
      publish: () => {
        if (this.direct === cast) this.publish();
      },
      ended: (key?: string) => {
        if (this.direct !== cast) return;
        this.direct = null;
        // A sender's token goes with its cast; a receiver's on Stop, or when it never started (CA-11 rules 6 and 7).
        const m = this.minted;
        this.minted = null;
        if (m && (m.kind === 'sender' || this.stopping || cast.status !== 'playing')) void tokens?.revoke(m, api);
        this.publish();
        if (key) this.deps.notify('error', t(key, { device: row.name }));
      },
    };
    const prefs = this.deps.settings?.value.cast;
    const cast: DlnaCast | ChromecastCast =
      'udn' in found.dev
        ? new DlnaCast({ ...common, device: found.dev })
        : new ChromecastCast({
            ...common,
            device: found.dev,
            prefs: { allowHevc: prefs?.allowHevc === true, dolby: prefs?.dolby === true },
            server: { id: serverId, version: this.deps.connection.sessionFor(serverId)?.server.version ?? '' },
          });
    this.direct = cast;
    this.publish();
    await cast.start(opts, snap ? this.deps.local : null);
    if (this.direct === cast && cast.status === 'playing') this.deps.notify('success', t('cast.toast.started', { device: row.name }));
  }

  // Quit: session targets and the Jellyfin receiver keep playing; only the mirror stops. A sender-reported cast was
  // stopped by the quit prompt.
  dispose(): void {
    if (this.active) this.end(this.active);
    if (this.direct instanceof ChromecastCast && !this.direct.reports) this.direct.detach();
    this.relay?.shutdown();
  }
}
