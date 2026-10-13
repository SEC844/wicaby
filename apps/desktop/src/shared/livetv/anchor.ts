// Live TV time navigation (spec §6.4, §21.4): local days (DST-safe), dayparts, jump targets and
// the live/manual anchor state machine. Every function reads local time through Date, so it runs
// in the process zone (the checks pin TZ). C/livetv/Anchor.kt mirrors it with java.util.Calendar
// and an injected TimeZone (vectors: anchor.json, Europe/Paris and America/New_York).
// Pure and erasable TypeScript only.

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

// Local midnight of the day containing t.
export function dayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// The local midnight n days after the day containing t (calendar days: 23 h or 25 h across DST).
export function addDays(t: number, n: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

// Local wall-clock time h:m on the day containing t (shifted by `days`).
export function atLocal(t: number, hour: number, minute = 0, days = 0): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, minute).getTime();
}

const pad = (n: number): string => String(n).padStart(2, '0');

// 'YYYY-MM-DD' of the local day (URL `day=`).
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDayKey(key: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}

// URL `at=HHMM` (local wall clock) on a day.
export function parseAt(day: number, at: string | null | undefined): number | null {
  const m = /^(\d{2})(\d{2})$/.exec(at ?? '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return atLocal(day, Number(m[1]), Number(m[2]));
}

export function atParam(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export interface DayChip {
  index: number; // 0 = Aujourd’hui, 1 = Demain, then a formatted date
  key: string; // YYYY-MM-DD
  start: number;
  end: number; // next local midnight
}

// From today to the local date of GuideInfo.EndDate (fallback now + 7 d), inclusive.
export function dayChips(now: number, guideEnd?: number | null): DayChip[] {
  const end = guideEnd !== undefined && guideEnd !== null && Number.isFinite(guideEnd) && guideEnd > now ? guideEnd : now + 7 * 24 * HOUR;
  const last = dayStart(end - 1);
  const out: DayChip[] = [];
  for (let i = 0, s = dayStart(now); s <= last && i < 60; i++) {
    const e = addDays(s, 1);
    out.push({ index: i, key: dayKey(s), start: s, end: e });
    s = e;
  }
  return out;
}

// Dayparts are data; only their labels are strings (livetv.guide.dayparts.*).
export type DaypartId = 'now' | 'morning' | 'afternoon' | 'evening' | 'tonight' | 'night';
export interface Daypart {
  id: Exclude<DaypartId, 'now'>;
  hour: number;
  nextDay: boolean;
}
export const DAYPARTS: readonly Daypart[] = [
  { id: 'morning', hour: 6, nextDay: false },
  { id: 'afternoon', hour: 12, nextDay: false },
  { id: 'evening', hour: 18, nextDay: false },
  { id: 'tonight', hour: 21, nextDay: false },
  { id: 'night', hour: 0, nextDay: true },
];

// The wall-clock time a daypart names on the selected day ("Nuit" = 00:00 of the next day).
export function daypartTime(day: number, id: Daypart['id']): number {
  const p = DAYPARTS.find((x) => x.id === id) as Daypart;
  return atLocal(day, p.hour, 0, p.nextDay ? 1 : 0);
}

// ---- Jumps: they return the time at the left edge of the lane ----

export const NOW_AT = 1 / 3; // "Maintenant": the now line at ⅓ of the lane
export const DAYPART_INSET_MS = 30 * MINUTE; // a daypart sits 30 min in from the left edge
export const PAGE_MS = 3 * HOUR; // ‹ › and Shift+←/→ (TV rewind/forward: 2 h)
export const TV_PAGE_MS = 2 * HOUR;

export function leftForNow(now: number, laneMs: number): number {
  return now - laneMs * NOW_AT;
}

export function leftForDaypart(day: number, id: Daypart['id']): number {
  return daypartTime(day, id) - DAYPART_INSET_MS;
}

// Picking a day keeps the time of day at the left edge, or lands on Soirée (18:00) when the guide
// was at "Maintenant" (anchor live).
export function leftForDay(day: number, currentLeft: number, live: boolean): number {
  if (live) return leftForDaypart(day, 'evening');
  const d = new Date(currentLeft);
  return atLocal(day, d.getHours(), d.getMinutes());
}

// Ctrl+←/→: the same wall-clock time on the previous or next day.
export function shiftDay(left: number, days: number): number {
  const d = new Date(left);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
}

// ---- Anchor state machine ----

export const IDLE_RECENTER_MS = 5 * MINUTE;
export const HIDDEN_RECENTER_MS = 5 * MINUTE;
export const BAND_LOW = 0.1;
export const BAND_HIGH = 0.6;

export interface AnchorState {
  mode: 'live' | 'manual';
  lastInputAt: number;
  hiddenAt: number | null;
}

export type AnchorEvent =
  | { type: 'now'; at: number } // "Maintenant" / Home
  | { type: 'pick'; at: number } // a day, a daypart, a page or a day shift
  | { type: 'scroll'; at: number; nowVisible: boolean } // a horizontal scroll by the user
  | { type: 'input'; at: number } // any other key or pointer input
  | { type: 'tick'; at: number; nowFrac: number } // now line position / lane width
  | { type: 'hidden'; at: number }
  | { type: 'visible'; at: number };

export function anchorInit(at: number): AnchorState {
  return { mode: 'live', lastInputAt: at, hiddenAt: null };
}

// recenter = put the now line back at ⅓ (leftForNow). A manual view is never pulled back.
export function anchorReduce(s: AnchorState, ev: AnchorEvent): { state: AnchorState; recenter: boolean } {
  switch (ev.type) {
    case 'now':
      return { state: { ...s, mode: 'live', lastInputAt: ev.at }, recenter: true };
    case 'pick':
      return { state: { ...s, mode: 'manual', lastInputAt: ev.at }, recenter: false };
    case 'scroll':
      return { state: { ...s, mode: ev.nowVisible ? s.mode : 'manual', lastInputAt: ev.at }, recenter: false };
    case 'input':
      return { state: { ...s, lastInputAt: ev.at }, recenter: false };
    case 'tick': {
      const drifted = ev.nowFrac < BAND_LOW || ev.nowFrac > BAND_HIGH;
      return { state: s, recenter: s.mode === 'live' && drifted && ev.at - s.lastInputAt >= IDLE_RECENTER_MS };
    }
    case 'hidden':
      return { state: { ...s, hiddenAt: ev.at }, recenter: false };
    case 'visible': {
      const long = s.hiddenAt !== null && ev.at - s.hiddenAt > HIDDEN_RECENTER_MS;
      return { state: { ...s, hiddenAt: null }, recenter: long && s.mode === 'live' };
    }
  }
}
