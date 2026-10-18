// Thumbnails of photo file sources: made on demand by nativeImage (JPEG and PNG; other formats go to the page as
// they are), a few sizes only, at most JOBS at once, cached on disk by source, path, size+mtime and size bucket.
// shortcut: decoding runs on the main process like comic covers do; move it to a utility process if a large
// first scroll ever stalls IPC.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { extOf } from '../../shared/files/names';
import type { PhotoHead } from '../../shared/files/exif';
import { imageSize } from '../comics/image-size';

// Largest side asked (device px) -> the bucket made; past the last one the original is served (viewer zoom).
const BUCKETS = [360, 720, 1440];
const JOBS = 3;
const CAP = 300 * 1024 * 1024;
// No decode in main past 64 megapixels (an image bomb), nor of a size the header did not give.
const MAX_PIXELS = 64 * 1024 * 1024;

export class PhotoThumbs {
  private active = 0;
  private waiting: (() => void)[] = [];
  private pending = new Map<string, Promise<Buffer | null>>();
  private writes = 0;

  constructor(private readonly dir: string) {}

  static bucket(px: number): number | null {
    return px > 0 ? (BUCKETS.find((b) => b >= px) ?? null) : BUCKETS[0];
  }

  // The thumbnail fitting maxWidth x maxHeight (either 0: free), or null when the original should go instead.
  // key: the photo and its version (source, path, size+mtime).
  async get(key: string, name: string, head: PhotoHead, maxWidth: number, maxHeight: number, read: () => Promise<Buffer>, signal?: AbortSignal): Promise<Buffer | null> {
    const ext = extOf(name);
    const { width: w, height: h } = head;
    if (!['jpg', 'jpeg', 'png'].includes(ext) || !w || !h || w * h > MAX_PIXELS) return null;
    const bw = maxWidth ? PhotoThumbs.bucket(maxWidth) : Infinity;
    const bh = maxHeight || !maxWidth ? PhotoThumbs.bucket(maxHeight) : Infinity;
    if (bw === null || bh === null) return null;
    // The box is asked of the photo as shown: a quarter-turned one fits it with its stored sides swapped.
    const turned = (head.orientation ?? 1) >= 5;
    const file = path.join(this.dir, `${createHash('sha1').update(`${key}/${bw}x${bh}`).digest('hex')}.jpg`);
    try {
      return await fs.promises.readFile(file);
    } catch {
      // not made yet
    }
    let p = this.pending.get(file);
    if (!p) {
      p = this.slot(signal, async () => {
        const buf = await read();
        // The head's sides may come from EXIF (the frame header past the bytes read): the real frame decides.
        const real = imageSize(buf);
        if (!real || real[0] * real[1] > MAX_PIXELS) return null;
        const scale = Math.min(1, (turned ? bh : bw) / real[0], (turned ? bw : bh) / real[1]);
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return null;
        const size = img.getSize();
        const data = img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toJPEG(82);
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(file, data);
        if (++this.writes % 100 === 0) void this.prune();
        return data;
      }).finally(() => this.pending.delete(file));
      this.pending.set(file, p);
    }
    return p;
  }

  private async slot<T>(signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T | null> {
    while (this.active >= JOBS) await new Promise<void>((r) => this.waiting.push(r));
    // A tile scrolled away before its turn: not made.
    if (signal?.aborted) return (this.waiting.shift()?.(), null);
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  // Oldest first once the folder passes CAP.
  private async prune(): Promise<void> {
    try {
      const files = await Promise.all((await fs.promises.readdir(this.dir)).map(async (f) => ({ f, st: await fs.promises.stat(path.join(this.dir, f)) })));
      let total = files.reduce((s, x) => s + x.st.size, 0);
      for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
        if (total <= CAP) break;
        await fs.promises.rm(path.join(this.dir, x.f), { force: true });
        total -= x.st.size;
      }
    } catch {
      // the next prune tries again
    }
  }
}
