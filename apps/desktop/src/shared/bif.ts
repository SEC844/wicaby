// Roku BIF (Emby /Videos/{id}/index.bif): 64-byte header (magic, u32 version,
// u32 count, u32 ms multiplier), then count+1 little-endian (timestamp, offset)
// pairs, the last one a 0xFFFFFFFF sentinel whose offset ends the final image.

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

export interface BifFrame {
  startMs: number;
  offset: number;
  size: number;
}

export interface Bif {
  version: number;
  intervalMs: number;
  frames: BifFrame[];
}

export function parseBif(data: Uint8Array): Bif {
  if (data.length < 64 || MAGIC.some((b, i) => data[i] !== b)) throw new Error('not a BIF file');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = v.getUint32(8, true);
  const count = v.getUint32(12, true);
  const intervalMs = v.getUint32(16, true) || 1000;
  if (64 + (count + 1) * 8 > data.length) throw new Error('truncated BIF index');
  const frames: BifFrame[] = [];
  for (let i = 0; i < count; i++) {
    const at = 64 + i * 8;
    const offset = v.getUint32(at + 4, true);
    const end = v.getUint32(at + 12, true);
    if (end < offset || end > data.length) throw new Error('bad BIF offset');
    frames.push({ startMs: v.getUint32(at, true) * intervalMs, offset, size: end - offset });
  }
  return { version, intervalMs, frames };
}

// Index of the frame shown at positionMs (the last one starting at or before it).
export function bifFrameAt(bif: Bif, positionMs: number): number {
  const f = bif.frames;
  let lo = 0;
  let hi = f.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].startMs <= positionMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
