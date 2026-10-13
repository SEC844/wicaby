import { bifFrameAt, parseBif, type Bif } from '../../shared/bif';
import type { Trickplay } from '../../shared/contract';

// A scrub thumbnail: a whole image (BIF frame), or one cell of a tile sheet.
export interface Thumb {
  src: string;
  cell?: { col: number; row: number; cols: number; width: number; height: number };
}

// One BIF at a time: it is the item being played. Frames become blob URLs on first use.
let bif: { url: string; data: Uint8Array<ArrayBuffer>; parsed: Bif; frames: Map<number, string> } | null = null;
let pending: { url: string; promise: Promise<boolean> } | null = null;

function release(): void {
  bif?.frames.forEach((u) => URL.revokeObjectURL(u));
  bif = null;
}

// Fetched through wicaby-media:// (main adds auth); false when the server has no BIF.
export function loadBif(url: string): Promise<boolean> {
  if (bif?.url === url) return Promise.resolve(true);
  if (pending?.url === url) return pending.promise;
  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) return false;
      const data = new Uint8Array(await res.arrayBuffer());
      const parsed = parseBif(data);
      release();
      bif = { url, data, parsed, frames: new Map() };
      return parsed.frames.length > 0;
    })
    .catch(() => false)
    .finally(() => {
      if (pending?.url === url) pending = null;
    });
  pending = { url, promise };
  return promise;
}

export function thumbAt(t: Trickplay | undefined, positionMs: number): Thumb | null {
  if (!t) return null;
  if (t.kind === 'tiles') {
    if (t.intervalMs <= 0 || t.count <= 0) return null;
    const n = Math.min(t.count - 1, Math.max(0, Math.floor(positionMs / t.intervalMs)));
    const per = t.tileWidth * t.tileHeight;
    const i = n % per;
    return {
      src: t.url.replace('{n}', String(Math.floor(n / per))),
      cell: { col: i % t.tileWidth, row: Math.floor(i / t.tileWidth), cols: t.tileWidth, width: t.width, height: t.height },
    };
  }
  if (bif?.url !== t.url) return null;
  const i = bifFrameAt(bif.parsed, positionMs);
  if (i < 0) return null;
  let src = bif.frames.get(i);
  if (!src) {
    const f = bif.parsed.frames[i];
    const bytes = bif.data.subarray(f.offset, f.offset + f.size);
    src = URL.createObjectURL(new Blob([bytes], { type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }));
    bif.frames.set(i, src);
  }
  return { src };
}
