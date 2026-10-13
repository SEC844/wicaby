// Music calls of the renderer (music-spec MU-01, §3): the Emby / Jellyfin differences in one place. Paths and
// queries only; the views (MU-03 on) decide what to show. Core's music/MusicApi.kt is the Android twin.
import type { Query } from '../../shared/contract';
import type { BaseItem, ItemsResult } from '../../shared/models';
import { lyricsFromJellyfin, parseLrc, type Lyrics } from '../../shared/music';
import { apiFor, cachedGet, invalidateApiCache, LIST_FIELDS } from './api';
import { w } from './bridge';
import { sessionFor } from './stores.svelte';

export { move as playlistMove, remove as playlistRemove } from './playlists';

const jellyfin = (sid?: string) => sessionFor(sid)?.server.kind === 'jellyfin';
const userQuery = (sid?: string): Query => {
  const id = sessionFor(sid)?.user?.id ?? '';
  return jellyfin(sid) ? { userId: id } : { UserId: id };
};

export const albums = (parentId: string, query: Query = {}, sid?: string) =>
  apiFor(sid).items({ ParentId: parentId, IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'SortName', ...query });

export const songs = (parentId: string, query: Query = {}, sid?: string) =>
  apiFor(sid).items({ ParentId: parentId, IncludeItemTypes: 'Audio', Recursive: true, SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName', ...query });

// Album artists (whom albums are filed under) or every artist credited on a track (spec §3.2). Jellyfin 12 marks
// /Artists* obsolete in favour of /Persons: this is the one place to switch.
export const artists = (parentId: string, albumArtistsOnly: boolean, query: Query = {}, sid?: string) =>
  cachedGet<ItemsResult>(albumArtistsOnly ? '/Artists/AlbumArtists' : '/Artists', { ParentId: parentId, SortBy: 'SortName', Fields: LIST_FIELDS, ...userQuery(sid), ...query }, sid);

// Emby /MusicGenres; Jellyfin /Genres?IncludeItemTypes=MusicAlbum (its /MusicGenres is deprecated since 10.8).
export const genres = (parentId: string, sid?: string) =>
  cachedGet<ItemsResult>(jellyfin(sid) ? '/Genres' : '/MusicGenres', { ParentId: parentId, SortBy: 'SortName', ...(jellyfin(sid) ? { IncludeItemTypes: 'MusicAlbum' } : {}), ...userQuery(sid) }, sid);

// The album years of a library (/Years, both servers): the decades of the Years filter (MU-03).
export const years = (parentId: string, sid?: string) =>
  cachedGet<ItemsResult>('/Years', { ParentId: parentId, Recursive: true, IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName', SortOrder: 'Descending', ...userQuery(sid) }, sid);

// One route for tracks, albums, artists, genres and playlists on both servers (spec §3.3).
export const instantMix = (id: string, limit = 100, sid?: string) => w.api.get<ItemsResult>(`/Items/${id}/InstantMix`, { ...userQuery(sid), Limit: limit, Fields: LIST_FIELDS }, sid);

// Server lyrics (spec §3.5). Jellyfin 10.9+: /Audio/{id}/Lyrics when HasLyrics. Emby has no lyrics route: an
// external lrc / text subtitle stream on the audio item, fetched as Stream.lrc then Stream.txt. That Emby shape is
// UNVERIFIED (one real Emby 4.8/4.9 observation pending): any failure reads as "no lyrics", never an error.
export async function lyrics(item: BaseItem, sid?: string): Promise<Lyrics | null> {
  try {
    // An isEmby server has no lyrics route: Jellyfin only on the next line (continue-check's route guard).
    if (jellyfin(sid)) return item.HasLyrics === false ? null : lyricsFromJellyfin(await w.api.get(`/Audio/${item.Id}/Lyrics`, undefined, sid)); // never isEmby
    const source = item.MediaSources?.[0];
    const stream = (source?.MediaStreams ?? item.MediaStreams ?? []).find((s) => s.Type === 'Subtitle' && /^(lrc|text|txt)$/i.test(s.Codec ?? ''));
    if (!stream) return null;
    const base = `/Videos/${item.Id}/${source?.Id ?? item.Id}/Subtitles/${stream.Index}/Stream`;
    const text = await w.api.get<string>(`${base}.lrc`, undefined, sid).catch(() => w.api.get<string>(`${base}.txt`, undefined, sid));
    const parsed = typeof text === 'string' ? parseLrc(text) : null;
    return parsed?.lines.length ? parsed : null;
  } catch {
    return null;
  }
}

// "Enregistrer comme playlist": an audio playlist of the queue, in its order (both create forms, as playlists.ts).
export async function saveQueueAsPlaylist(name: string, ids: string[], sid?: string): Promise<string | undefined> {
  const uid = sessionFor(sid)?.user?.id ?? '';
  const res = await w.api.post<{ Id?: string }>('/Playlists', { Name: name, Ids: ids.join(','), UserId: uid, MediaType: 'Audio' }, { Name: name, Ids: ids, UserId: uid, MediaType: 'Audio' }, sid);
  invalidateApiCache();
  return res?.Id;
}
