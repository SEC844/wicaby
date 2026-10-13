// Plex image paths ↔ Emby image routes (plex-spec §2, §4). The renderer keeps building
// /Items/{id}/Images/{type}?tag=…; the item mapper hands the adapter a map from '{id}/{type}' to the PMS path
// (imagePaths), and the adapter turns a request back into a PMS /photo/:/transcode URL (transcodePath).
// The tag is the PMS path's last segment (a timestamp), so a changed image gets a new URL. Pure.
import type { PlexMeta } from './types';

export type ImageType = 'Primary' | 'Backdrop' | 'Thumb' | 'Logo' | 'Banner';

// Last path segment of a PMS image path ('/library/metadata/1/thumb/1700000000' → '1700000000'); a URL
// (people's thumbs on the Plex CDN) gets a short stable hash of itself.
export function imageTag(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  }
  const seg = path.split('?')[0].split('/').filter(Boolean).pop();
  return seg && /^[A-Za-z0-9._-]{1,64}$/.test(seg) ? seg : undefined;
}

// Image[] (newer PMS) by Plex type, falling back to the scalar fields.
function imageOf(meta: PlexMeta, type: string): string | undefined {
  return meta.Image?.find((i) => i.type === type)?.url;
}

// '{itemId}/{ImageType}' → PMS path, for the item and the parents its card or page shows.
export function imagePaths(meta: PlexMeta): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (id: string | number | undefined, type: ImageType, path: string | undefined) => {
    if (id !== undefined && id !== '' && path) out[`${id}/${type}`] = path;
  };
  const id = meta.ratingKey;
  set(id, 'Primary', imageOf(meta, 'coverPoster') ?? imageOf(meta, 'snapshot') ?? meta.thumb);
  set(id, 'Backdrop', imageOf(meta, 'background') ?? meta.art);
  set(id, 'Logo', imageOf(meta, 'clearLogo'));
  set(meta.parentRatingKey, 'Primary', meta.parentThumb);
  set(meta.grandparentRatingKey, 'Primary', meta.grandparentThumb);
  set(meta.grandparentRatingKey, 'Backdrop', meta.grandparentArt);
  for (const p of [...(meta.Role ?? []), ...(meta.Director ?? []), ...(meta.Writer ?? [])]) if (p.id !== undefined) set(`person-${p.id}`, 'Primary', p.thumb);
  return out;
}

// Emby image route → its parts, or null. Index is accepted and ignored (Plex has one image per type).
export function parseImageRoute(path: string): { id: string; type: ImageType } | null {
  const m = /^\/Items\/([A-Za-z0-9-]{1,64})\/Images\/(Primary|Backdrop|Thumb|Logo|Banner)(?:\/\d+)?$/.exec(path);
  return m ? { id: m[1], type: m[2] as ImageType } : null;
}

// Emby image query (maxWidth, fillHeight…, any case) → a PMS photo transcode path. Without a size, the
// image is served 1920 wide (a backdrop) or 600 (anything else).
export function transcodePath(pmsPath: string, type: ImageType, query: Record<string, string | number | undefined> = {}): string {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q[k.toLowerCase()] = String(v);
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const n = Math.round(Number(q[k]));
      if (n > 0) return Math.min(n, 4096);
    }
    return 0;
  };
  // Emby fill* covers the box (PMS minSize=1); max*, width and height fit inside it (minSize=0).
  const fill = num('fillwidth', 'fillheight') > 0;
  let width = num('fillwidth', 'maxwidth', 'width');
  let height = num('fillheight', 'maxheight', 'height');
  if (!width && !height) width = type === 'Backdrop' ? 1920 : 600;
  // PMS needs both sides: the missing one is set so the given one decides (tiny to cover, large to fit).
  if (!width) width = fill ? 1 : height * 4;
  if (!height) height = fill ? 1 : width * 4;
  const quality = num('quality');
  const out = new URLSearchParams({ url: pmsPath, width: String(width), height: String(height), minSize: fill ? '1' : '0', upscale: '1' });
  if (quality) out.set('quality', String(Math.min(quality, 100)));
  return `/photo/:/transcode?${out}`;
}
