// Self-check for the desktop shell features: watch history grouping and stats (History page,
// "Continue watching" ordering) and the background admin alert rules.
// Usage: node tools/checks/desk-shell-check.mjs
import assert from 'node:assert/strict';

const { recentFirst, groupByDay, daysAgo, dayStart, watchStats } = await import(new URL('../../apps/desktop/src/shared/history.ts', import.meta.url).href);
const { adminAlerts } = await import(new URL('../../apps/desktop/src/shared/admin-alerts.ts', import.meta.url).href);

const H = 3_600_000;
const TICKS_MIN = 600_000_000;
// Noon today (local), so "an hour ago" and "a day ago" never straddle midnight unexpectedly.
const now = dayStart(Date.now()) + 12 * H;
const at = (h) => new Date(now - h * H).toISOString();
const item = (Id, h, extra = {}) => ({ Id, Name: Id, Type: 'Movie', UserData: h === null ? {} : { LastPlayedDate: at(h) }, ...extra });

// ---- History ----
const items = [
  item('never', null),
  item('old', 24 * 40, { RunTimeTicks: 100 * TICKS_MIN, UserData: { LastPlayedDate: at(24 * 40), Played: true } }),
  item('today-2', 2, { RunTimeTicks: 90 * TICKS_MIN, UserData: { LastPlayedDate: at(2), Played: true }, Genres: ['Drame'] }),
  item('today-1', 1, { RunTimeTicks: 120 * TICKS_MIN, UserData: { LastPlayedDate: at(1), PlaybackPositionTicks: 30 * TICKS_MIN }, Type: 'Episode', SeriesId: 's1' }),
  item('yesterday', 24, { RunTimeTicks: 60 * TICKS_MIN, UserData: { LastPlayedDate: at(24), Played: true }, Genres: ['Action', 'Drame'] }),
  item('ten-days', 24 * 10, { RunTimeTicks: 45 * TICKS_MIN, UserData: { LastPlayedDate: at(240), Played: true }, Genres: ['Action'] }),
];

assert.deepEqual(recentFirst(items).map((i) => i.Id), ['today-1', 'today-2', 'yesterday', 'ten-days', 'old'], 'most recent first, never played dropped');

const groups = groupByDay(items);
assert.deepEqual(groups.map((g) => g.items.map((i) => i.Id)), [['today-1', 'today-2'], ['yesterday'], ['ten-days'], ['old']], 'grouped by local day');
assert.deepEqual(groups.map((g) => daysAgo(g.day, now)), [0, 1, 10, 40], 'day offsets');

const stats = watchStats(items, new Map([['s1', ['Science-fiction', 'Drame']]]), now);
// 7 days: 90 (played) + 30 (position) + 60 (played) minutes; 30 days adds the 45-minute one.
assert.equal(stats.weekMs, (90 + 30 + 60) * 60_000, 'week total');
assert.equal(stats.monthMs, (90 + 30 + 60 + 45) * 60_000, 'month total');
assert.deepEqual(stats.genres, ['Drame', 'Action', 'Science-fiction'], 'top genres, series genres for episodes, ties by name');
assert.deepEqual(watchStats([], undefined, now), { weekMs: 0, monthMs: 0, genres: [] }, 'empty history');

// ---- Admin alerts ----
const failed = (Id, h) => ({ Id, Name: `Task ${Id}`, LastExecutionResult: { Status: 'Failed', EndTimeUtc: at(h) } });
const tasks = [failed('a', 2), failed('stale', 30), { Id: 'ok', Name: 'ok', LastExecutionResult: { Status: 'Completed', EndTimeUtc: at(1) } }, { Id: 'never', Name: 'never' }];

let r = adminAlerts('srv', { HasPendingRestart: true, HasUpdateAvailable: true }, tasks, [], now);
assert.deepEqual(r.alerts, [{ kind: 'restart' }, { kind: 'update' }, { kind: 'task', taskId: 'a', name: 'Task a' }], 'first poll: restart, update, recent failure only');

r = adminAlerts('srv', { HasPendingRestart: true, HasUpdateAvailable: true }, tasks, r.seen, now);
assert.deepEqual(r.alerts, [], 'second poll: nothing new');

r = adminAlerts('srv', { HasPendingRestart: false, HasUpdateAvailable: true }, [failed('a', 1)], r.seen, now);
assert.deepEqual(r.alerts, [{ kind: 'task', taskId: 'a', name: 'Task a' }], 'the same task failing again is a new alert');

r = adminAlerts('srv', { HasPendingRestart: true }, null, r.seen, now);
assert.deepEqual(r.alerts, [{ kind: 'restart' }], 'a restart flag that cleared and came back is announced again');

r = adminAlerts('other', null, null, r.seen, now);
assert.deepEqual(r.alerts, [], 'a server without the routes (null) raises nothing');

const many = Array.from({ length: 300 }, (_, i) => `k${i}`);
assert.equal(adminAlerts('srv', null, null, many, now).seen.length, 200, 'seen list stays bounded');

console.log('desk-shell-check: history and admin alert rules OK');
