// Local progress of file sources (file-sources-spec §4.4): the key, resume and played thresholds, the
// Continue row and LRU pruning. Pure; vectors in tools/checks/fixtures/files/progress.json.

export interface ProgressRecord {
  // Whole seconds: WebDAV dates have second precision, SMB 100 ns.
  size: number;
  mtimeSec: number;
  positionMs: number;
  durationMs: number;
  played: boolean;
  hidden: boolean;
  lastPlayedAt: number;
  // Tags captured at first play (D5).
  title?: string;
}

// Per source: records by relative path.
export interface ProgressDoc {
  v: 1;
  records: Record<string, ProgressRecord>;
}

export const RESUME_MIN = 0.05;
export const PLAYED_MIN = 0.9;
export const CONTINUE_LIMIT = 24;
export const MAX_RECORDS = 10_000;

export const mtimeSec = (mtimeMs: number): number => Math.floor(mtimeMs / 1000);

export function progressKey(rel: string, size: number, mtimeMs: number): string {
  return `${rel}\u0000${size}\u0000${mtimeSec(mtimeMs)}`;
}

// The record still describes this file (same size and modification second).
export function sameFile(r: ProgressRecord | undefined, size: number, mtimeMs: number): boolean {
  return Boolean(r) && r!.size === size && r!.mtimeSec === mtimeSec(mtimeMs);
}

// A position report: under 5 % is no resume point, 90 % or more marks the file played and clears it.
export function report(prev: ProgressRecord | undefined, file: { size: number; mtimeMs: number }, positionMs: number, durationMs: number, now: number): ProgressRecord {
  const same = sameFile(prev, file.size, file.mtimeMs);
  const duration = durationMs > 0 ? durationMs : same ? prev!.durationMs : 0;
  const ratio = duration > 0 ? positionMs / duration : 0;
  // Played stays until it is unmarked.
  const played = ratio >= PLAYED_MIN || (same && prev!.played);
  return {
    size: file.size,
    mtimeSec: mtimeSec(file.mtimeMs),
    positionMs: ratio >= RESUME_MIN && ratio < PLAYED_MIN ? Math.round(positionMs) : 0,
    durationMs: Math.round(duration),
    played,
    // Playing it again brings a hidden file back.
    hidden: false,
    lastPlayedAt: now,
    ...(same && prev!.title ? { title: prev!.title } : {}),
  };
}

// Continue row: records with a position, not hidden, last played first.
export function continueList(doc: ProgressDoc, limit = CONTINUE_LIMIT): string[] {
  return Object.entries(doc.records)
    .filter(([, r]) => r.positionMs > 0 && !r.hidden)
    .sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([rel]) => rel);
}

// Keeps the max most recently played records.
export function prune(doc: ProgressDoc, max = MAX_RECORDS): ProgressDoc {
  const entries = Object.entries(doc.records);
  if (entries.length <= max) return doc;
  entries.sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt || (a[0] < b[0] ? -1 : 1));
  return { v: 1, records: Object.fromEntries(entries.slice(0, max)) };
}
