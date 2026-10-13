// Player live mode, main side (livetv-spec-final.md §8.3, §8.5, §14): the zap list (PlayRequest.live or
// a live-lens command), CH+/- merging and the last channel through shared/livetv/zap.ts, and the
// LiveState the OSD draws (now/next filled from one programNowNext call, refreshed at each boundary).
// Main owns the list, so SMTC next/previous, media keys, the thumbar and OSD keys all zap.
// No Electron import: playback-service.ts lends the tune, the API and the current channel.
import type { LiveNowNext, LiveState, PlayRequest, ZapEntry } from '../../shared/contract';
import { programNowNext } from '../../shared/livetv/dialect';
import { normalizeProgram, type LensRef, type ProgramLite, type ServerKind } from '../../shared/livetv/model';
import { zapInit, zapReduce, type ZapEvent, type ZapState } from '../../shared/livetv/zap';
import type { BaseItem, MediaSource } from '../../shared/models';

const MAX_ENTRIES = 10_000;
const NOW_NEXT_RETRY_MS = 60_000;

// The part of Current (playback-service.ts) this module reads.
export interface ZapCurrent {
  item: BaseItem;
  serverId?: string;
  source?: MediaSource;
  live?: { adopted: boolean };
}

export interface ZapHost {
  // Tune a channel of the same server; resolves once that tune settled (adopted, restored or failed).
  tune(channelId: string): Promise<void>;
  publish(): void;
  current(): ZapCurrent | null;
  api(): { kind: ServerKind; userId?: string; request<T>(method: string, path: string, query?: Record<string, string>, body?: unknown, timeoutMs?: number): Promise<T> } | null;
  policy(serverId: string): 'mbb' | 'bbm';
  warn(message: string, err?: unknown): void;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');

// Renderer input (trust boundary): ids are path segments later, so only plain ids pass.
export function cleanEntries(v: unknown): ZapEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ZapEntry[] = [];
  for (const e of v.slice(0, MAX_ENTRIES) as Record<string, unknown>[]) {
    const id = e && typeof e === 'object' ? e.id : null;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    const entry: ZapEntry = { id, number: str(e.number, 16), name: str(e.name, 200) };
    const logo = str(e.logoTag, 128);
    if (logo) entry.logoTag = logo;
    out.push(entry);
  }
  return out;
}

function cleanLens(v: unknown): LensRef {
  const l = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (l.kind === 'favorites' || l.kind === 'recents' || l.kind === 'radio') return { kind: l.kind };
  if (l.kind === 'tag' && typeof l.tag === 'string') return { kind: 'tag', tag: l.tag.slice(0, 200) };
  if (l.kind === 'group' && typeof l.id === 'string') return { kind: 'group', id: l.id.slice(0, 64) };
  return { kind: 'all' };
}

const lite = (p: ProgramLite | undefined): LiveNowNext | undefined =>
  p && { id: p.id, title: p.title, start: p.start, end: p.end, flags: p.flags, ...(p.episodeTitle ? { episodeTitle: p.episodeTitle } : {}) };

export class ZapController {
  private list: ZapEntry[] = [];
  private byId = new Map<string, ZapEntry>();
  private lens: LensRef = { kind: 'all' };
  private lensLabel = '';
  private z: ZapState = zapInit();
  private timer: NodeJS.Timeout | null = null;
  // Settles only the latest tune: an older one resolving late must not mark the newer target failed.
  private seq = 0;
  private nn: { channelId: string; now?: LiveNowNext; next?: LiveNowNext; recording: boolean } | null = null;
  private nnTimer: NodeJS.Timeout | null = null;
  private readonly host: ZapHost;

  constructor(host: ZapHost) {
    this.host = host;
  }

  // ---- Commands ----

  // play() of an item: a channel started from the guide, search, home or a remote. Returns the settle
  // callback to run once that start finished. wasLive: an adopted channel is playing (last channel).
  request(live: PlayRequest['live'] | undefined, id: string, wasLive: boolean): () => void {
    if (live && typeof live === 'object') this.setList(cleanLens(live.lens), str(live.lensLabel, 120), live.entries);
    // A tune from the guide while watching keeps the list when the channel is in it.
    else if (!this.byId.has(id)) this.setList({ kind: 'all' }, '', []);
    if (!wasLive) this.z = zapInit();
    this.clearTimer();
    this.z = zapReduce(this.z, { type: 'tune', id, at: Date.now() }, this.list).state;
    const n = ++this.seq;
    return () => n === this.seq && this.settle();
  }

  press(delta: 1 | -1): void {
    this.run({ type: 'press', delta, at: Date.now() });
  }

  tune(channelId: unknown): void {
    if (typeof channelId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) return;
    this.run({ type: 'tune', id: channelId, at: Date.now() });
  }

  last(): void {
    this.run({ type: 'last-channel', at: Date.now() });
  }

  setLens(lens: unknown, label: unknown, entries: unknown): void {
    this.setList(cleanLens(lens), str(label, 120), entries);
    this.host.publish();
  }

  stop(): void {
    this.clearTimer();
    if (this.nnTimer) clearTimeout(this.nnTimer);
    this.nnTimer = null;
    this.nn = null;
    this.z = zapInit();
    this.seq++;
  }

  // ---- State for the OSD ----

  state(): LiveState | undefined {
    const c = this.host.current();
    if (!c?.live) return undefined;
    const it = c.item;
    const id = it.Id;
    const listed = this.byId.get(id);
    const logoTag = it.ImageTags?.Primary ?? listed?.logoTag;
    const channel = {
      id,
      number: str((it as { ChannelNumber?: unknown }).ChannelNumber ?? (it as { Number?: unknown }).Number, 16) || listed?.number || '',
      name: it.Name ?? listed?.name ?? '',
      serverId: c.serverId ?? '',
      ...(logoTag ? { logoTag } : {}),
    };
    const target = this.z.pending ?? this.z.tuning;
    const nn = this.nn?.channelId === id ? this.nn : null;
    const out: LiveState = {
      channel,
      index: this.list.findIndex((e) => e.id === id) + 1,
      count: this.list.length,
      lensLabel: this.lensLabel,
      lens: this.lens,
      tuning: this.z.tuning !== null || !c.live.adopted,
      policy: this.host.policy(channel.serverId),
    };
    if (target && target !== id) out.pending = this.byId.get(target) ?? { id: target, number: '', name: '' };
    if (nn?.now) out.now = nn.now;
    if (nn?.next) out.next = nn.next;
    if (nn?.recording) out.recording = true;
    if (this.z.last) out.lastChannelId = this.z.last;
    if (c.source?.MediaStreams && !c.source.MediaStreams.some((s) => s.Type === 'Video')) out.radio = true;
    return out;
  }

  // ---- Internals ----

  private setList(lens: LensRef, label: string, entries: unknown): void {
    this.lens = lens;
    this.lensLabel = label;
    this.list = cleanEntries(entries);
    this.byId = new Map(this.list.map((e) => [e.id, e] as const));
  }

  private run(ev: ZapEvent): void {
    const { state, effects } = zapReduce(this.z, ev, this.list);
    this.z = state;
    this.clearTimer();
    if (state.fireAt !== null) this.timer = setTimeout(() => this.run({ type: 'tick', at: Date.now() }), Math.max(0, state.fireAt - Date.now()));
    for (const e of effects) {
      if (e.type !== 'tune') continue;
      const n = ++this.seq;
      void this.host.tune(e.id).finally(() => n === this.seq && this.settle());
    }
    this.host.publish();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // The latest tune finished: the adopted channel becomes current (its predecessor the last channel);
  // a target that did not end up adopted failed.
  private settle(): void {
    const c = this.host.current();
    const id = c?.live?.adopted ? c.item.Id : null;
    if (id) this.z = zapReduce(this.z, { type: 'adopted', id }, this.list).state;
    if (this.z.tuning !== null) this.z = zapReduce(this.z, { type: 'failed', id: this.z.tuning }, this.list).state;
    if (id) void this.refreshNowNext(id);
    this.host.publish();
  }

  // One programNowNext call per channel and boundary (§8.5): the banner stays right with a cold cache.
  private async refreshNowNext(id: string): Promise<void> {
    const at = Date.now();
    if (this.nn?.channelId === id && (this.nn.now?.end ?? 0) > at) return;
    if (this.nnTimer) clearTimeout(this.nnTimer);
    this.nnTimer = null;
    const api = this.host.api();
    if (!api?.userId) return;
    const r = programNowNext(api.kind, { userId: api.userId, channelId: id, now: at });
    let retryIn = NOW_NEXT_RETRY_MS;
    try {
      const res = await api.request<{ Items?: Record<string, unknown>[] }>(r.method, r.path, r.query, undefined, 10_000);
      const c = this.host.current();
      if (!c?.live || c.item.Id !== id) return;
      const progs = (res?.Items ?? [])
        .map((d) => normalizeProgram(d, { kind: api.kind }))
        .filter((p): p is ProgramLite => p !== null && p.channelId === id && p.end > at)
        .sort((a, b) => a.start - b.start);
      const now = progs.find((p) => p.start <= at);
      const next = progs.find((p) => p.start >= (now?.end ?? at));
      this.nn = { channelId: id, now: lite(now), next: lite(next), recording: Boolean(now?.timerId) };
      retryIn = Math.max(1_000, (now?.end ?? next?.start ?? at + 30 * 60_000) - Date.now() + 1_000);
      this.host.publish();
    } catch (err) {
      this.host.warn(`now/next for ${id} failed`, err);
    }
    this.nnTimer = setTimeout(() => {
      this.nnTimer = null;
      const c = this.host.current();
      if (c?.live?.adopted && c.item.Id === id) void this.refreshNowNext(id);
    }, Math.min(retryIn, 6 * 3_600_000));
  }
}
