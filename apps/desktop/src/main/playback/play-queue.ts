// The play queue of the playback service: item ids of one server, the position in it, the
// trailers among them and cinema mode's held-back film.
import type { BaseItem } from '../../shared/models';
import { applyQueueOp, type QueueOp, type QueueState, type Repeat } from '../../shared/music-queue';
import type { ApiClient } from '../connection/api-client';
import { userItem, userItemExtras } from '../connection/user-routes';
import { validId, type StartOptions } from './playback-model';

export class PlayQueue {
  ids: string[] = [];
  // Every id in the queue belongs to this server.
  serverId: string | undefined;
  index = 0;
  // Queue entries that are trailers (trailer button, cinema mode): never reported to the server.
  trailers = new Set<string>();
  // Cinema mode: the film's own start options, held back while its trailers play.
  deferred: { index: number; opts: StartOptions } | null = null;
  // Music (shared/music-queue.ts): repeat mode, kept across queues, and the order before shuffle.
  repeat: Repeat = 'off';
  unshuffled: string[] | null = null;

  get qs(): QueueState {
    return { ids: this.ids, index: this.index, repeat: this.repeat, unshuffled: this.unshuffled };
  }

  // A music queue operation (move, remove, shuffle…), shared with Android's core music/MusicQueue.kt.
  apply(op: QueueOp): void {
    ({ ids: this.ids, index: this.index, repeat: this.repeat, unshuffled: this.unshuffled } = applyQueueOp(this.qs, op));
  }

  get id(): string {
    return this.ids[this.index];
  }

  get nextId(): string {
    return this.ids[this.index + 1];
  }

  get hasNext(): boolean {
    return this.index + 1 < this.ids.length;
  }

  // Play next / add to queue.
  add(command: 'PlayNext' | 'PlayLast', ids: string[]): void {
    // After the film cinema-mode trailers are leading up to, not between them.
    if (command === 'PlayNext' && this.deferred) this.ids.splice(Math.max(this.index, this.deferred.index) + 1, 0, ...ids);
    else this.apply({ op: command === 'PlayNext' ? 'insertNext' : 'append', ids });
  }

  reset(ids: string[], serverId: string | undefined, startIndex: number, trailer: boolean): void {
    this.ids = ids;
    this.serverId = serverId;
    this.index = Math.min(Math.max(0, startIndex), ids.length - 1);
    this.trailers = new Set(trailer ? ids : []);
    this.deferred = null;
    this.unshuffled = null;
  }

  // Cinema mode: the trailers go before the current film, which waits with its start options.
  addIntros(intros: string[], opts: StartOptions): void {
    this.ids.splice(this.index, 0, ...intros);
    for (const id of intros) this.trailers.add(id);
    this.deferred = { index: this.index + intros.length, opts };
  }

  // The held-back start options when the queue reaches the film.
  takeDeferred(): StartOptions | null {
    const deferred = this.deferred?.index === this.index ? this.deferred.opts : null;
    if (deferred) this.deferred = null;
    return deferred;
  }
}

// The server's intros (Emby cinema mode, Jellyfin intro plugins), else the first local
// trailer of up to two unwatched similar films. Films only.
export async function cinemaTrailers(api: ApiClient | null, itemId: string): Promise<string[]> {
  const userId = api?.userId;
  if (!api || !userId) return [];
  const item = await userItem<BaseItem>(api, userId, itemId);
  if (item.Type !== 'Movie') return [];
  const intros = await userItemExtras<{ Items?: BaseItem[] }>(api, userId, itemId, 'Intros').catch(() => null);
  const ids = (intros?.Items ?? []).map((i) => i.Id).filter(validId).slice(0, 2);
  if (ids.length) return ids;
  const similar = await api.get<{ Items?: BaseItem[] }>(`/Items/${itemId}/Similar`, { UserId: userId, Limit: 12, Fields: 'LocalTrailerCount' });
  for (const s of similar?.Items ?? []) {
    if (ids.length >= 2) break;
    if (s.UserData?.Played || !s.LocalTrailerCount || !validId(s.Id)) continue;
    const local = await userItemExtras<BaseItem[]>(api, userId, s.Id, 'LocalTrailers').catch(() => []);
    if (validId(local?.[0]?.Id)) ids.push(local[0].Id);
  }
  return ids;
}
