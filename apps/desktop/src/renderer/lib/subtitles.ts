// X-03 remote subtitle calls, shared by the player's search sheet and the admin metadata editor
// (admin/item/metadata.ts re-exports them). Same routes on Emby and Jellyfin; MediaSourceId is
// sent when known but not a declared parameter on either server, so nothing relies on it.
import type { MediaSource } from '../../shared/models';
import type { RemoteSubtitle } from '../../shared/subtitles';
import { w } from './bridge';

export type { RemoteSubtitle };

type ItemRef = { Id: string; ServerId?: string };

export function searchSubtitles(item: ItemRef, language: string, source?: Pick<MediaSource, 'Id'>): Promise<RemoteSubtitle[]> {
  return w.api.get<RemoteSubtitle[]>(`/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(language)}`, { MediaSourceId: source?.Id }, item.ServerId);
}

export async function downloadSubtitle(item: ItemRef, sub: Pick<RemoteSubtitle, 'Id'>, source?: Pick<MediaSource, 'Id'>): Promise<void> {
  await w.api.post(`/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(sub.Id)}`, { MediaSourceId: source?.Id }, undefined, item.ServerId);
}
