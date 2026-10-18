// The main-process side of archive.ts: the job a worker thread runs, and how it is started and timed.
// Kept apart so the main bundle does not carry libarchive (only archive-worker.cjs does).
import { Worker } from 'node:worker_threads';

export interface ArchiveLimits {
  // Largest entry read (MAX_ENTRY_SIZE), all entries read together, and entries walked.
  maxEntry: number;
  maxTotal: number;
  maxEntries: number;
}

export type ArchiveErrorCode = 'encrypted' | 'tooLarge' | 'corrupt';
export const archiveError = (code: ArchiveErrorCode, message: string = code): Error => Object.assign(new Error(message), { code });

// extract: [file] read whole (<= maxArchive bytes) and its pages plus ComicInfo.xml written into
//          [dir] as flatName files. cover: the best cover image among the entries in [data].
export type ArchiveJob =
  | { mode: 'extract'; file: string; dir: string; maxArchive: number; limits: ArchiveLimits; wasm?: Uint8Array }
  | { mode: 'cover'; data: Uint8Array; partial: boolean; limits: ArchiveLimits; wasm?: Uint8Array };
export type ArchiveResult = { names: string[] } | { name: string; data: Uint8Array } | { none: true };

// Starts the worker on [script] (a file, or its source with evaluate) and gives it [timeoutMs] and
// 256 MB of JS heap (the archive itself sits in WebAssembly memory, capped at 2 GiB by the build).
export function runArchiveJob(script: string | URL, evaluate: boolean, job: ArchiveJob, timeoutMs = 120_000): Promise<ArchiveResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: evaluate, workerData: job, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(archiveError('corrupt', 'archive worker timed out'))), timeoutMs);
    worker.once('message', (m: { ok: ArchiveResult } | { error: string; code?: ArchiveErrorCode }) =>
      finish(() => ('ok' in m ? resolve(m.ok) : reject(archiveError(m.code ?? 'corrupt', m.error)))),
    );
    worker.once('error', (err) => finish(() => reject(archiveError('corrupt', err.message))));
    worker.once('exit', (code) => finish(() => reject(archiveError('corrupt', `archive worker exited (${code})`))));
  });
}
