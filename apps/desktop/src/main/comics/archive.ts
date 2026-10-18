// RAR (4 and 5), 7z and tar comics through libarchive (BSD-2, compiled to WebAssembly by libarchive-wasm, MIT).
// No UnRAR code: libarchive's RAR readers are its own BSD code, so the GPL build stays clean.
// Runs in a worker thread (archive-worker.ts, started by archive-job.ts): a hostile archive can use
// up the worker's time and memory, never the main process's. Erasable syntax, no Electron: the checks run it under Node.
import lib from 'libarchive-wasm';
import { archiveError, type ArchiveLimits } from './archive-job';

type Lib = Awaited<ReturnType<typeof lib.libarchiveWasm>>;
let loaded: Promise<Lib> | null = null;
function load(wasmBinary?: Uint8Array): Promise<Lib> {
  // The bundled worker gets the .wasm bytes from main (it may sit inside app.asar).
  loaded ??= lib.libarchiveWasm(wasmBinary ? { wasmBinary } : undefined);
  return loaded;
}

// One pass over the archive (RAR and solid 7z can only be read in order). [want] picks the entries
// whose bytes go to [take]; the others are skipped. partial: the data is the start of a longer file
// (a cover read with one Range request); the walk ends quietly where the bytes do.
export async function walkArchive(
  data: Uint8Array,
  want: (name: string) => boolean,
  take: (name: string, bytes: Uint8Array) => void,
  limits: ArchiveLimits,
  opts: { partial?: boolean; wasmBinary?: Uint8Array } = {},
): Promise<void> {
  const mod = await load(opts.wasmBinary);
  let reader: InstanceType<typeof lib.ArchiveReader>;
  try {
    reader = new lib.ArchiveReader(mod, new Int8Array(data.buffer, data.byteOffset, data.byteLength));
  } catch (err) {
    throw archiveError('corrupt', (err as Error).message);
  }
  let seen = 0;
  let total = 0;
  try {
    for (;;) {
      const entry = reader.nextEntry();
      if (!entry) break;
      try {
        if (++seen > limits.maxEntries) throw archiveError('tooLarge', 'too many entries');
        if (entry.getFiletype() !== 'File') continue;
        const name = entry.getPathname();
        if (!want(name)) continue;
        if (entry.isEncrypted()) throw archiveError('encrypted');
        const size = entry.getSize();
        if (size > limits.maxEntry || total + size > limits.maxTotal) throw archiveError('tooLarge', `${name}: ${size} bytes`);
        let raw: Int8Array | undefined;
        try {
          raw = entry.readData();
        } catch (err) {
          if (opts.partial) return;
          throw archiveError(/encrypt|passphrase/i.test((err as Error).message) ? 'encrypted' : 'corrupt', (err as Error).message);
        }
        if (!raw || (opts.partial && raw.length < size)) continue;
        total += raw.length;
        take(name, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      } finally {
        entry.free();
      }
    }
    // RAR5 with encrypted headers lists nothing at all.
    if (seen === 0 && reader.hasEncryptedData()) throw archiveError('encrypted');
  } catch (err) {
    // A truncated prefix fails wherever the bytes stop; what was taken so far stands.
    if (opts.partial && (err as { code?: string }).code === 'corrupt') return;
    throw err;
  } finally {
    reader.free();
  }
}
