// Image sizing and placeholders.
import type { BaseItem } from '$shared/models';
import { dp } from './screen';

// Device pixels for a length in dp (1rem): what to ask the server for, so it resizes once and the TV decodes the
// smallest image that is still sharp.
export function dpPx(n: number): number {
  return Math.ceil(dp(n) * (window.devicePixelRatio || 1));
}

const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

// A BlurHash's average colour sits in characters 2-5 (base 83, sRGB): a free placeholder tint, no decoding pass.
export function blurhashColor(hash: string | undefined): string | undefined {
  if (!hash || hash.length < 6) return undefined;
  let v = 0;
  for (let i = 2; i < 6; i++) {
    const d = B83.indexOf(hash[i]);
    if (d < 0) return undefined;
    v = v * 83 + d;
  }
  return `rgb(${v >> 16},${(v >> 8) & 255},${v & 255})`;
}

// The placeholder tint of an item's image of [type] (the server lists hashes per image type and tag).
export function placeholder(item: BaseItem, type: 'Primary' | 'Backdrop' | 'Thumb'): string | undefined {
  const byTag = item.ImageBlurHashes?.[type];
  if (!byTag) return undefined;
  const tag = type === 'Backdrop' ? item.BackdropImageTags?.[0] : item.ImageTags?.[type];
  return blurhashColor((tag && byTag[tag]) || Object.values(byTag)[0]);
}
