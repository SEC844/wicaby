import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Saves what [open] returns to [file]. Fails, and removes the file, past [cap] bytes or after [idleMs] without
// a byte (the request itself is aborted too), so a stalled server cannot hang an open for the whole session.
// [msg]: the translated errors (this file stays free of Electron for the checks).
export async function download(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  file: string,
  cap: number,
  idleMs: number,
  msg: { tooLarge: string; stalled: string },
): Promise<void> {
  const ctl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error(msg.stalled)), idleMs);
  };
  kick();
  let got = 0;
  try {
    const body = await open(ctl.signal);
    await pipeline(
      Readable.fromWeb(body as never),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          got += chunk.length;
          if (got > cap) throw new Error(msg.tooLarge);
          kick();
          yield chunk;
        }
      },
      fs.createWriteStream(file),
      { signal: ctl.signal },
    );
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw ctl.signal.aborted ? ctl.signal.reason : err;
  } finally {
    clearTimeout(idle);
  }
}
