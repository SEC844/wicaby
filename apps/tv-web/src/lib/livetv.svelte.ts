// Live TV data for the signed-in server and user (Android core livetv/LiveTvRepository.kt): the lineup, the guide in
// 3 h slabs per channel, the timers and their overlay, recordings, favourites and the recently watched channels.
// Every request comes from the shared dialect builders ($shared/livetv/dialect, the same vectors as Android and the
// desktop); normalisation, EPG hygiene and the timer overlay are the shared ones too.
import type { BaseItem } from '$shared/models';
import * as D from '$shared/livetv/dialect';
import { pushRecent, recentIds } from '$shared/livetv/lens';
import { normalizeChannel, normalizeProgram, parseServerDate, type ChannelRow, type ProgramLite, type TimerLite } from '$shared/livetv/model';
import { coverageKey, mergePrograms, programAt, slabEnd, slabRange, slabStart } from '$shared/livetv/tiles';
import { buildOverlay, mapDvrError, normalizeTimers, quickRecordBody, type DvrError, type DvrOp } from '$shared/livetv/timers';
import { compareByNumber } from '$shared/livetv/channel-order';
import { ApiError, type Api } from './api';
import { load, save } from './storage';

type Dto = Record<string, unknown>;
// A programme item: BaseItem plus its airing.
export type Program = BaseItem & { StartDate?: string; EndDate?: string; ChannelId?: string; ChannelName?: string; EpisodeTitle?: string; TimerId?: string; SeriesTimerId?: string; IsSeries?: boolean };
interface Page<T = Dto> {
  Items?: T[];
  TotalRecordCount?: number;
}

const PAGE = 300;
// Channels per programmes request: the URL stays short and one answer stays small on a TV.
const BATCH = 24;

export class DvrFailure extends Error {
  constructor(readonly kind: DvrError) {
    super(kind);
  }
}

export class LiveTv {
  channels = $state.raw<ChannelRow[]>([]);
  loaded = $state(false);
  failed = $state(false);
  // Bumped when programmes land, so the guide and the lists redraw.
  rev = $state(0);
  timers = $state.raw<TimerLite[]>([]);
  seriesTimers = $state.raw<Dto[]>([]);
  overlay = $state.raw<Map<string, TimerLite>>(new Map());
  recents = $state.raw<string[]>([]);
  // Record actions are hidden after the server refused one (403): a user without the DVR right.
  canRecord = $state(true);

  private readonly programs = new Map<string, ProgramLite[]>();
  private readonly covered = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly raw = new Map<string, Dto>();
  private readonly recentsKey: string;

  constructor(readonly api: Api) {
    this.recentsKey = `livetv.recents.${api.address}.${api.userId}`;
    this.recents = load<string[]>(this.recentsKey, []);
  }

  send<T>(r: D.Req): Promise<T> {
    return this.api.request<T>(r.method, r.path, r.query, r.body);
  }

  private get userId(): string {
    return this.api.userId ?? '';
  }

  // --- Lineup ---

  async loadChannels(): Promise<void> {
    try {
      const rows: ChannelRow[] = [];
      for (let start = 0; ; start += PAGE) {
        const page = await this.send<Page>(D.channelsPage(this.api.kind, { userId: this.userId, startIndex: start, limit: PAGE }));
        const items = page.Items ?? [];
        items.forEach((dto, i) => {
          const r = normalizeChannel(dto, this.api.address, start + i);
          if (!r) return;
          this.raw.set(r.id, dto);
          rows.push(r);
        });
        if (items.length < PAGE) break;
      }
      // A recently watched channel without a local entry yet takes its place from the server's play date.
      if (!this.recents.length) this.recents = recentIds(rows, []);
      this.channels = rows.slice().sort(compareByNumber);
      this.failed = false;
    } catch {
      this.failed = !this.channels.length;
    } finally {
      this.loaded = true;
    }
  }

  channel(id: string): ChannelRow | undefined {
    return this.channels.find((c) => c.id === id);
  }

  // The channel as the server sent it (the player opens it as an item).
  channelItem(id: string): BaseItem | undefined {
    return this.raw.get(id) as BaseItem | undefined;
  }

  logo(row: ChannelRow, maxHeight: number): string | undefined {
    return row.logoTag ? this.api.image(row.id, 'Primary', row.logoTag, { maxHeight }) : undefined;
  }

  favorites(): ChannelRow[] {
    return this.channels.filter((c) => c.favorite);
  }

  recentRows(): ChannelRow[] {
    const byId = new Map(this.channels.map((c) => [c.id, c] as const));
    return this.recents.map((id) => byId.get(id)).filter((c): c is ChannelRow => !!c);
  }

  watched(id: string): void {
    this.recents = pushRecent(this.recents, id);
    save(this.recentsKey, this.recents);
  }

  async setFavorite(id: string, on: boolean): Promise<void> {
    await this.send(D.setFavorite(this.api.kind, { userId: this.userId, id, favorite: on }));
    this.channels = this.channels.map((c) => (c.id === id ? { ...c, favorite: on } : c));
  }

  // --- Guide ---

  // The channel's programmes, undefined until any slab of it is in.
  programsOf(id: string): ProgramLite[] | undefined {
    return this.programs.get(id);
  }

  // The programme airing at [t] on the channel, when known.
  at(id: string, t: number): ProgramLite | null {
    const list = this.programs.get(id);
    return list ? programAt(list, t) : null;
  }

  // The programme airing now and the one after it.
  nowNext(id: string, now: number): [ProgramLite | null, ProgramLite | null] {
    const list = this.programs.get(id);
    if (!list) return [null, null];
    const i = list.findIndex((p) => p.end > now);
    if (i < 0) return [null, null];
    return list[i].start <= now ? [list[i], list[i + 1] ?? null] : [null, list[i]];
  }

  // Loads the slabs of [from, to) the channels miss, a batch of channels per request.
  async ensure(ids: readonly string[], from: number, to: number): Promise<void> {
    const work: Promise<void>[] = [];
    for (const slab of slabRange(from, to)) {
      const need = ids.filter((id) => !this.covered.has(coverageKey(id, slab)) && !this.inFlight.has(coverageKey(id, slab)));
      for (let i = 0; i < need.length; i += BATCH) {
        const batch = need.slice(i, i + BATCH);
        batch.forEach((id) => this.inFlight.add(coverageKey(id, slab)));
        work.push(this.fetchSlab(batch, slab));
      }
    }
    await Promise.all(work);
  }

  private async fetchSlab(ids: string[], slab: number): Promise<void> {
    try {
      const page = await this.send<Page>(D.programsTile(this.api.kind, { userId: this.userId, channelIds: ids, from: slabStart(slab), to: slabEnd(slab) }));
      const by = new Map<string, ProgramLite[]>();
      for (const dto of page.Items ?? []) {
        const p = normalizeProgram(dto, { kind: this.api.kind });
        if (!p) continue;
        let l = by.get(p.channelId);
        if (!l) by.set(p.channelId, (l = []));
        l.push(p);
      }
      for (const id of ids) {
        this.programs.set(id, mergePrograms(this.programs.get(id) ?? [], by.get(id) ?? []));
        this.covered.add(coverageKey(id, slab));
      }
      this.rev++;
    } catch {
      // Retried on the next ensure().
    } finally {
      ids.forEach((id) => this.inFlight.delete(coverageKey(id, slab)));
    }
  }

  // The programme as an item (overview, image, flags) for the details sheet.
  programItem(id: string): Promise<Program> {
    return this.send<Program>(D.programDetail(this.api.kind, { userId: this.userId, id }));
  }

  // "En ce moment": programmes airing now with their art (the server's recommendations).
  async onNow(): Promise<Program[]> {
    const r = D.onNow(this.api.kind, { userId: this.userId, now: Date.now() });
    if (!r) return [];
    const now = Date.now();
    // Emby can ignore IsAiring (V15): only what airs now is kept.
    return ((await this.send<Page<Program>>(r)).Items ?? []).filter((p) => parseServerDate(p.StartDate) <= now && parseServerDate(p.EndDate) > now);
  }

  // --- Recordings ---

  async loadTimers(): Promise<void> {
    try {
      const [t, s] = await Promise.all([this.send<Page>(D.timers(this.api.kind)), this.send<Page>(D.seriesTimers(this.api.kind))]);
      this.timers = normalizeTimers(t.Items ?? []);
      this.seriesTimers = s.Items ?? [];
      this.overlay = buildOverlay(this.timers);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) this.canRecord = false;
    }
  }

  private async dvr<T>(op: DvrOp, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const kind = e instanceof ApiError ? mapDvrError(this.api.kind, op, e.status, e.message) : 'server';
      if (kind === 'forbidden') this.canRecord = false;
      throw new DvrFailure(kind);
    }
  }

  // Quick record (the server's defaults): this airing, or the whole series.
  async record(programId: string, series: boolean): Promise<void> {
    const op: DvrOp = series ? 'createSeriesTimer' : 'createTimer';
    await this.dvr(op, async () => {
      const defaults = await this.send<Dto>(D.timerDefaults(this.api.kind, { programId }));
      const body = quickRecordBody(defaults);
      await this.send(series ? D.createSeriesTimer(this.api.kind, { body }) : D.createTimer(this.api.kind, { body }));
    });
    await this.loadTimers();
  }

  async cancelTimer(id: string): Promise<void> {
    await this.dvr('cancelTimer', () => this.send(D.cancelTimer(this.api.kind, { id })));
    await this.loadTimers();
  }

  async cancelSeries(id: string): Promise<void> {
    await this.dvr('deleteSeriesTimer', () => this.send(D.deleteSeriesTimer(this.api.kind, { id })));
    await this.loadTimers();
  }

  async recordings(): Promise<BaseItem[]> {
    return (await this.dvr('recordings', () => this.send<Page<BaseItem>>(D.recordings(this.api.kind, { userId: this.userId })))).Items ?? [];
  }

  async deleteRecording(id: string): Promise<void> {
    await this.dvr('deleteRecording', async () => {
      try {
        await this.send(D.deleteRecording(this.api.kind, { id }));
      } catch (e) {
        // Jellyfin: a recording in the library is deleted as an item.
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
        await this.send(D.deleteItem(this.api.kind, { id }));
      }
    });
  }
}

// One repository per server and user, for the app's life (the guide cache survives leaving the tab).
let current: LiveTv | null = null;
export function liveTv(api: Api): LiveTv {
  if (!current || current.api.address !== api.address || current.api.userId !== api.userId) current = new LiveTv(api);
  else if (current.api !== api) Object.assign(current, { api });
  return current;
}

// "21:30", in the TV's locale.
export function timeText(t: number, locale?: string): string {
  return new Date(t).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

// How far the programme has aired, 0 to 1.
export function progressOf(p: { start: number; end: number }, now: number): number {
  return p.end > p.start ? Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start))) : 0;
}
