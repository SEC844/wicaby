// Jellyfin SyncPlay (watch together) for the web TV app: bridge.syncplay, the UI's in the shared renderer.
// The protocol as jellyfin-web's plugins/syncPlay: REST under /SyncPlay, group updates and timed commands over the
// /socket WebSocket, and the server clock from /GetUtcTime so a command's `When` lands at the same moment everywhere.
// shortcut: speed is assumed 1x and no repeat/shuffle; add them if the group UI ever offers them.
import { TICKS_PER_MS, type PlaybackCommand, type PlaybackState, type PlayRequest, type SyncPlayGroup } from '../../desktop/src/shared/contract';
import { clock } from '../../desktop/src/renderer/lib/format';
import { t } from '../../desktop/src/renderer/lib/i18n.svelte';
import { apiBase, request, type Identity, type StoredServer } from './http';

// ---- Clock and scheduling (pure, tools/checks/syncplay-webtv-check.mjs) ----

// One /GetUtcTime round trip (NTP): t0 sent and t3 received locally, t1 received and t2 sent by the server.
export function clockSample(t0: number, t1: number, t2: number, t3: number): { offset: number; ping: number } {
  return { offset: (t1 - t0 + (t2 - t3)) / 2, ping: Math.max(0, t3 - t0 - (t2 - t1)) };
}

// The sample with the shortest round trip is the least skewed by the network.
export const bestSample = <T extends { ping: number }>(samples: T[]): T | undefined => samples.reduce<T | undefined>((a, b) => (!a || b.ping < a.ping ? b : a), undefined);

// A command due at server time `when`: wait `delayMs`, or, if already late, start further in by as much.
export function schedule(whenServer: number, positionMs: number, nowLocal: number, offset: number): { delayMs: number; positionMs: number } {
  const delayMs = whenServer - offset - nowLocal;
  return delayMs >= 0 ? { delayMs, positionMs } : { delayMs: 0, positionMs: positionMs - delayMs };
}

export const DRIFT_MS = 2000;
// How far the player is from where the group is (positive: ahead), from the last Unpause anchor.
export const drift = (anchor: { positionMs: number; atLocal: number }, nowLocal: number, actualMs: number): number => actualMs - (anchor.positionMs + (nowLocal - anchor.atLocal));

// ---- Server messages ----

interface GroupInfo {
  GroupId: string;
  GroupName: string;
  State: string;
  Participants?: string[];
}
interface PlayQueue {
  Playlist?: { ItemId: string; PlaylistItemId: string }[];
  PlayingItemIndex: number;
  StartPositionTicks?: number;
  IsPlaying?: boolean;
}
interface Command {
  Command: 'Unpause' | 'Pause' | 'Seek' | 'Stop';
  When: string;
  PositionTicks?: number;
  PlaylistItemId?: string;
}

const toGroup = (g: GroupInfo): SyncPlayGroup => ({ id: g.GroupId, name: g.GroupName, members: g.Participants ?? [], state: state(g.State) });
const state = (s: string): SyncPlayGroup['state'] => (['idle', 'waiting', 'paused', 'playing'].includes(s?.toLowerCase()) ? (s.toLowerCase() as SyncPlayGroup['state']) : 'idle');
// Our own request echoed back by the group gets no toast.
const OWN_MS = 2500;

export interface SyncPlayHost {
  server(id?: string): StoredServer | undefined;
  identity: Identity;
  state(): PlaybackState;
  play(req: PlayRequest): Promise<void>;
  local(c: PlaybackCommand): Promise<void>;
  toast(message: string): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

export class SyncPlay {
  private group: SyncPlayGroup | null = null;
  private srv?: StoredServer;
  private ws?: WebSocket;
  private keepAlive?: ReturnType<typeof setInterval>;
  private pinger?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private offset = 0;
  private ping = 0;
  private subs = new Set<(g: SyncPlayGroup | null) => void>();
  private playlistItemId?: string;
  private wantPlaying = false;
  // Ready goes out once the player has loaded or seeked (paused, not buffering).
  private awaitReady = false;
  private anchor?: { positionMs: number; atLocal: number };
  private lastFix = 0;
  private lastOwn = 0;
  private wasActive = false;
  // The group's own Stop ends playback here without leaving the group (desktop's groupStopped).
  private groupStopped = false;

  constructor(private readonly host: SyncPlayHost) {}

  current = (): SyncPlayGroup | null => this.group;
  onChange = (cb: (g: SyncPlayGroup | null) => void): (() => void) => {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  };
  private emit(): void {
    const g = this.group && { ...this.group, members: [...this.group.members] };
    this.subs.forEach((cb) => cb(g));
  }

  // In a group: its server (the socket's); else the one asked for (the item's), the primary when absent.
  private jellyfin(serverId?: string): StoredServer {
    const s = this.srv ?? this.host.server(serverId);
    if (!s || s.kind !== 'jellyfin' || !s.token) throw new Error(t('errors.web.syncJellyfinOnly'));
    return s;
  }
  private api<T>(method: string, path: string, body?: unknown, serverId?: string): Promise<T> {
    return request<T>(this.jellyfin(serverId), this.host.identity, method, path, undefined, body);
  }
  private post(path: string, body: unknown = {}): Promise<void> {
    this.lastOwn = Date.now();
    return this.api<void>('POST', `/SyncPlay/${path}`, body).catch((err: unknown) => this.host.log('warn', `syncplay ${path}: ${String(err)}`));
  }
  private serverNow = () => new Date(Date.now() + this.offset).toISOString();

  async list(serverId?: string): Promise<SyncPlayGroup[]> {
    return (await this.api<GroupInfo[]>('GET', '/SyncPlay/List', undefined, serverId)).map(toGroup);
  }

  async create(name: string, serverId?: string): Promise<void> {
    await this.enter(() => this.api('POST', '/SyncPlay/New', { GroupName: name }), serverId);
    // Created from the player: the film playing becomes the group's, if it is from the group's server.
    const st = this.host.state();
    if (st.active && st.item && this.host.server(st.item.serverId)?.id === this.srv?.id) await this.post('SetNewQueue', { PlayingQueue: [st.item.id], PlayingItemPosition: 0, StartPositionTicks: Math.round(st.positionMs * TICKS_PER_MS) });
  }

  async join(groupId: string, serverId?: string): Promise<void> {
    await this.enter(() => this.api('POST', '/SyncPlay/Join', { GroupId: groupId }), serverId);
  }

  async leave(): Promise<void> {
    if (!this.group && !this.ws) return;
    await this.post('Leave');
    this.reset();
  }

  // The socket first (the server sends the group to this session's socket), then the clock, then the request.
  private async enter(req: () => Promise<unknown>, serverId?: string): Promise<void> {
    if (this.group) await this.leave();
    this.srv = this.jellyfin(serverId);
    try {
      await this.open(this.srv);
      await this.sync();
      await req();
    } catch (err) {
      this.reset();
      throw err;
    }
    this.pinger = setInterval(() => void this.sync().then(() => this.post('Ping', { Ping: Math.round(this.ping) })), 60_000);
    await this.joined();
  }

  // GroupJoined comes over the socket: the item page plays right after create/join, and that play must reach the group.
  private joined(): Promise<void> {
    return new Promise((resolve) => {
      if (this.group) return resolve();
      const done = () => (clearTimeout(timer), off(), resolve());
      const timer = setTimeout(done, 5000);
      const off = this.onChange(done);
    });
  }

  private reset(): void {
    clearInterval(this.keepAlive);
    clearInterval(this.pinger);
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    Object.assign(this, { srv: undefined, playlistItemId: undefined, awaitReady: false, anchor: undefined, wantPlaying: false, groupStopped: false });
    if (this.group) {
      this.group = null;
      this.emit();
    }
  }

  private async sync(): Promise<void> {
    const samples: { offset: number; ping: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const r = await this.api<{ RequestReceptionTime: string; ResponseTransmissionTime: string }>('GET', '/GetUtcTime').catch(() => null);
      if (r) samples.push(clockSample(t0, Date.parse(r.RequestReceptionTime), Date.parse(r.ResponseTransmissionTime), Date.now()));
    }
    const best = bestSample(samples);
    if (best) Object.assign(this, best);
  }

  private open(s: StoredServer): Promise<void> {
    const url = `${apiBase(s).replace(/^http/i, 'ws')}/socket?ApiKey=${encodeURIComponent(s.token ?? '')}&deviceId=${encodeURIComponent(this.host.identity.deviceId)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = setTimeout(() => (ws.close(), reject(new Error(t('errors.connection.timeout')))), 10_000);
      ws.onopen = () => (clearTimeout(fail), resolve());
      ws.onerror = () => (clearTimeout(fail), reject(new Error(t('errors.connection.unreachable'))));
      ws.onmessage = (e) => {
        try {
          this.onMessage(JSON.parse(String(e.data)) as { MessageType: string; Data: unknown });
        } catch (err) {
          this.host.log('warn', `syncplay message: ${String(err)}`);
        }
      };
      // The server dropped us (restart, network): the group is gone for this session.
      ws.onclose = () => void (this.ws === ws && this.reset());
    });
  }

  private onMessage(m: { MessageType: string; Data: unknown }): void {
    if (m.MessageType === 'ForceKeepAlive') {
      clearInterval(this.keepAlive);
      const every = Math.max(5, Number(m.Data) || 60) * 500;
      this.keepAlive = setInterval(() => this.ws?.send(JSON.stringify({ MessageType: 'KeepAlive' })), every);
    } else if (m.MessageType === 'SyncPlayGroupUpdate') this.onUpdate(m.Data as { Type: string; Data: unknown });
    else if (m.MessageType === 'SyncPlayCommand') this.onCommand(m.Data as Command);
  }

  private onUpdate(u: { Type: string; Data: unknown }): void {
    const g = this.group;
    switch (u.Type) {
      case 'GroupJoined':
        this.group = toGroup(u.Data as GroupInfo);
        break;
      case 'UserJoined':
        if (!g) return;
        g.members.push(String(u.Data));
        this.host.toast(t('errors.web.syncJoined', { name: String(u.Data) }));
        break;
      case 'UserLeft':
        if (!g) return;
        g.members = g.members.filter((n, i, a) => i !== a.indexOf(String(u.Data)));
        this.host.toast(t('errors.web.syncLeft', { name: String(u.Data) }));
        break;
      case 'StateUpdate':
        if (!g) return;
        g.state = state((u.Data as { State: string }).State);
        break;
      case 'PlayQueue':
        void this.onQueue(u.Data as PlayQueue).catch((err: unknown) => this.host.log('warn', `syncplay queue: ${String(err)}`));
        return;
      case 'GroupLeft':
      case 'NotInGroup':
      case 'GroupDoesNotExist':
      case 'LibraryAccessDenied':
        return this.reset();
      default:
        return;
    }
    this.emit();
  }

  private async onQueue(q: PlayQueue): Promise<void> {
    const entry = q.Playlist?.[q.PlayingItemIndex];
    if (!entry) return;
    this.wantPlaying = Boolean(q.IsPlaying);
    if (entry.PlaylistItemId === this.playlistItemId) return;
    this.playlistItemId = entry.PlaylistItemId;
    this.anchor = undefined;
    const st = this.host.state();
    const startMs = (q.StartPositionTicks ?? 0) / TICKS_PER_MS;
    if (st.active && st.item?.id === entry.ItemId) {
      await this.host.local({ type: 'pause' });
      await this.host.local({ type: 'seek', positionMs: startMs });
    } else {
      // WebPlayback.play rewinds a resume by 5 s: ask for 5 s further so it starts on the group's position.
      await this.host.play({ itemIds: [entry.ItemId], serverId: this.srv?.id, startPositionTicks: startMs ? (startMs + 5000) * TICKS_PER_MS : 0 });
    }
    this.awaitReady = true;
  }

  private onCommand(c: Command): void {
    if (!this.group) return;
    clearTimeout(this.timer);
    const own = Date.now() - this.lastOwn < OWN_MS;
    const at = schedule(Date.parse(c.When), (c.PositionTicks ?? 0) / TICKS_PER_MS, Date.now(), this.offset);
    const run = (fn: () => void) => (at.delayMs > 0 ? (this.timer = setTimeout(fn, at.delayMs)) : fn());
    switch (c.Command) {
      case 'Unpause':
        // At server time When the group stands at PositionTicks.
        this.anchor = { positionMs: (c.PositionTicks ?? 0) / TICKS_PER_MS, atLocal: Date.parse(c.When) - this.offset };
        run(() => {
          this.lastFix = 0;
          this.correct(this.host.state(), true);
          void this.host.local({ type: 'resume' });
        });
        if (!own) this.host.toast(t('errors.web.syncResumed'));
        break;
      case 'Pause':
        this.anchor = undefined;
        run(() => {
          void this.host.local({ type: 'pause' });
          if (c.PositionTicks !== undefined) void this.host.local({ type: 'seek', positionMs: c.PositionTicks / TICKS_PER_MS });
        });
        if (!own) this.host.toast(t('errors.web.syncPaused'));
        break;
      case 'Seek': {
        const to = (c.PositionTicks ?? 0) / TICKS_PER_MS;
        this.anchor = undefined;
        void this.host.local({ type: 'pause' });
        void this.host.local({ type: 'seek', positionMs: to });
        this.awaitReady = true;
        if (!own) this.host.toast(t('errors.web.syncSeeked', { time: clock(to) }));
        break;
      }
      case 'Stop':
        this.anchor = undefined;
        this.groupStopped = this.host.state().active;
        void this.host.local({ type: 'stop' });
        break;
    }
  }

  // Seek when the player is more than DRIFT_MS from the group (at most every 5 s, the seek itself takes time).
  private correct(st: PlaybackState, starting = false): void {
    if (!this.anchor || (!starting && (st.paused || st.buffering)) || Date.now() < this.anchor.atLocal || Date.now() - this.lastFix < 5000) return;
    const d = drift(this.anchor, Date.now(), st.positionMs);
    if (Math.abs(d) <= DRIFT_MS) return;
    this.lastFix = Date.now();
    void this.host.local({ type: 'seek', positionMs: st.positionMs - d });
  }

  // Every playback state the web player publishes.
  onState(st: PlaybackState): void {
    const was = this.wasActive;
    this.wasActive = st.active;
    const stopped = this.groupStopped;
    if (!st.active) this.groupStopped = false;
    if (!this.group) return;
    // Leaving the player leaves the group, unless the group itself stopped it.
    if (was && !st.active && !stopped) return void this.leave();
    if (!st.active || !this.playlistItemId) return;
    if (this.awaitReady && !st.buffering) {
      this.awaitReady = false;
      if (!st.paused) void this.host.local({ type: 'pause' });
      void this.post('Ready', { When: this.serverNow(), PositionTicks: Math.round(st.positionMs * TICKS_PER_MS), IsPlaying: this.wantPlaying, PlaylistItemId: this.playlistItemId });
      return;
    }
    this.correct(st);
  }

  // The remote's play/pause/seek/next while in a group go to the group; undefined: not ours, the player does it.
  command(c: PlaybackCommand): Promise<void> | undefined {
    if (!this.group || !this.host.state().active) return undefined;
    const st = this.host.state();
    switch (c.type) {
      case 'toggle-pause':
        return this.post(st.paused ? 'Unpause' : 'Pause');
      case 'pause':
        return this.post('Pause');
      case 'resume':
        return this.post('Unpause');
      case 'seek':
      case 'seek-relative': {
        const to = Math.max(0, c.type === 'seek' ? c.positionMs : Math.min(st.durationMs || Infinity, st.positionMs + c.deltaMs));
        return this.post('Seek', { PositionTicks: Math.round(to * TICKS_PER_MS) });
      }
      case 'next':
        return this.post('NextItem', { PlaylistItemId: this.playlistItemId });
      case 'previous':
        return this.post('PreviousItem', { PlaylistItemId: this.playlistItemId });
      default:
        return undefined;
    }
  }

  // Play (or add to the queue) while in a group: the group's queue, which then starts it here and for everyone.
  queue(req: PlayRequest): Promise<void> {
    const ids = req.itemIds.filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
    if (req.command) return this.post('Queue', { ItemIds: ids, Mode: req.command === 'PlayNext' ? 'QueueNext' : 'Queue' });
    return this.post('SetNewQueue', { PlayingQueue: ids, PlayingItemPosition: req.startIndex ?? 0, StartPositionTicks: req.startPositionTicks ?? 0 });
  }
}
