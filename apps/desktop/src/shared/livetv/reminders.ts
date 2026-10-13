// Live TV reminders and the wicaby://live deep link (livetv-spec-final.md §9.6, §3.1): the pure rules,
// shared by main/features/reminders.ts and tools/checks/livetv-check.mjs. Pure and erasable TypeScript only.
import type { LiveReminder } from '../contract';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

// Trust boundary (IPC): ids shaped like server ids, a finite start.
export function cleanReminder(v: unknown): LiveReminder | null {
  const r = (v ?? {}) as Record<string, unknown>;
  if (![r.serverId, r.programId, r.channelId].every((x) => typeof x === 'string' && ID_RE.test(x))) return null;
  if (typeof r.start !== 'number' || !Number.isFinite(r.start)) return null;
  const skewMs = typeof r.skewMs === 'number' && Math.abs(r.skewMs) <= MAX_SKEW_MS ? Math.round(r.skewMs) : 0;
  return { serverId: r.serverId as string, programId: r.programId as string, channelId: r.channelId as string, start: r.start, title: text(r.title, 200), channelName: text(r.channelName, 120), skewMs };
}

const MAX_SKEW_MS = 24 * 3_600_000;
// Missed while the app was closed or asleep: still told up to 5 min after the start, then dropped.
export const LATE_MS = 5 * 60_000;

type Due = { start: number; leadMin: number; skewMs?: number };
// Server time (the EPG's clock).
export const dueAt = (r: Due): number => r.start - r.leadMin * 60_000;
// Client time (setTimeout's clock): `start` is a server time, the client clock is `skewMs` behind it (§21.4).
export const clientDueAt = (r: Due): number => dueAt(r) - (r.skewMs ?? 0);

// At client time `now` (a timer, a resume, a start): which reminders fire, which wait. Due ones leave
// the list either way, so a reminder fires at most once; too late ones are dropped silently.
export function takeDue<T extends Due>(items: readonly T[], now: number): { fire: T[]; keep: T[] } {
  const fire: T[] = [];
  const keep: T[] = [];
  for (const r of items) {
    if (clientDueAt(r) > now) keep.push(r);
    else if (now + (r.skewMs ?? 0) < r.start + LATE_MS) fire.push(r);
  }
  return { fire, keep };
}

// wicaby://live?channel=<id | number | name>&server=<id>&start=live, from argv.
export function liveLinkFromArgv(argv: readonly string[]): { channel: string; server?: string } | null {
  for (const arg of argv) {
    if (!/^wicaby:\/\/live\/?(\?|$)/i.test(arg)) continue;
    let q: URLSearchParams;
    try {
      q = new URL(arg).searchParams;
    } catch {
      return null;
    }
    const channel = (q.get('channel') ?? '').trim().slice(0, 120);
    const server = q.get('server') ?? undefined;
    if (!channel || (server !== undefined && !ID_RE.test(server))) return null;
    return { channel, server };
  }
  return null;
}

export interface ChannelDto {
  Id: string;
  Name?: string;
  ChannelNumber?: string;
  Number?: string;
}

// By id, then number, then name (case-insensitive).
export function matchChannel(items: readonly ChannelDto[], key: string): ChannelDto | undefined {
  const k = key.toLowerCase();
  return items.find((c) => c.Id === key) ?? items.find((c) => (c.ChannelNumber ?? c.Number) === key) ?? items.find((c) => c.Name?.toLowerCase() === k);
}
