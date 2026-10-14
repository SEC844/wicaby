// Music covers (music-feishin-navidrome spec §4.A, MU-A1 to MU-A5), shared by the renderer and the checks. The Kotlin
// twin is core/music/MusicArt.kt; both run tools/checks/fixtures/music/cover-vectors.json.
// Emby keeps no Primary on an album whose only art is embedded in its tracks (the owner's field bug: the cover shows
// once a track plays), and artists without MusicBrainz ids get no image: those borrow their first track's or first
// album's cover, found by one lookup per item, cached, a few at a time.
import type { BaseItem } from './models';

// A server image: the item that holds it and its tag.
export interface ArtRef {
  id: string;
  tag: string;
}
// An image now, a lookup to make first, or nothing (the placeholder).
export type ArtPlan = { ref: ArtRef } | { lookup: 'firstTrack' | 'firstAlbum' } | null;

export function musicArt(item: BaseItem): ArtPlan {
  const own = item.ImageTags?.Primary;
  if (own) return { ref: { id: item.Id, tag: own } };
  if (item.Type === 'Audio' && item.AlbumId && item.AlbumPrimaryImageTag) return { ref: { id: item.AlbumId, tag: item.AlbumPrimaryImageTag } };
  if (item.Type === 'MusicAlbum') return { lookup: 'firstTrack' };
  if (item.Type === 'MusicArtist') return { lookup: 'firstAlbum' };
  return null;
}

// The /Items query of a lookup. Emby's AlbumArtistIds is unverified on 4.8+ (music spec §3.2): ArtistIds with
// ArtistType=AlbumArtist there, as the artist pages do. ImageTypes=Primary skips tracks without art where honoured.
export function lookupQuery(kind: 'firstTrack' | 'firstAlbum', id: string, emby: boolean): Record<string, string | number | boolean> {
  const common = { Recursive: true, Limit: 1, EnableImageTypes: 'Primary', ImageTypeLimit: 1, EnableUserData: false, Fields: 'PrimaryImageAspectRatio' };
  if (kind === 'firstTrack') return { ParentId: id, IncludeItemTypes: 'Audio', ImageTypes: 'Primary', SortBy: 'ParentIndexNumber,IndexNumber,SortName', ...common };
  return { ...(emby ? { ArtistIds: id, ArtistType: 'AlbumArtist' } : { AlbumArtistIds: id }), IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', ...common };
}

// Resolves covers with lookups: one per item (per server), answers kept for the session (no image too), at most
// [parallel] in flight. An artist's first album without a Primary is looked up in turn (its own cached lookup).
export function coverResolver(lookup: (kind: 'firstTrack' | 'firstAlbum', item: BaseItem) => Promise<BaseItem | undefined>, parallel = 3) {
  const cache = new Map<string, Promise<ArtRef | null>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  async function slot<T>(f: () => Promise<T>): Promise<T> {
    if (active < parallel) active++;
    else await new Promise<void>((r) => waiting.push(r)); // the slot is handed over, not re-counted
    try {
      return await f();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  function resolve(item: BaseItem, depth = 0): Promise<ArtRef | null> {
    const plan = musicArt(item);
    if (!plan || 'ref' in plan) return Promise.resolve(plan?.ref ?? null);
    if (depth > 1) return Promise.resolve(null);
    const key = `${item.ServerId ?? ''}:${item.Id}`;
    let p = cache.get(key);
    if (!p) {
      p = slot(() => lookup(plan.lookup, item)).then(
        (child) => (child ? resolve({ ...child, ServerId: child.ServerId ?? item.ServerId }, depth + 1) : null),
        // A failed lookup (offline, timeout) is asked again next time.
        () => (cache.delete(key), null),
      );
      cache.set(key, p);
    }
    return p;
  }
  return { resolve, inFlight: () => active };
}

// Requested sizes in device pixels, from a few buckets so the server's resize cache is shared (MU-A5).
const SIZES = [80, 160, 240, 320, 480, 720, 960, 1200];
export function musicSize(cssPx: number, dpr: number): number {
  const px = cssPx * dpr;
  return SIZES.find((s) => s >= px) ?? SIZES[SIZES.length - 1];
}

// The placeholder (MU-A4): up to two initials (first and last word that starts with a letter or digit, accents kept)
// on a hue from an FNV-1a hash of the name (UTF-16 units, as Kotlin's Char codes).
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).map((w) => /^[\p{L}\p{N}]\p{M}*/u.exec(w)?.[0]).filter((x): x is string => Boolean(x));
  return (words.length > 1 ? words[0] + words[words.length - 1] : (words[0] ?? '')).toUpperCase();
}

export function nameHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h % 360;
}

// The tile colour: hsl(hue 35% 32%), dark enough for white initials (≥ 4.5:1 at every hue, music-art-check).
export const PLACEHOLDER_S = 0.35;
export const PLACEHOLDER_L = 0.32;
export function hslRgb(h: number, s = PLACEHOLDER_S, l = PLACEHOLDER_L): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

// Dominant colour of a small RGBA image (16 × 16, MU-A3): the most common coarse colour bin (3 bits a channel) among
// opaque pixels that are neither near black, near white nor grey, averaged; else the plain average; null if nothing is
// opaque. '#rrggbb'.
export function dominantColour(rgba: ArrayLike<number>): string | null {
  const bins = new Map<number, number[]>();
  const all = [0, 0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (rgba[i + 3] < 128) continue;
    all[0] += r;
    all[1] += g;
    all[2] += b;
    all[3]++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 24 || min > 232 || max - min < 20) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) ?? [0, 0, 0, 0];
    bin[0] += r;
    bin[1] += g;
    bin[2] += b;
    bin[3]++;
    bins.set(key, bin);
  }
  let best = all;
  for (const bin of bins.values()) if (best === all || bin[3] > best[3]) best = bin;
  if (best[3] === 0) return null;
  return '#' + [0, 1, 2].map((c) => Math.round(best[c] / best[3]).toString(16).padStart(2, '0')).join('');
}
