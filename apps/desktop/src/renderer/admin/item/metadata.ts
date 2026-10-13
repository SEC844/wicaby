// Item metadata administration (admins of the item's server only): editable item,
// identify, artwork, refresh, remote subtitles and deletion. Same endpoints on
// Emby and Jellyfin unless noted; every call goes to the item's own server.
import { MEDIA_SCHEME } from '../../../shared/contract';
import type { BaseItem, MediaSource } from '../../../shared/models';
import { invalidateApiCache } from '../../lib/api';
import { comicCoverUrl } from '../../lib/images';
import { w } from '../../lib/bridge';
import { t } from '../../lib/i18n.svelte';
import { dataVersion, sessionFor } from '../../lib/stores.svelte';
import type { IconName } from '../../components/Icon.svelte';
import { downloadSubtitle as download, type RemoteSubtitle } from '../../lib/subtitles';

export type AdminAction = 'edit' | 'identify' | 'images' | 'refresh' | 'subtitles' | 'comicCover' | 'delete';

export interface NameId {
  Name: string;
  Id?: string | number;
}

export interface Person {
  Name: string;
  Id?: string;
  Role?: string;
  Type?: string;
  PrimaryImageTag?: string;
}

// The editable DTO: BaseItem plus the fields only the editor reads. Everything
// else the server sent is kept as is and posted back (POST /Items/{id} replaces).
export interface EditableItem extends Omit<BaseItem, 'People' | 'Studios'> {
  OriginalTitle?: string;
  SortName?: string;
  ForcedSortName?: string;
  Tags?: string[];
  TagItems?: NameId[];
  GenreItems?: NameId[];
  Studios?: NameId[];
  People?: Person[];
  AirDays?: string[];
  AirTime?: string;
  LockData?: boolean;
  LockedFields?: string[];
  CanDelete?: boolean;
  [key: string]: unknown;
}

export interface MetadataEditorInfo {
  ParentalRatingOptions?: { Name: string; Value?: number }[];
  ExternalIdInfos?: { Name: string; Key: string; UrlFormatString?: string; Type?: string }[];
}

export interface RemoteSearchResult {
  Name: string;
  ProviderIds?: Record<string, string>;
  ProductionYear?: number;
  PremiereDate?: string;
  ImageUrl?: string;
  SearchProviderName?: string;
  Overview?: string;
  [key: string]: unknown;
}

export interface ImageInfo {
  ImageType: string;
  ImageIndex?: number;
  ImageTag?: string;
  Width?: number;
  Height?: number;
  Size?: number;
}

export interface RemoteImage {
  ProviderName?: string;
  Url: string;
  ThumbnailUrl?: string;
  Width?: number;
  Height?: number;
  CommunityRating?: number;
  VoteCount?: number;
  Language?: string;
  Type: string;
}

export type { RemoteSubtitle } from '../../lib/subtitles';

export interface Culture {
  DisplayName: string;
  Name?: string;
  ThreeLetterISOLanguageName?: string;
  TwoLetterISOLanguageName?: string;
}

export const IMAGE_TYPES = ['Primary', 'Backdrop', 'Logo', 'Thumb', 'Banner', 'Art', 'Disc'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const UPLOAD_MAX = 20 * 1024 * 1024;

// MetadataField(s) values each server accepts in LockedFields: an unknown value
// fails the whole save, so Jellyfin only gets its nine.
const LOCKS_JELLYFIN = ['Name', 'Overview', 'OfficialRating', 'Genres', 'Studios', 'Tags', 'Cast'];
const LOCKS_EMBY = [...LOCKS_JELLYFIN, 'OriginalTitle', 'SortName', 'Tagline', 'CommunityRating', 'CriticRating'];

const IDENTIFIABLE = ['Movie', 'Series', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'Person', 'Book', 'MusicVideo', 'Trailer'];
const SUBTITLED = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'];

export const isJellyfin = (serverId?: string) => sessionFor(serverId)?.server.kind === 'jellyfin';

export function lockableFields(serverId?: string): string[] {
  return isJellyfin(serverId) ? LOCKS_JELLYFIN : LOCKS_EMBY;
}

export function isAdminFor(item: Pick<BaseItem, 'ServerId'>): boolean {
  return sessionFor(item.ServerId)?.user?.isAdmin === true;
}

// The admin entries of the item page's "…" menu; [] for everyone else.
export function adminEntries(item: BaseItem & { CanDelete?: boolean }): { kind: AdminAction; icon: IconName }[] {
  if (!isAdminFor(item) || item.Type === 'CollectionFolder' || item.Type === 'UserView') return [];
  const out: { kind: AdminAction; icon: IconName }[] = [{ kind: 'edit', icon: 'pencil' }];
  if (IDENTIFIABLE.includes(item.Type)) out.push({ kind: 'identify', icon: 'scanSearch' });
  out.push({ kind: 'images', icon: 'image' }, { kind: 'refresh', icon: 'refresh' });
  if (SUBTITLED.includes(item.Type) && item.MediaType === 'Video') out.push({ kind: 'subtitles', icon: 'subtitles' });
  if (comicCoverUrl(item)) out.push({ kind: 'comicCover', icon: 'book' });
  if (item.CanDelete) out.push({ kind: 'delete', icon: 'trash' });
  return out;
}

// After any change: drop the cached GETs and let the item page (and rows) reload.
export function notifyChanged(): void {
  invalidateApiCache();
  dataVersion.userData++;
}

// Changes the server applies in the background (identify, refresh, downloads): reload
// now and once more when it has probably finished.
export function notifyChangedSoon(): void {
  notifyChanged();
  setTimeout(notifyChanged, 4000);
}

const EDIT_FIELDS =
  'Overview,Genres,Studios,Tags,TagItems,GenreItems,People,ProviderIds,Taglines,OriginalTitle,SortName,ForcedSortName,PremiereDate,EndDate,ProductionYear,OfficialRating,CommunityRating,CriticRating,Status,AirDays,AirTime,LockData,LockedFields,DateCreated,MediaSources,CanDelete';

// Fresh (uncached) copy of the item as the server stores it.
export function editableItem(item: BaseItem): Promise<EditableItem> {
  const sid = item.ServerId;
  const uid = sessionFor(sid)?.user?.id;
  if (!uid) return Promise.reject(new Error(t('errors.connection.notSignedIn')));
  return isJellyfin(sid)
    ? w.api.get<EditableItem>(`/Items/${item.Id}`, { userId: uid, Fields: EDIT_FIELDS }, sid)
    : w.api.get<EditableItem>(`/Users/${uid}/Items/${item.Id}`, { Fields: EDIT_FIELDS }, sid);
}

export function editorInfo(item: BaseItem): Promise<MetadataEditorInfo> {
  return w.api.get<MetadataEditorInfo>(`/Items/${item.Id}/MetadataEditor`, undefined, item.ServerId).catch(() => ({}));
}

export async function saveItem(item: BaseItem, dto: EditableItem): Promise<void> {
  await w.api.post(`/Items/${item.Id}`, undefined, dto, item.ServerId);
  notifyChanged();
}

// Identify (POST /Items/RemoteSearch/<Type>, then …/Apply/{id}).
export function remoteSearch(item: BaseItem, info: { Name?: string; Year?: number; ProviderIds?: Record<string, string> }): Promise<RemoteSearchResult[]> {
  return w.api.post<RemoteSearchResult[]>(
    `/Items/RemoteSearch/${item.Type}`,
    undefined,
    { SearchInfo: info, ItemId: item.Id, IncludeDisabledProviders: true },
    item.ServerId,
  );
}

export async function applyRemote(item: BaseItem, result: RemoteSearchResult, replaceAllImages: boolean): Promise<void> {
  await w.api.post(`/Items/RemoteSearch/Apply/${item.Id}`, { ReplaceAllImages: replaceAllImages }, result, item.ServerId);
  notifyChangedSoon();
}

// Artwork.
export function itemImages(item: BaseItem): Promise<ImageInfo[]> {
  return w.api.get<ImageInfo[]>(`/Items/${item.Id}/Images`, undefined, item.ServerId);
}

export function imageSrc(item: BaseItem, img: ImageInfo, maxWidth: number): string {
  const q = new URLSearchParams({ quality: '90', maxWidth: String(Math.round(maxWidth * Math.min(2, devicePixelRatio))) });
  if (img.ImageTag) q.set('tag', img.ImageTag);
  const idx = img.ImageType === 'Backdrop' || img.ImageType === 'Screenshot' ? `/${img.ImageIndex ?? 0}` : '';
  const server = item.ServerId ? `/${item.ServerId}` : '';
  return `${MEDIA_SCHEME}://api${server}/Items/${item.Id}/Images/${img.ImageType}${idx}?${q}`;
}

// Provider artwork goes through main (wicaby-media://remote-image), the CSP keeps the web out.
// Inline data:image URLs (the dev mock's artwork) need no proxy.
export function remoteSrc(url: string | undefined): string | null {
  if (url?.startsWith('data:image/')) return url;
  return url && /^https?:\/\//i.test(url) ? `${MEDIA_SCHEME}://remote-image/?u=${encodeURIComponent(url)}` : null;
}

export async function deleteImage(item: BaseItem, img: ImageInfo): Promise<void> {
  await w.api.del(`/Items/${item.Id}/Images/${img.ImageType}/${img.ImageIndex ?? 0}`, undefined, item.ServerId);
  notifyChanged();
}

export async function moveBackdrop(item: BaseItem, index: number, newIndex: number): Promise<void> {
  await w.api.post(`/Items/${item.Id}/Images/Backdrop/${index}/Index`, { NewIndex: newIndex }, undefined, item.ServerId);
  notifyChanged();
}

export async function uploadImage(item: BaseItem, type: ImageType, file: File): Promise<void> {
  const data = new Uint8Array(await file.arrayBuffer());
  await w.api.uploadImage(item.Id, type, file.type, data, item.ServerId);
  notifyChanged();
}

// "Use the first page as the server cover": the generated cover, at full size, uploaded as the
// item's Primary image so every client gets it. Only ever run from that menu entry.
export async function comicCoverToServer(item: BaseItem): Promise<void> {
  const url = comicCoverUrl(item, true);
  const res = url ? await fetch(url) : null;
  if (!res?.ok) throw new Error(t('adminMetadata.comicCover.failed'));
  const blob = await res.blob();
  await w.api.uploadImage(item.Id, 'Primary', blob.type, new Uint8Array(await blob.arrayBuffer()), item.ServerId);
  notifyChanged();
}

export function remoteImages(
  item: BaseItem,
  q: { type: string; provider: string; allLanguages: boolean },
): Promise<{ Images: RemoteImage[]; TotalRecordCount: number; Providers?: string[] }> {
  return w.api.get(
    `/Items/${item.Id}/RemoteImages`,
    { Type: q.type, ProviderName: q.provider || undefined, IncludeAllLanguages: q.allLanguages, StartIndex: 0, Limit: 120 },
    item.ServerId,
  );
}

export function remoteImageProviders(item: BaseItem): Promise<{ Name: string; SupportedImages?: string[] }[]> {
  return w.api.get<{ Name: string; SupportedImages?: string[] }[]>(`/Items/${item.Id}/RemoteImages/Providers`, undefined, item.ServerId).catch(() => []);
}

export async function downloadRemoteImage(item: BaseItem, img: RemoteImage): Promise<void> {
  await w.api.post(
    `/Items/${item.Id}/RemoteImages/Download`,
    { Type: img.Type, ImageUrl: img.Url, ProviderName: img.ProviderName },
    undefined,
    item.ServerId,
  );
  notifyChanged();
}

// Refresh. missing = fill the gaps; all = replace every field.
export async function refreshItem(item: BaseItem, opts: { mode: 'missing' | 'all'; replaceImages: boolean; recursive: boolean }): Promise<void> {
  await w.api.post(
    `/Items/${item.Id}/Refresh`,
    {
      Recursive: opts.recursive,
      MetadataRefreshMode: 'FullRefresh',
      ImageRefreshMode: 'FullRefresh',
      ReplaceAllMetadata: opts.mode === 'all',
      ReplaceAllImages: opts.replaceImages,
    },
    undefined,
    item.ServerId,
  );
  notifyChangedSoon();
}

// Remote subtitles (calls in lib/subtitles.ts, shared with the player's search sheet).
export function cultures(serverId?: string): Promise<Culture[]> {
  return w.api.get<Culture[]>('/Localization/Cultures', undefined, serverId).catch(() => []);
}

export { searchSubtitles } from '../../lib/subtitles';

export async function downloadSubtitle(item: BaseItem, sub: RemoteSubtitle, source?: MediaSource): Promise<void> {
  await download(item, sub, source);
  notifyChangedSoon();
}

// Deletes the item and its media files on the server.
export async function deleteItem(item: BaseItem): Promise<void> {
  await w.api.del(`/Items/${item.Id}`, undefined, item.ServerId);
  notifyChanged();
}

// Name lists that keep the server's ids for names that did not change (Emby
// NameLongIdPair / Jellyfin NameGuidPair).
export function namePairs(names: string[], before: NameId[] | undefined): NameId[] {
  const ids = new Map((before ?? []).map((p) => [p.Name.toLowerCase(), p.Id]));
  return names.map((Name) => {
    const Id = ids.get(Name.toLowerCase());
    return Id !== undefined ? { Name, Id } : { Name };
  });
}

// yyyy-mm-dd for <input type="date">, and back to the ISO midnight UTC the servers store.
export const toDateInput = (iso?: string): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');
export const fromDateInput = (d: string): string | undefined => (d ? `${d}T00:00:00.000Z` : undefined);
