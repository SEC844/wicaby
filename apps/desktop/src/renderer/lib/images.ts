import { comicCoverVersion } from '../../shared/comic-cover';
import { MEDIA_SCHEME } from '../../shared/contract';
import { isFilesId } from '../../shared/files/ids';
import type { BaseItem } from '../../shared/models';
import { sessionFor } from './stores.svelte';

type ImageType = 'Primary' | 'Backdrop' | 'Thumb' | 'Logo' | 'Banner' | 'Chapter';

// Device pixel ratio rounded to half steps so the server's resized-image cache
// is reused across windows on mixed-DPI monitors.
function dpr(): number {
  return Math.min(3, Math.ceil(devicePixelRatio * 2) / 2);
}

// Item, user and server ids are path segments of wicaby-media://api URLs: anything
// but a plain id (a '/', '..', an encoded character) could reach another API path.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// File source ids too (shared/files/ids.ts): 'p.' + base64url, never a dot segment.
export const validId = (id: unknown): id is string => typeof id === 'string' && (ID.test(id) || isFilesId(id));

// Where server image paths are served from: wicaby-media://api[/serverId] on the desktop (main adds the auth);
// apps/webtv sets the server's own address. serverId absent: the primary server.
let base = (serverId?: string): string => `${MEDIA_SCHEME}://api${serverId ? `/${serverId}` : ''}`;
export const mediaBase = (serverId?: string): string => base(serverId);
export function setMediaBase(fn: (serverId?: string) => string): void {
  base = fn;
}

// opts.server: the item's server (BaseItem.ServerId); the primary one when absent.
// '' (no image) when an id is not a plain id. opts.px: a square box in device pixels (music art, already bucketed).
export function imageUrl(itemId: string, type: ImageType, opts: { tag?: string; maxWidth?: number; maxHeight?: number; px?: number; index?: number; server?: string } = {}): string {
  if (!validId(itemId) || (opts.server && !validId(opts.server))) return '';
  if (opts.index !== undefined && !(Number.isInteger(opts.index) && opts.index >= 0)) return '';
  const q = new URLSearchParams({ quality: '90' });
  if (opts.tag) q.set('tag', opts.tag);
  if (opts.maxWidth) q.set('maxWidth', String(Math.round(opts.maxWidth * dpr())));
  if (opts.maxHeight) q.set('maxHeight', String(Math.round(opts.maxHeight * dpr())));
  if (opts.px) {
    q.set('maxWidth', String(opts.px));
    q.set('maxHeight', String(opts.px));
  }
  const idx = opts.index !== undefined ? `/${opts.index}` : '';
  return `${mediaBase(opts.server)}/Items/${itemId}/Images/${type}${idx}?${q}`;
}

// A photo or clip's Primary image (photos spec §3.1): grid thumbnails by height bucket, the viewer by viewport.
// Emby turns the pixels upright with AutoOrient; Jellyfin has no such parameter (the client rotates, asset.ts).
export function photoUrl(a: { id: string; serverId?: string; thumbTag?: string }, size: { maxWidth?: number; maxHeight?: number }): string {
  if (a.serverId?.startsWith('immich:')) {
    // Immich sizes: thumbnail (about 250 px, the grid), preview (about 1440 px), fullsize (zoom past ×2).
    // shortcut: a tile up to 400 device px takes the 250 px thumbnail (slightly soft on large hi-DPI tiles).
    const px = Math.max(size.maxWidth ?? 0, size.maxHeight ?? 0) * devicePixelRatio;
    const kind = (size.maxWidth ?? 0) >= 4096 ? 'fullsize' : px > 0 && px <= 400 ? 'thumbnail' : 'preview';
    return immichUrl(a.serverId.slice(7), `assets/${a.id}/thumbnail`, kind);
  }
  const server = a.serverId || undefined;
  const url = imageUrl(a.id, 'Primary', { tag: a.thumbTag, server, ...size });
  return url && sessionFor(server)?.server.kind !== 'jellyfin' ? `${url}&AutoOrient=true` : url;
}

// An Immich source's picture or clip (photos spec PH-12), through main, which adds the key: rel is
// assets/<uuid>/thumbnail|original|video/playback or people/<uuid>/thumbnail. '' when an id is not plain.
const IMMICH_SOURCE = /^[0-9a-f]{12}$/;
const IMMICH_REL = /^(?:assets\/[0-9a-f-]{36}\/(?:thumbnail|original|video\/playback)|people\/[0-9a-f-]{36}\/thumbnail)$/;
export function immichUrl(source: string, rel: string, size?: 'thumbnail' | 'preview' | 'fullsize'): string {
  if (!IMMICH_SOURCE.test(source) || !IMMICH_REL.test(rel)) return '';
  return `${MEDIA_SCHEME}://immich/${source}/${rel}${size ? `?size=${size}` : ''}`;
}

// Emby: /Users/{id}/Images/Primary. Jellyfin 10.9+ moved avatars to /UserImage?userId=
// (the per-user route is obsolete and hidden from its API spec).
export function userImageUrl(userId: string, tag?: string, size = 96, serverId?: string): string {
  if (!validId(userId) || (serverId && !validId(serverId))) return '';
  const q = new URLSearchParams({ quality: '90', maxHeight: String(size * 2) });
  if (tag) q.set('tag', tag);
  const base = mediaBase(serverId);
  if (sessionFor(serverId)?.server.kind === 'jellyfin') {
    q.set('userId', userId);
    return `${base}/UserImage?${q}`;
  }
  return `${base}/Users/${userId}/Images/Primary?${q}`;
}

export function posterUrl(item: BaseItem, maxHeight = 360): string | null {
  const server = item.ServerId;
  if (item.ImageTags?.Primary) return imageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxHeight, server }) || null;
  if (item.SeriesId && item.SeriesPrimaryImageTag) return imageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxHeight, server }) || null;
  // A track without art of its own: its album's (music spec MU-A1).
  if (item.AlbumId && item.AlbumPrimaryImageTag) return imageUrl(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxHeight, server }) || null;
  return comicCoverUrl(item);
}

// A comic without a server cover: its first page, generated and cached in main (one size for every card).
export function comicCoverUrl(item: BaseItem, full = false): string | null {
  const v = comicCoverVersion(item);
  if (v === null || !validId(item.Id) || (item.ServerId && !validId(item.ServerId))) return null;
  const q = new URLSearchParams({ v });
  if (full) q.set('full', '1');
  return `${MEDIA_SCHEME}://comic-cover/${item.ServerId ? `${item.ServerId}/` : ''}${item.Id}?${q}`;
}

// 16:9 still: episode image, thumb, then backdrop.
export function thumbUrl(item: BaseItem, maxWidth = 480): string | null {
  const server = item.ServerId;
  if (item.Type === 'Episode' && item.ImageTags?.Primary) return imageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth, server }) || null;
  if (item.ImageTags?.Thumb) return imageUrl(item.Id, 'Thumb', { tag: item.ImageTags.Thumb, maxWidth, server }) || null;
  if (item.ParentThumbItemId && item.ParentThumbImageTag) return imageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth, server }) || null;
  return backdropUrl(item, maxWidth);
}

export function backdropUrl(item: BaseItem, maxWidth = 1920): string | null {
  const server = item.ServerId;
  if (item.BackdropImageTags?.length) return imageUrl(item.Id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth, server }) || null;
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length)
    return imageUrl(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth, server }) || null;
  return null;
}

export function logoUrl(item: BaseItem, maxWidth = 640): string | null {
  const server = item.ServerId;
  if (item.ImageTags?.Logo) return imageUrl(item.Id, 'Logo', { tag: item.ImageTags.Logo, maxWidth, server }) || null;
  if (item.ParentLogoItemId && item.ParentLogoImageTag) return imageUrl(item.ParentLogoItemId, 'Logo', { tag: item.ParentLogoImageTag, maxWidth, server }) || null;
  return null;
}

export function offlinePosterUrl(downloadId: string): string {
  return `${MEDIA_SCHEME}://poster/${encodeURIComponent(downloadId)}`;
}
