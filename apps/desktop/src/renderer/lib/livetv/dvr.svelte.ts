// Live TV recordings data (spec §5.1, §5.2, §6.7, §7.1, §7.2, §9): the timer overlay
// (Map<programId, TimerLite>) that drives every recording mark, the series rules and the
// recordings, per server. The programme cache is never patched for timers: a write, a WebSocket
// timer event or a Live TV open refetches GET /LiveTv/Timers only (zero /LiveTv/Programs requests).
import { cancelTimer, createSeriesTimer, createTimer, deleteItem, deleteRecording, deleteSeriesTimer, recordings, seriesTimer, seriesTimers, timerDefaults, timers, updateSeriesTimer, updateTimer } from '../../../shared/livetv/dialect';
import type { Req } from '../../../shared/livetv/dialect';
import type { TimerLite } from '../../../shared/livetv/model';
import { buildOverlay, canRecordAfter, conflictCount, mapDvrError, normalizeTimers, quickRecordBody } from '../../../shared/livetv/timers';
import type { DvrError, DvrOp } from '../../../shared/livetv/timers';
import { t } from '../i18n.svelte';
import { LiveApiError } from './api';
import type { LiveApi } from './api';

export const EVENT_DEBOUNCE_MS = 1_000;
export const OVERLAY_MAX_AGE_MS = 60_000; // a Live TV open within a minute of the last fetch reuses it

type Dto = Record<string, unknown>;
type Items = { Items?: Dto[]; TotalRecordCount?: number };

const DVR_MESSAGE: Readonly<Record<DvrError, string>> = {
  'already-scheduled': 'livetv.toasts.alreadyScheduled',
  forbidden: 'livetv.toasts.forbidden',
  premiere: 'livetv.toasts.premiere',
  'not-series': 'livetv.toasts.notSeries',
  'not-found': '',
  server: '',
};

// A DVR failure, already mapped (§9.1); its message is the user-facing text.
export class DvrFailure extends Error {
  readonly code: DvrError;
  readonly status: number;
  constructor(code: DvrError, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class DvrStore {
  readonly api: LiveApi;
  // Reactive state.
  timers = $state.raw<TimerLite[]>([]);
  overlay = $state.raw<Map<string, TimerLite> | null>(null); // null until the first load (payload marks meanwhile)
  rules = $state.raw<Dto[]>([]);
  recordings = $state.raw<Dto[]>([]);
  canRecord = $state(true); // Policy.EnableLiveTvManagement is unknown: assume true, downgrade after a 403
  version = $state(0); // bumped on every overlay change
  conflicts = $derived(conflictCount(this.timers));
  // Plain bookkeeping.
  loadedAt = 0;
  refetches = 0;
  onChange: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private again = false;

  constructor(api: LiveApi) {
    this.api = api;
  }

  private get kind() {
    return this.api.kind;
  }

  private changed(): void {
    this.version++;
    this.onChange?.();
  }

  // Live TV open: reuse a fresh overlay, else refetch.
  open(): Promise<void> {
    return Date.now() - this.loadedAt < OVERLAY_MAX_AGE_MS && this.overlay ? Promise.resolve() : this.refresh();
  }

  // Timer events arrive in bursts (a series rule creates many): one refetch per second at most.
  refreshSoon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, EVENT_DEBOUNCE_MS);
  }

  // The authoritative overlay: GET /LiveTv/Timers (Cancelled, and Emby's Completed, dropped).
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.refetches++;
    this.inflight = this.api
      .run<Items>(timers(this.kind), { deadlineMs: 20_000 })
      .then(
        (r) => {
          const list = normalizeTimers(r.data?.Items ?? []);
          this.timers = list;
          this.overlay = buildOverlay(list);
          this.loadedAt = Date.now();
          this.changed();
        },
        (err: unknown) => {
          if (err instanceof LiveApiError && (err.status === 403 || err.status === 401)) this.canRecord = false;
        },
      )
      .finally(() => {
        this.inflight = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.inflight;
  }

  async loadRules(): Promise<Dto[]> {
    const r = await this.api.run<Items>(seriesTimers(this.kind));
    const list = [...(r.data?.Items ?? [])].sort((a, b) => Number(a.Priority ?? 0) - Number(b.Priority ?? 0));
    this.rules = list;
    return list;
  }

  async loadRecordings(inProgress = false): Promise<Dto[]> {
    const r = await this.api.run<Items>(recordings(this.kind, { userId: this.api.userId, inProgress }));
    const list = r.data?.Items ?? [];
    if (!inProgress) this.recordings = list;
    return list;
  }

  // ---- Writes ----

  private async write<T>(op: DvrOp, req: Req): Promise<T> {
    try {
      return (await this.api.run<T>(req)).data;
    } catch (err) {
      const status = err instanceof LiveApiError ? err.status : 0;
      const code = mapDvrError(this.kind, op, status, err instanceof Error ? err.message : '');
      const before = this.canRecord;
      this.canRecord = canRecordAfter(this.canRecord, code);
      if (before !== this.canRecord) this.changed();
      const key = DVR_MESSAGE[code];
      throw new DvrFailure(code, status, key ? t(key) : err instanceof Error ? err.message : String(err));
    }
  }

  // Optimistic overlay patch; the refetch that follows is authoritative.
  private patch(fn: (m: Map<string, TimerLite>) => void): void {
    const m = new Map(this.overlay ?? []);
    fn(m);
    this.overlay = m;
    this.changed();
  }

  // Quick record: the server defaults as they are (plus the synced padding when set).
  async record(programId: string, series: boolean, padding?: { pre: number; post: number } | null): Promise<void> {
    const defaults = await this.write<Dto>(series ? 'createSeriesTimer' : 'createTimer', timerDefaults(this.kind, { programId }));
    const body: Dto = { ...quickRecordBody(defaults ?? {}, padding), ProgramId: programId };
    await this.write(series ? 'createSeriesTimer' : 'createTimer', series ? createSeriesTimer(this.kind, { body }) : createTimer(this.kind, { body }));
    if (!series) {
      const start = Date.parse(String(body.StartDate ?? ''));
      const end = Date.parse(String(body.EndDate ?? ''));
      this.patch((m) =>
        m.set(programId, {
          id: `pending-${programId}`,
          programId,
          channelId: typeof body.ChannelId === 'string' ? body.ChannelId : undefined,
          start: Number.isFinite(start) ? start : 0,
          end: Number.isFinite(end) ? end : 0,
          name: typeof body.Name === 'string' ? body.Name : '',
          status: 'scheduled',
          prePaddingS: Number(body.PrePaddingSeconds ?? 0),
          postPaddingS: Number(body.PostPaddingSeconds ?? 0),
        }),
      );
    }
    // 200/204 with an empty body: the new timer id comes from the refetch.
    await this.refresh();
  }

  async cancelTimer(id: string): Promise<void> {
    await this.write('cancelTimer', cancelTimer(this.kind, { id }));
    this.patch((m) => {
      for (const [pid, x] of m) if (x.id === id) m.delete(pid);
    });
    await this.refresh();
  }

  async cancelSeriesTimer(id: string): Promise<void> {
    await this.write('deleteSeriesTimer', deleteSeriesTimer(this.kind, { id }));
    this.patch((m) => {
      for (const [pid, x] of m) if (x.seriesTimerId === id) m.delete(pid);
    });
    this.rules = this.rules.filter((r) => r.Id !== id);
    await this.refresh();
  }

  // Padding only.
  async updateTimer(id: string, body: Dto): Promise<void> {
    await this.write('updateTimer', updateTimer(this.kind, { id, body }));
    await this.refresh();
  }

  // Never a partial body: GET the rule, merge, POST by id, re-GET.
  async updateSeriesTimer(id: string, changes: Dto): Promise<Dto> {
    const current = await this.write<Dto>('updateSeriesTimer', seriesTimer(this.kind, { id }));
    await this.write('updateSeriesTimer', updateSeriesTimer(this.kind, { id, body: { ...current, ...changes, Id: id } }));
    const fresh = await this.write<Dto>('updateSeriesTimer', seriesTimer(this.kind, { id }));
    this.rules = this.rules.map((r) => (r.Id === id ? fresh : r));
    await this.refresh();
    return fresh;
  }

  // Jellyfin answers 404/405 on the Live TV route for some recordings: DELETE /Items/{id} then.
  async deleteRecording(id: string): Promise<void> {
    try {
      await this.write('deleteRecording', deleteRecording(this.kind, { id }));
    } catch (err) {
      if (!(err instanceof DvrFailure) || this.kind !== 'jellyfin' || (err.status !== 404 && err.status !== 405)) throw err;
      await this.write('deleteRecording', deleteItem(this.kind, { id }));
    }
    this.recordings = this.recordings.filter((r) => r.Id !== id);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
