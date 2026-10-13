// Live TV recordings logic (spec §6.7, §9.1–§9.3, §7.1): timer status mapping, the timer overlay,
// the recording marks, record-option presence and DVR error mapping.
// Pure and erasable TypeScript only; C/livetv/Timers.kt mirrors it (vectors: timers.json).
import { parseServerDate } from './model';
import type { ProgramLite, ServerKind, TimerLite, TimerStatus } from './model';

type Dto = Record<string, unknown>;

// Server RecordingStatus → ours. null = not shown (Cancelled tombstones; Completed rows, which only
// Emby returns: they are dropped on both servers).
export function mapTimerStatus(status: unknown): TimerStatus | null {
  switch (status) {
    case 'Cancelled':
    case 'Completed':
      return null;
    case 'InProgress':
      return 'recording';
    case 'ConflictedOk':
      return 'conflict-ok';
    case 'ConflictedNotOk':
      return 'conflict-wont';
    case 'Error':
      return 'error';
    default:
      return 'scheduled'; // New, Scheduled, or missing
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normalizeTimer(dto: Dto): TimerLite | null {
  const id = str(dto.Id);
  const status = mapTimerStatus(dto.Status);
  const start = parseServerDate(dto.StartDate);
  const end = parseServerDate(dto.EndDate);
  if (!id || status === null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const t: TimerLite = { id, start, end, name: typeof dto.Name === 'string' ? dto.Name : '', status, prePaddingS: num(dto.PrePaddingSeconds), postPaddingS: num(dto.PostPaddingSeconds) };
  const programId = str(dto.ProgramId);
  if (programId) t.programId = programId;
  const channelId = str(dto.ChannelId);
  if (channelId) t.channelId = channelId;
  const seriesTimerId = str(dto.SeriesTimerId);
  if (seriesTimerId) t.seriesTimerId = seriesTimerId;
  return t;
}

// The timers list, normalised and sorted by start (then id).
export function normalizeTimers(items: readonly Dto[]): TimerLite[] {
  return items
    .map(normalizeTimer)
    .filter((t): t is TimerLite => t !== null)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const STATUS_RANK: Readonly<Record<TimerStatus, number>> = { recording: 0, scheduled: 1, 'conflict-ok': 2, 'conflict-wont': 3, error: 4 };

// Map<programId, TimerLite>; when two timers name the same programme, the stronger status wins.
export function buildOverlay(timers: readonly TimerLite[]): Map<string, TimerLite> {
  const m = new Map<string, TimerLite>();
  for (const t of timers) {
    if (!t.programId) continue;
    const prev = m.get(t.programId);
    if (!prev || STATUS_RANK[t.status] < STATUS_RANK[prev.status]) m.set(t.programId, t);
  }
  return m;
}

export type Mark = 'timer' | 'series' | 'recording' | 'conflict-wont' | 'conflict-ok' | 'error' | 'rule-skip';

// §6.7. The overlay wins once loaded (null = not loaded yet: the programme payload is used).
export function markFor(p: Pick<ProgramLite, 'id' | 'timerId' | 'seriesTimerId'>, overlay: ReadonlyMap<string, TimerLite> | null): Mark | null {
  if (overlay === null) {
    if (p.timerId) return p.seriesTimerId ? 'series' : 'timer';
    return p.seriesTimerId ? 'rule-skip' : null;
  }
  const t = overlay.get(p.id);
  if (!t) return p.seriesTimerId ? 'rule-skip' : null;
  switch (t.status) {
    case 'recording':
      return 'recording';
    case 'conflict-wont':
      return 'conflict-wont';
    case 'conflict-ok':
      return 'conflict-ok';
    case 'error':
      return 'error';
    default:
      return t.seriesTimerId ? 'series' : 'timer';
  }
}

// The Programmés badge: timers that will not record.
export function conflictCount(timers: readonly TimerLite[]): number {
  return timers.filter((t) => t.status === 'conflict-wont').length;
}

// ---- Record options (§9.2): a field absent from the defaults object is not shown ----

export type RecordMode = 'single' | 'series';
export interface OptionField {
  id: string;
  field: string; // body field
  modes: readonly RecordMode[];
}

export const OPTION_FIELDS: readonly OptionField[] = [
  { id: 'startEarly', field: 'PrePaddingSeconds', modes: ['single', 'series'] },
  { id: 'endLate', field: 'PostPaddingSeconds', modes: ['single', 'series'] },
  { id: 'newOnly', field: 'RecordNewOnly', modes: ['series'] },
  { id: 'anyChannel', field: 'RecordAnyChannel', modes: ['series'] },
  { id: 'anyTime', field: 'RecordAnyTime', modes: ['series'] },
  { id: 'days', field: 'Days', modes: ['series'] },
  { id: 'skipInLibrary', field: 'SkipEpisodesInLibrary', modes: ['series'] },
  { id: 'keepUpTo', field: 'KeepUpTo', modes: ['series'] },
  { id: 'keepUntil', field: 'KeepUntil', modes: ['single', 'series'] },
  { id: 'maxLength', field: 'MaxRecordingSeconds', modes: ['series'] },
  { id: 'folder', field: 'ParentFolderId', modes: ['single', 'series'] },
];

export const PADDING_CHOICES_MIN: readonly number[] = [0, 1, 2, 5, 10, 15, 30, 60];
export const KEEP_UP_TO_CHOICES: readonly number[] = [0, 1, 2, 3, 5, 10, 20];

export function visibleOptions(defaults: Dto | null | undefined, mode: RecordMode): string[] {
  if (!defaults) return [];
  return OPTION_FIELDS.filter((f) => f.modes.includes(mode) && Object.prototype.hasOwnProperty.call(defaults, f.field) && defaults[f.field] !== null).map((f) => f.id);
}

// POST body: the defaults object with only the changed fields applied (fields the server did not
// send are never added).
export function applyOptions(defaults: Dto, changes: Dto): Dto {
  const out: Dto = { ...defaults };
  for (const [k, v] of Object.entries(changes)) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = v;
  return out;
}

// Quick record: the defaults unchanged, plus the synced lt.dvrPadding when set.
export function quickRecordBody(defaults: Dto, padding?: { pre: number; post: number } | null): Dto {
  if (!padding) return { ...defaults };
  return applyOptions(defaults, { PrePaddingSeconds: padding.pre, PostPaddingSeconds: padding.post });
}

// ---- Errors (§9.1, §9.7) ----

export type DvrOp = 'createTimer' | 'createSeriesTimer' | 'updateTimer' | 'updateSeriesTimer' | 'cancelTimer' | 'deleteSeriesTimer' | 'deleteRecording' | 'timers' | 'recordings';
export type DvrError = 'already-scheduled' | 'forbidden' | 'premiere' | 'not-series' | 'not-found' | 'server';

const PREMIERE_RE = /premiere|licen[cs]e|supporter/i;

export function mapDvrError(kind: ServerKind, op: DvrOp, status: number, message = ''): DvrError {
  if (status === 403 || status === 401) return 'forbidden';
  if (status === 400 && (op === 'createTimer' || op === 'createSeriesTimer')) return 'already-scheduled';
  if (status === 404) return 'not-found';
  if (status >= 500 && kind === 'emby' && PREMIERE_RE.test(message)) return 'premiere';
  if (status >= 500 && op === 'createSeriesTimer') return 'not-series';
  return 'server';
}

// After a 403 on any DVR route the record actions are hidden for the session.
export function canRecordAfter(canRecord: boolean, err: DvrError): boolean {
  return err === 'forbidden' ? false : canRecord;
}
