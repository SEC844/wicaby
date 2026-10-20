// Jellyfin SyncPlay (watch together): the /SyncPlay REST requests and the SyncPlayGroupUpdate / SyncPlayCommand
// socket messages, after jellyfin-web's plugins/syncPlay and jellyfin-mpv-shim's syncplay.py. While in a group,
// play, pause, seek and next from this app (OSD, keys, remote) go to the server (PlaybackService.divert) and the
// group's commands come back to the player at their When, in server time (shared/syncplay.ts measures the offset).
import { EventEmitter } from 'node:events';
import { TICKS_PER_MS, type PlaybackCommand, type PlayRequest, type SyncPlayGroup } from '../../shared/contract';
import { driftTarget, measure, TimeSync, type GroupCommand } from '../../shared/syncplay';
import type { ApiClient } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import type { SocketMessage } from '../connection/server-socket';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { PlaybackService } from './playback-service';

const log = logger.scope('syncplay');

interface GroupInfo {
  GroupId?: string;
  GroupName?: string;
  State?: string;
  Participants?: string[];
}

interface PlayQueue {
  Reason?: string;
  Playlist?: { ItemId: string; PlaylistItemId: string }[];
  PlayingItemIndex?: number;
  StartPositionTicks?: number;
}

const STATES = ['idle', 'waiting', 'paused', 'playing'] as const;
const toGroup = (g: GroupInfo): SyncPlayGroup => ({
  id: String(g.GroupId ?? ''),
  name: String(g.GroupName ?? ''),
  members: Array.isArray(g.Participants) ? g.Participants.map(String) : [],
  state: STATES.find((s) => s === g.State?.toLowerCase()) ?? 'idle',
});
const ticks = (ms: number) => Math.max(0, Math.round(ms * TICKS_PER_MS));

export interface SyncPlayDeps {
  connection: ConnectionManager;
  playback: PlaybackService;
  onMessage: (kind: 'info' | 'error', text: string) => void;
}

export class SyncPlay extends EventEmitter {
  private group: SyncPlayGroup | null = null;
  private serverId: string | undefined;
  private readonly clock = new TimeSync();
  private clockTimer: NodeJS.Timeout | null = null;
  private scheduled: NodeJS.Timeout | null = null;
  private last: (GroupCommand & { emitted: string }) | null = null;
  private playlistItemId = '';
  // Set while this class drives the player itself, so divert lets it through.
  private applying = false;
  // A group Stop ends the player without leaving the group.
  private groupStopped = false;
  private wasActive = false;
  private samples = 0;
  private driftAfter = 0;
  // When we last asked for each command, so its echo from the group does not show "Paused by the group".
  private readonly own = new Map<string, number>();

  constructor(private readonly deps: SyncPlayDeps) {
    super();
    deps.playback.divert = { play: (req) => this.divertPlay(req), command: (cmd) => this.divertCommand(cmd), grouped: () => this.group !== null };
    deps.playback.on('state', () => this.onState());
  }

  get current(): SyncPlayGroup | null {
    return this.group;
  }

  // Jellyfin only: Emby and Plex have no SyncPlay.
  private api(serverId = this.serverId): ApiClient {
    const api = this.deps.connection.onlineApi(serverId);
    if (api?.kind !== 'jellyfin') throw new Error(t('main.syncplay.unsupported'));
    return api;
  }

  private target(serverId?: string): string | undefined {
    return serverId ?? this.deps.playback.serverId ?? this.deps.connection.primaryId;
  }

  async list(serverId?: string): Promise<SyncPlayGroup[]> {
    const groups = await this.api(this.target(serverId)).get<GroupInfo[]>('/SyncPlay/List');
    return (Array.isArray(groups) ? groups : []).map(toGroup);
  }

  async create(name: string, serverId?: string): Promise<void> {
    const sid = this.target(serverId);
    const api = this.api(sid);
    await this.bind(sid);
    await api.post('/SyncPlay/New', undefined, { GroupName: name }).catch((err) => this.fail(err));
    await this.joined();
    // What plays here becomes the group's queue (jellyfin-web does the same from its player menu).
    const s = this.deps.playback.getState();
    if (s.active && s.item && this.deps.playback.serverId === sid && !s.trailer && !s.live) {
      await api.post('/SyncPlay/SetNewQueue', undefined, { PlayingQueue: [s.item.id], PlayingItemPosition: 0, StartPositionTicks: ticks(s.positionMs) });
    }
  }

  async join(groupId: string, serverId?: string): Promise<void> {
    const sid = this.target(serverId);
    const api = this.api(sid);
    await this.bind(sid);
    await api.post('/SyncPlay/Join', undefined, { GroupId: groupId }).catch((err) => this.fail(err));
    await this.joined();
  }

  // GroupJoined comes over the socket: the item page plays right after create, and that play must reach the group.
  private joined(): Promise<void> {
    return new Promise((resolve) => {
      if (this.group) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.off('change', done);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      this.on('change', done);
    });
  }

  // A refused New or Join: unbound again, and the caller shows the error.
  private fail(err: unknown): never {
    if (!this.group) this.clear();
    throw err;
  }

  async leave(): Promise<void> {
    if (!this.serverId) return;
    const sid = this.serverId;
    this.clear();
    await this.deps.connection.onlineApi(sid)?.post('/SyncPlay/Leave').catch((err) => log.warn('leave failed', err));
  }

  // Joining another group (or server) leaves the current one first; the clock is measured before commands arrive.
  private async bind(serverId: string | undefined): Promise<void> {
    if (this.serverId) await this.leave();
    this.serverId = serverId;
    this.clock.reset();
    await this.syncClock();
  }

  // /GetUtcTime every second for the first 8 samples, then every 30 s; Ping tells the group our latency.
  private async syncClock(): Promise<void> {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    const sid = this.serverId;
    const api = this.deps.connection.onlineApi(sid);
    if (!api) return;
    try {
      const sent = Date.now();
      const r = await api.get<{ RequestReceptionTime: string; ResponseTransmissionTime: string }>('/GetUtcTime');
      const sample = measure(sent, Date.parse(r.RequestReceptionTime), Date.parse(r.ResponseTransmissionTime), Date.now());
      if (Number.isFinite(sample.offsetMs)) this.clock.add(sample);
      if (this.group) await api.post('/SyncPlay/Ping', undefined, { Ping: Math.round(this.clock.pingMs) });
    } catch (err) {
      log.debug(`time sync: ${String(err)}`);
    }
    // Left (or rebound) meanwhile: that loop is over.
    if (this.serverId !== sid || this.clockTimer) return;
    this.clockTimer = setTimeout(() => void this.syncClock(), this.samples++ < 8 ? 1000 : 30_000);
  }

  private clear(): void {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.clockTimer = this.scheduled = null;
    this.samples = 0;
    this.last = null;
    this.playlistItemId = '';
    this.serverId = undefined;
    if (this.group) {
      this.group = null;
      this.emit('change', null);
    }
  }

  private changed(): void {
    this.emit('change', this.group && { ...this.group, members: [...this.group.members] });
  }

  // Socket messages of the server this client is grouped on (index.ts routes every SyncPlay* message here).
  onMessage(msg: SocketMessage, serverId: string): void {
    if (serverId !== this.serverId) return;
    const d = (msg.Data ?? {}) as Record<string, unknown>;
    if (msg.MessageType === 'SyncPlayCommand') return this.onCommand(d);
    if (msg.MessageType !== 'SyncPlayGroupUpdate') return;
    const data = d.Data;
    switch (d.Type) {
      case 'GroupJoined':
        this.group = toGroup((data ?? {}) as GroupInfo);
        this.changed();
        return;
      case 'UserJoined':
      case 'UserLeft': {
        if (!this.group || typeof data !== 'string') return;
        const i = this.group.members.indexOf(data);
        if (d.Type === 'UserJoined') this.group.members.push(data);
        else if (i >= 0) this.group.members.splice(i, 1);
        this.deps.playback.notify(d.Type === 'UserJoined' ? 'player.notice.syncplay.joined' : 'player.notice.syncplay.left', { name: data.slice(0, 64) });
        this.changed();
        return;
      }
      case 'StateUpdate':
        if (!this.group) return;
        this.group.state = toGroup({ State: String((data as { State?: string } | undefined)?.State ?? '') }).state;
        this.changed();
        return;
      case 'PlayQueue':
        void this.onQueue((data ?? {}) as PlayQueue);
        return;
      case 'GroupLeft':
      case 'NotInGroup':
        this.clear();
        return;
      case 'GroupDoesNotExist':
      case 'CreateGroupDenied':
      case 'JoinGroupDenied':
      case 'LibraryAccessDenied':
        this.deps.onMessage('error', t('main.syncplay.refused'));
        this.clear();
        return;
    }
  }

  // The group's queue: start (or keep) its current item here, paused at its position, then tell the group we are Ready.
  private async onQueue(q: PlayQueue): Promise<void> {
    const list = Array.isArray(q.Playlist) ? q.Playlist : [];
    const index = Number(q.PlayingItemIndex);
    const entry = list[index];
    if (!entry) return;
    this.playlistItemId = String(entry.PlaylistItemId);
    // Queue edits (Queue, RemoveItems, MoveItem, RepeatMode, ShuffleMode) leave the current item alone.
    if (!['NewPlaylist', 'SetCurrentItem', 'NextItem', 'PreviousItem'].includes(String(q.Reason))) return;
    const startMs = Math.max(0, Number(q.StartPositionTicks) || 0) / TICKS_PER_MS;
    const pb = this.deps.playback;
    const s = pb.getState();
    if (!(s.active && s.item?.id === entry.ItemId && pb.serverId === this.serverId)) {
      const ids = list.map((e) => String(e.ItemId));
      if (this.scheduled) clearTimeout(this.scheduled);
      this.last = null;
      this.applying = true;
      const started = pb.play({ itemIds: ids, startIndex: index, serverId: this.serverId });
      this.applying = false;
      await started.catch((err) => log.warn('group item failed', err));
      if (!pb.getState().active || !this.group) return;
    }
    this.apply({ type: 'pause' });
    this.apply({ type: 'seek', positionMs: startMs });
    await this.ready();
  }

  private async ready(): Promise<void> {
    const s = this.deps.playback.getState();
    if (!s.active || !this.playlistItemId) return;
    this.own.set('Unpause', Date.now());
    await this.api()
      .post('/SyncPlay/Ready', undefined, { When: new Date(this.clock.serverNow()).toISOString(), PositionTicks: ticks(s.positionMs), IsPlaying: !s.paused, PlaylistItemId: this.playlistItemId })
      .catch((err) => log.warn('ready failed', err));
  }

  private onCommand(d: Record<string, unknown>): void {
    if (!this.group) return;
    const command = (['Unpause', 'Pause', 'Seek', 'Stop'] as const).find((c) => c === d.Command);
    if (!command) return;
    const cmd = { command, whenMs: Date.parse(String(d.When)), positionMs: Math.max(0, Number(d.PositionTicks) || 0) / TICKS_PER_MS, emitted: String(d.EmittedAt) };
    if (!Number.isFinite(cmd.whenMs)) return;
    const l = this.last;
    // A literal re-delivery; a resync differs in EmittedAt and still applies.
    if (l && l.command === cmd.command && l.whenMs === cmd.whenMs && l.positionMs === cmd.positionMs && l.emitted === cmd.emitted) return;
    this.last = cmd;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    if (command === 'Stop') {
      this.groupStopped = this.deps.playback.getState().active;
      this.apply({ type: 'stop' });
      return;
    }
    if (Date.now() - (this.own.get(command) ?? 0) > 3000) this.deps.playback.notify(`player.notice.syncplay.${command.toLowerCase()}`);
    const delay = this.clock.delayUntil(cmd.whenMs);
    this.driftAfter = Date.now() + delay + 3000;
    const run = (fn: () => void) => (delay > 0 ? (this.scheduled = setTimeout(fn, delay)) : fn());
    if (command === 'Unpause') {
      // Late: join the group where it is by now.
      if (delay > 0) this.apply({ type: 'seek', positionMs: cmd.positionMs });
      run(() => {
        this.apply({ type: 'resume' });
        if (delay === 0) this.apply({ type: 'seek', positionMs: cmd.positionMs + (this.clock.serverNow() - cmd.whenMs) });
      });
      return;
    }
    run(() => {
      this.apply({ type: 'pause' });
      this.apply({ type: 'seek', positionMs: cmd.positionMs });
      // Only a waiting group sends Seek, and it resumes once every member answers Ready.
      if (command === 'Seek') void this.ready();
    });
  }

  private apply(cmd: PlaybackCommand): void {
    this.applying = true;
    try {
      void this.deps.playback.command(cmd);
    } finally {
      this.applying = false;
    }
  }

  // Leaving the player leaves the group; a playing group pulls a drifted player back (> 2 s).
  private onState(): void {
    const s = this.deps.playback.getState();
    if (this.wasActive && !s.active && this.group && !this.groupStopped) void this.leave();
    if (!s.active) this.groupStopped = false;
    this.wasActive = s.active;
    if (!this.group || !s.active || s.paused || s.buffering || !this.clock.ready || Date.now() < this.driftAfter) return;
    const target = driftTarget(this.last, s.positionMs, this.clock.serverNow());
    if (target === null) return;
    log.debug(`drift ${Math.round(target - s.positionMs)} ms, seeking`);
    this.driftAfter = Date.now() + 3000;
    this.apply({ type: 'seek', positionMs: target });
  }

  private divertPlay(req: PlayRequest): boolean {
    if (this.applying || !this.group || req.trailer || req.command || req.live) return false;
    // Another server's item cannot join this group: it plays here alone, out of the group.
    if ((req.serverId ?? this.deps.connection.primaryId) !== this.serverId) {
      void this.leave();
      return false;
    }
    void this.request('/SyncPlay/SetNewQueue', { PlayingQueue: req.itemIds, PlayingItemPosition: req.startIndex ?? 0, StartPositionTicks: req.startPositionTicks ?? 0 });
    return true;
  }

  private divertCommand(cmd: PlaybackCommand): boolean {
    if (this.applying || !this.group) return false;
    const s = this.deps.playback.getState();
    const seek = (ms: number) => this.request('/SyncPlay/Seek', { PositionTicks: ticks(Math.min(ms, s.durationMs || ms)) }, 'Seek');
    switch (cmd.type) {
      case 'pause':
        void this.request('/SyncPlay/Pause', undefined, 'Pause');
        return true;
      case 'resume':
        void this.request('/SyncPlay/Unpause', undefined, 'Unpause');
        return true;
      case 'toggle-pause':
        void (s.paused ? this.request('/SyncPlay/Unpause', undefined, 'Unpause') : this.request('/SyncPlay/Pause', undefined, 'Pause'));
        return true;
      case 'seek':
        void seek(cmd.positionMs);
        return true;
      case 'seek-relative':
        void seek(s.positionMs + cmd.deltaMs);
        return true;
      case 'next':
        // An intro (cinema mode) is this player's own entry: its end moves on here, not the group.
        if (s.trailer) return false;
        void this.request('/SyncPlay/NextItem', { PlaylistItemId: this.playlistItemId });
        return true;
      case 'previous':
        void (s.positionMs > 5000 ? seek(0) : this.request('/SyncPlay/PreviousItem', { PlaylistItemId: this.playlistItemId }));
        return true;
    }
    return false;
  }

  private async request(path: string, body?: unknown, own?: string): Promise<void> {
    if (own) this.own.set(own, Date.now());
    try {
      await this.api().post(path, undefined, body);
    } catch (err) {
      this.deps.onMessage('error', err instanceof Error ? err.message : String(err));
    }
  }
}
