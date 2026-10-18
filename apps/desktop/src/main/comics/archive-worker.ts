// Worker thread for archive.ts: one job from workerData, one message back. Bundled on its own
// (out/main/archive-worker.cjs) and started by ComicService; comic-formats-check bundles it the same way.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { walkArchive } from './archive';
import { archiveError, type ArchiveJob, type ArchiveResult } from './archive-job';
import { flatName } from './formats';
import { coverEntry, pageEntries } from './zip';

const isPage = (name: string) => pageEntries([{ name }]).length > 0;
const isInfo = (name: string) => /(^|[\\/])comicinfo\.xml$/i.test(name);

async function run(job: ArchiveJob): Promise<ArchiveResult> {
  if (job.mode === 'cover') {
    const found: { name: string; data: Uint8Array }[] = [];
    // The cover is among the pages read before the size cap: a long book ends the walk, it is not an error.
    await walkArchive(job.data, isPage, (name, data) => found.push({ name, data }), job.limits, { partial: job.partial, wasmBinary: job.wasm }).catch((err: { code?: string }) => {
      if (err.code !== 'tooLarge' || found.length === 0) throw err;
    });
    return coverEntry(found) ?? { none: true };
  }
  const size = fs.statSync(job.file).size;
  if (size > job.maxArchive) throw archiveError('tooLarge', `${size} bytes`);
  // Written beside the final folder, renamed once complete: a crash never leaves half a book behind.
  const part = `${job.dir}.part`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true });
  const names: string[] = [];
  try {
    await walkArchive(
      fs.readFileSync(job.file),
      (name) => isPage(name) || isInfo(name),
      (name, data) => {
        const flat = flatName(names.length, name);
        fs.writeFileSync(path.join(part, flat), data);
        names.push(flat);
      },
      job.limits,
      { wasmBinary: job.wasm },
    );
    fs.rmSync(job.dir, { recursive: true, force: true });
    fs.renameSync(part, job.dir);
  } catch (err) {
    fs.rmSync(part, { recursive: true, force: true });
    throw err;
  }
  return { names };
}

run(workerData as ArchiveJob).then(
  (ok) => parentPort?.postMessage({ ok }),
  (err: Error & { code?: string }) => parentPort?.postMessage({ error: err.message, code: err.code }),
);
