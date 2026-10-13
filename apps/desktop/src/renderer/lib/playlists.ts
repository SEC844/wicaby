// Playlists and collections (BoxSets). Emby and Jellyfin share the query API;
// Jellyfin also reads the playlist create call from a JSON body, so both go.
// Playlists live on one server: every call names it (the item's or the playlist's).
import type { BaseItem, ItemsResult } from '../../shared/models';
import { apiFor, cachedGet, invalidateApiCache, LIST_FIELDS } from './api';
import { w } from './bridge';
import { sessionFor } from './stores.svelte';

export type Kind = 'playlist' | 'collection';

export interface PlaylistEntry extends BaseItem {
  PlaylistItemId?: string;
}

const uid = (serverId?: string) => sessionFor(serverId)?.user?.id ?? '';

// Playlists hold one media type; music goes to audio playlists.
export function mediaTypeOf(item: BaseItem): 'Audio' | 'Video' {
  return ['Audio', 'MusicAlbum', 'MusicArtist'].includes(item.Type) || item.MediaType === 'Audio' ? 'Audio' : 'Video';
}

export function list(kind: Kind, serverId?: string) {
  return apiFor(serverId).items({ IncludeItemTypes: kind === 'playlist' ? 'Playlist' : 'BoxSet', Recursive: true, SortBy: 'SortName' });
}

export function entries(playlistId: string, serverId?: string) {
  return cachedGet<ItemsResult & { Items: PlaylistEntry[] }>(
    `/Playlists/${playlistId}/Items`,
    {
      UserId: uid(serverId),
      Fields: LIST_FIELDS,
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      ImageTypeLimit: 1,
    },
    serverId,
  );
}

export async function create(kind: Kind, name: string, item: BaseItem): Promise<string | undefined> {
  const sid = item.ServerId;
  const res =
    kind === 'playlist'
      ? await w.api.post<{ Id?: string }>(
          '/Playlists',
          { Name: name, Ids: item.Id, UserId: uid(sid), MediaType: mediaTypeOf(item) },
          { Name: name, Ids: [item.Id], UserId: uid(sid), MediaType: mediaTypeOf(item) },
          sid,
        )
      : await w.api.post<{ Id?: string }>('/Collections', { Name: name, Ids: item.Id }, undefined, sid);
  invalidateApiCache();
  return res?.Id;
}

export async function addTo(kind: Kind, targetId: string, item: BaseItem): Promise<void> {
  const sid = item.ServerId;
  if (kind === 'playlist') await w.api.post(`/Playlists/${targetId}/Items`, { Ids: item.Id, UserId: uid(sid) }, undefined, sid);
  else await w.api.post(`/Collections/${targetId}/Items`, { Ids: item.Id }, undefined, sid);
  invalidateApiCache();
}

export async function remove(playlistId: string, entryId: string, serverId?: string): Promise<void> {
  await w.api.del(`/Playlists/${playlistId}/Items`, { EntryIds: entryId }, serverId);
  invalidateApiCache();
}

export async function move(playlistId: string, entryId: string, newIndex: number, serverId?: string): Promise<void> {
  await w.api.post(`/Playlists/${playlistId}/Items/${entryId}/Move/${newIndex}`, undefined, undefined, serverId);
  invalidateApiCache();
}
