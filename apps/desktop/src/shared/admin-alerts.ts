// Which background admin alerts to raise, from one poll of a server's /System/Info and
// /ScheduledTasks (same shape on Emby and Jellyfin; either may be null when the server
// refused or lacks the route). Dependency-free so tools/checks/desk-shell-check.mjs runs it.

export interface AlertSystemInfo {
  HasPendingRestart?: boolean;
  // Emby; Jellyfin always reports false (it has no server update check).
  HasUpdateAvailable?: boolean;
}

export interface AlertTask {
  Id: string;
  Name: string;
  LastExecutionResult?: { Status?: string; EndTimeUtc?: string } | null;
}

export type AdminAlert = { kind: 'restart' } | { kind: 'update' } | { kind: 'task'; taskId: string; name: string };

// A failure older than this when first seen (app started later) is old news.
const TASK_MAX_AGE_MS = 24 * 3_600_000;
const MAX_SEEN = 200;

// `seen` holds the keys already announced (persisted across runs). A restart or update flag
// that clears drops its key, so the next occurrence is announced again.
export function adminAlerts(
  serverId: string,
  info: AlertSystemInfo | null,
  tasks: AlertTask[] | null,
  seen: readonly string[],
  now = Date.now(),
): { alerts: AdminAlert[]; seen: string[] } {
  const next = new Set(seen);
  const alerts: AdminAlert[] = [];
  if (info) {
    for (const kind of ['restart', 'update'] as const) {
      const key = `${serverId}:${kind}`;
      const on = kind === 'restart' ? info.HasPendingRestart : info.HasUpdateAvailable;
      if (!on) next.delete(key);
      else if (!next.has(key)) {
        next.add(key);
        alerts.push({ kind });
      }
    }
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const r = task.LastExecutionResult;
    const end = Date.parse(r?.EndTimeUtc ?? '');
    if (r?.Status !== 'Failed' || !Number.isFinite(end) || now - end > TASK_MAX_AGE_MS) continue;
    const key = `${serverId}:task:${task.Id}:${end}`;
    if (next.has(key)) continue;
    next.add(key);
    alerts.push({ kind: 'task', taskId: task.Id, name: task.Name });
  }
  return { alerts, seen: [...next].slice(-MAX_SEEN) };
}
