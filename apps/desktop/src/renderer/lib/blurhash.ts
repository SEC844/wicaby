// Tiny BlurHash decoder (https://blurha.sh) for image placeholders. Jellyfin
// sends hashes in ImageBlurHashes; Emby does not, so callers fall back to a fill.
import type { BaseItem } from '../../shared/models';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function d83(s: string, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 83 + CHARS.indexOf(s[i]);
  return v;
}
const toLinear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => {
  v = Math.max(0, Math.min(1, v));
  return Math.trunc(v <= 0.0031308 ? v * 12.92 * 255 + 0.5 : (1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
};
const signPow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

export function decodeBlurhash(hash: string, w = 32, h = 32): ImageData | null {
  if (!hash || hash.length < 6) return null;
  const size = d83(hash, 0, 1);
  const nx = (size % 9) + 1;
  const ny = Math.floor(size / 9) + 1;
  if (hash.length !== 4 + 2 * nx * ny) return null;
  const maxAc = (d83(hash, 1, 2) + 1) / 166;
  const colors: number[][] = [];
  const dc = d83(hash, 2, 6);
  colors.push([toLinear(dc >> 16), toLinear((dc >> 8) & 255), toLinear(dc & 255)]);
  for (let i = 1; i < nx * ny; i++) {
    const v = d83(hash, 4 + i * 2, 6 + i * 2);
    colors.push([Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19].map((q) => signPow((q - 9) / 9, 2) * maxAc));
  }
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ny; j++) {
        const by = Math.cos((Math.PI * y * j) / h);
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / w) * by;
          const c = colors[i + j * nx];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const p = 4 * (x + y * w);
      out.data[p] = toSrgb(r);
      out.data[p + 1] = toSrgb(g);
      out.data[p + 2] = toSrgb(b);
      out.data[p + 3] = 255;
    }
  }
  return out;
}

type WithHashes = BaseItem & { ImageBlurHashes?: Record<string, Record<string, string>> };

// Hash for the image an item card shows (own Primary/Thumb, else the series poster).
export function blurhashOf(item: BaseItem, type: 'Primary' | 'Thumb' | 'Backdrop'): string | undefined {
  const all = (item as WithHashes).ImageBlurHashes?.[type];
  if (!all) return undefined;
  const tag = type === 'Backdrop' ? item.BackdropImageTags?.[0] : (item.ImageTags?.[type] ?? (type === 'Primary' ? item.SeriesPrimaryImageTag : undefined));
  return (tag && all[tag]) || Object.values(all)[0];
}

// Decoded once per hash (a grid remounts its tiles while scrolling), at 16 × 16: CSS stretches it anyway.
const decoded = new Map<string, ImageData | null>();
function cachedDecode(h: string): ImageData | null {
  let data = decoded.get(h);
  if (data === undefined) {
    data = decodeBlurhash(h, 16, 16);
    if (decoded.size >= 1000) decoded.delete(decoded.keys().next().value!);
    decoded.set(h, data);
  }
  return data;
}

// Svelte action: paint a hash into a small canvas that CSS stretches to the frame.
export function blurhash(canvas: HTMLCanvasElement, hash: string | undefined) {
  const paint = (h: string | undefined) => {
    const data = h ? cachedDecode(h) : null;
    if (!data) return;
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.getContext('2d')?.putImageData(data, 0, 0);
  };
  paint(hash);
  return { update: paint };
}
