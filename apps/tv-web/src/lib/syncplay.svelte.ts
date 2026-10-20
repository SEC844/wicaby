// Jellyfin SyncPlay ("Watch together"), as core SyncPlay.kt and jellyfin-web's plugin: the server holds the group's
// queue and state; this TV asks (Pause, Unpause, Seek), reports Ready and Buffering, and applies the server's
// commands at their When (the server clock, shared/syncplay.ts TimeSync). Updates and commands come on the session
// socket (onSocket). The player on screen joins the group while it plays the group's item; leaving it leaves the
// group.
import { measure, TimeSync } from '$shared/syncplay';
import type { Api } from './api';
import { clock } from './format';
import { t } from './i18n.svelte';
import { nav, stack } from './nav.svelte';
import type { Playback } from './playback.svelte';
import { onSocket } from './server-socket';
import { api as primary } from './session.svelte';
import { showToast } from './toast.svelte';

const TICKS_PER_MS = 10_000;
// Closer than this to the group, Pause and Unpause leave the position alone (a seek would rebuffer).
const DRIFT_MS = 2000;
const RELOAD = ['NewPlaylist', 'SetCurrentItem', 'NextItem', 'PreviousItem'];

export interface SyncGroup {
  id: string;
  name: string;
  participants: string[];
}
interface SyncQueue {
  itemId: string;
  playlistItemId: string;
  startMs: number;
  isPlaying: boolean;
  reason: string;
}
interface SyncCommand {
  command: string;
  whenMs: number;
  positionMs: number;
  playlistItemId?: string;
}

export const syncplay = $state<{ group: SyncGroup | null }>({ group: null });

let api: Api | null = null;
let time = new TimeSync();
let queue: SyncQueue | null = null;
// The player bound to the group, and the one on screen, bound or not.
let pb: Playback | null = null;
let current: Playback | null = null;
let off: (() => void) | null = null;
let clockTimer: ReturnType<typeof setTimeout> | undefined;
let scheduled: ReturnType<typeof setTimeout> | undefined;
// Our own pause/play/seek calls: the hooks must not send them back as requests.
let applying = false;
// Waiting for the group (new item, Seek command, buffering): Ready goes out once the player is ready.
let readyPending = false;
// What this TV asked last: its echo from the server gets no toast.
let asked: [string, number] | null = null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(s);
const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);

function parseGroup(d: unknown): SyncGroup | null {
  const o = d as Record<string, unknown> | null;
  const id = o && str(o, 'GroupId');
  if (!o || !id) return null;
  return { id, name: str(o, 'GroupName') ?? '', participants: Array.isArray(o.Participants) ? o.Participants.map(String) : [] };
}

// null for an empty queue, or an id that is not a server id (it goes into URLs).
function parseQueue(d: unknown): SyncQueue | null {
  const o = d as { Playlist?: { ItemId?: string; PlaylistItemId?: string }[]; PlayingItemIndex?: number; StartPositionTicks?: number; IsPlaying?: boolean; Reason?: string } | null;
  const entry = o?.Playlist?.[o.PlayingItemIndex ?? -1];
  if (!entry || !isId(entry.ItemId) || !entry.PlaylistItemId) return null;
  return { itemId: entry.ItemId, playlistItemId: entry.PlaylistItemId, startMs: (o!.StartPositionTicks ?? 0) / TICKS_PER_MS, isPlaying: o!.IsPlaying === true, reason: o!.Reason ?? '' };
}

function parseCommand(d: unknown): SyncCommand | null {
  const o = d as Record<string, unknown> | null;
  const command = o && str(o, 'Command');
  const when = o && Date.parse(str(o, 'When') ?? '');
  if (!o || !command || !when) return null;
  return { command, whenMs: when, positionMs: (Number(o.PositionTicks) || 0) / TICKS_PER_MS, playlistItemId: str(o, 'PlaylistItemId') };
}

// Only the signed-in session on Jellyfin: its socket is the one that carries the group's messages.
export function syncAvailable(a: Api): boolean {
  const p = primary();
  return !a.isEmby && !!p && p.address === a.address && p.userId === a.userId;
}

export async function syncGroups(a: Api): Promise<SyncGroup[]> {
  return (await a.get<unknown[]>('/SyncPlay/List')).map(parseGroup).filter((g): g is SyncGroup => !!g);
}

// A new group named [name]; with [itemId], its queue starts on that item at [startMs].
export function createGroup(a: Api, name: string, itemId?: string, startMs = 0): Promise<void> {
  return begin(a, async () => {
    await a.post('/SyncPlay/New', { GroupName: name });
    if (itemId) await a.post('/SyncPlay/SetNewQueue', { PlayingQueue: [itemId], PlayingItemPosition: 0, StartPositionTicks: Math.round(startMs * TICKS_PER_MS) });
  });
}

export function joinGroup(a: Api, groupId: string): Promise<void> {
  return begin(a, () => a.post('/SyncPlay/Join', { GroupId: groupId }));
}

export function leaveGroup(): void {
  const a = api;
  if (!a) return;
  end();
  void a.post('/SyncPlay/Leave').catch(() => {});
}

async function begin(a: Api, call: () => Promise<unknown>): Promise<void> {
  // The server moves a session already in a group: no Leave of our own to race the next call.
  end();
  api = a;
  time = new TimeSync();
  // Subscribed before the request goes: GroupJoined may come back fast.
  off = onSocket(onMessage);
  void timeSync(a, 0);
  try {
    await call();
  } catch (e) {
    if (api === a) end();
    throw e;
  }
}

function end(): void {
  off?.();
  off = null;
  clearTimeout(clockTimer);
  unbind();
  api = null;
  syncplay.group = null;
  queue = null;
}

// Eight samples a second apart, then one a minute; each sends the ping the server spaces its commands by.
async function timeSync(a: Api, n: number): Promise<void> {
  if (api !== a) return;
  const sent = Date.now();
  const r = await a.get<{ RequestReceptionTime?: string; ResponseTransmissionTime?: string }>('/GetUtcTime').catch(() => null);
  const received = Date.now();
  const inAt = Date.parse(r?.RequestReceptionTime ?? '');
  const outAt = Date.parse(r?.ResponseTransmissionTime ?? '');
  if (api !== a) return;
  if (inAt && outAt) {
    time.add(measure(sent, inAt, outAt, received));
    void a.post('/SyncPlay/Ping', { Ping: Math.round(time.pingMs) }).catch(() => {});
  }
  clockTimer = setTimeout(() => void timeSync(a, n + 1), n < 7 ? 1000 : 60_000);
}

function onMessage(type: string, data: unknown): void {
  // The socket now belongs to another session (server or user switch): not this group's messages.
  if (!api || !syncAvailable(api)) return;
  if (type === 'SyncPlayGroupUpdate') onUpdate(data as { Type?: string; GroupId?: string; Data?: unknown });
  else if (type === 'SyncPlayCommand') {
    const c = parseCommand(data);
    if (c) onCommand(c);
  }
}

function onUpdate(u: { Type?: string; GroupId?: string; Data?: unknown }): void {
  const g = syncplay.group;
  const name = typeof u.Data === 'string' ? u.Data : '';
  switch (u.Type) {
    case 'GroupJoined': {
      const joined = parseGroup(u.Data);
      if (!joined) return;
      syncplay.group = joined;
      showToast(t('syncplay_joined', joined.name));
      return;
    }
    case 'UserJoined':
      if (!g) return;
      syncplay.group = { ...g, participants: [...g.participants, name] };
      showToast(t('syncplay_user_joined', name));
      return;
    case 'UserLeft': {
      if (!g) return;
      const i = g.participants.indexOf(name);
      syncplay.group = { ...g, participants: g.participants.filter((_, n) => n !== i) };
      showToast(t('syncplay_user_left', name));
      return;
    }
    // GroupLeft of the group a create or join just moved us out of: not this one.
    case 'GroupLeft':
      if (g && u.GroupId === g.id) {
        end();
        showToast(t('syncplay_left'));
      }
      return;
    case 'NotInGroup':
    case 'GroupDoesNotExist':
    case 'LibraryAccessDenied':
      if (g) showToast(t('syncplay_left'));
      end();
      return;
    case 'PlayQueue': {
      const q = parseQueue(u.Data);
      if (q) onQueue(q);
    }
  }
}

function onQueue(q: SyncQueue): void {
  const prev = queue;
  queue = q;
  if (!RELOAD.includes(q.reason) && prev?.playlistItemId === q.playlistItemId) return;
  const p = pb ?? current;
  // Created from the player: the item playing is the group's.
  if (p && p.itemId === q.itemId) return pb ? waitForGroup(q.startMs) : attach(p);
  // The old player lets go now (its stop is not a leave); the new one binds once it has loaded.
  unbind();
  if (stack[stack.length - 1]?.route.name === 'player') nav.back();
  nav.push({ name: 'player', id: q.itemId, startMs: q.startMs });
}

function onCommand(c: SyncCommand): void {
  const q = queue;
  if (!pb || (q && c.playlistItemId && c.playlistItemId !== q.playlistItemId)) return;
  clearTimeout(scheduled);
  scheduled = setTimeout(() => execute(c), time.delayUntil(c.whenMs));
  const mine = !!asked && asked[0] === c.command && Date.now() - asked[1] < 5000;
  if (mine) return;
  if (c.command === 'Pause') showToast(t('syncplay_paused'));
  else if (c.command === 'Unpause') showToast(t('syncplay_resumed'));
  else if (c.command === 'Seek') showToast(t('syncplay_seeked', clock(c.positionMs)));
}

// The group's position now: from When on, Unpause runs; Pause and Seek hold theirs.
function groupPositionMs(c: SyncCommand): number {
  return c.command === 'Unpause' ? c.positionMs + Math.max(0, time.serverNow() - c.whenMs) : c.positionMs;
}

function execute(c: SyncCommand): void {
  const p = pb;
  if (!p) return;
  const target = groupPositionMs(c);
  const seek = c.command === 'Seek' || Math.abs(p.positionMs - target) > DRIFT_MS ? target : null;
  apply(() => {
    if (c.command === 'Unpause') {
      if (seek !== null) p.seek(seek);
      p.togglePlay(true);
    } else if (c.command === 'Pause' || c.command === 'Stop') {
      p.togglePlay(false);
      if (seek !== null) p.seek(seek);
    } else if (c.command === 'Seek') {
      p.togglePlay(false);
      p.seek(seek ?? c.positionMs);
      readyPending = true;
    }
  });
}

// Paused at the group's position until its Unpause; Ready once loaded (the server checks the position).
function waitForGroup(startMs: number): void {
  const p = pb;
  if (!p) return;
  readyPending = true;
  apply(() => {
    p.togglePlay(false);
    p.seek(startMs);
  });
}

function apply(block: () => void): void {
  applying = true;
  try {
    block();
  } finally {
    applying = false;
  }
}

function attach(p: Playback): void {
  const q = queue;
  if (!q || !syncplay.group || p.itemId !== q.itemId || !api || p.api.address !== api.address) return;
  unbind();
  pb = p;
  waitForGroup(q.startMs);
}

function unbind(): void {
  clearTimeout(scheduled);
  pb = null;
  readyPending = false;
}

// The player moved on by itself (next episode): no longer the group's item.
function stale(): boolean {
  const q = queue;
  if (!pb || !q || pb.itemId === q.itemId) return false;
  leaveGroup();
  return true;
}

function report(path: 'Ready' | 'Buffering', playing: boolean): void {
  const a = api;
  const q = queue;
  if (!a || !q || !pb) return;
  void a
    .post(`/SyncPlay/${path}`, { When: new Date(time.serverNow()).toISOString(), PositionTicks: Math.round(pb.positionMs * TICKS_PER_MS), IsPlaying: playing, PlaylistItemId: q.playlistItemId })
    .catch(() => {});
}

function request(command: string, body?: unknown): void {
  const a = api;
  if (!a) return;
  asked = [command, Date.now()];
  void a.post(`/SyncPlay/${command}`, body).catch(() => {});
}

// ---- From the player (lib/playback.svelte.ts) ----

// Loaded: the player of the group's item joins it (also later, once a queue names it).
export function syncLoaded(p: Playback): void {
  if (p.trailer) return;
  current = p;
  attach(p);
}

// Stopped: leaving the group's player leaves the group.
export function syncStopped(p: Playback): void {
  if (current === p) current = null;
  if (pb === p) leaveGroup();
}

export function syncBuffering(p: Playback, on: boolean): void {
  if (pb !== p || stale()) return;
  if (!on && readyPending) {
    readyPending = false;
    report('Ready', p.playing);
  } else if (on && !readyPending && !applying && p.playing) {
    readyPending = true;
    report('Buffering', true);
  }
}

// The user's play or pause: the group's request (the player already did it here).
export function syncPlayPause(p: Playback, play: boolean): void {
  if (pb !== p || applying || stale()) return;
  // The player's own start while the group waits: the group's Unpause starts it.
  if (readyPending) {
    if (play) apply(() => p.togglePlay(false));
    return;
  }
  request(play ? 'Unpause' : 'Pause');
}

export function syncSeek(p: Playback, ms: number): void {
  if (pb !== p || applying || readyPending || stale()) return;
  request('Seek', { PositionTicks: Math.round(ms * TICKS_PER_MS) });
}
