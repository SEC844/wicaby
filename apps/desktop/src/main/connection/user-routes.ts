import type { Query } from '../../shared/contract';
import type { ApiClient } from './api-client';

// Jellyfin 10.9+ removed the /Users/{id}/Items… routes from its API (still served, marked
// obsolete) in favour of userId-as-query routes; Emby only has the per-user ones.

export function userItems<T>(api: ApiClient, userId: string, query: Query = {}): Promise<T> {
  return api.kind === 'jellyfin' ? api.get<T>('/Items', { ...query, userId }) : api.get<T>(`/Users/${userId}/Items`, query);
}

export function userItem<T>(api: ApiClient, userId: string, itemId: string): Promise<T> {
  return api.kind === 'jellyfin' ? api.get<T>(`/Items/${itemId}`, { userId }) : api.get<T>(`/Users/${userId}/Items/${itemId}`);
}

// An item's LocalTrailers (an array) or Intros (a query result).
export function userItemExtras<T>(api: ApiClient, userId: string, itemId: string, kind: 'LocalTrailers' | 'Intros'): Promise<T> {
  return api.kind === 'jellyfin' ? api.get<T>(`/Items/${itemId}/${kind}`, { userId }) : api.get<T>(`/Users/${userId}/Items/${itemId}/${kind}`);
}

export function postUserData(api: ApiClient, userId: string, itemId: string, body: unknown): Promise<unknown> {
  return api.kind === 'jellyfin'
    ? api.post(`/UserItems/${itemId}/UserData`, { userId }, body)
    : api.post(`/Users/${userId}/Items/${itemId}/UserData`, undefined, body);
}

export function userResume<T>(api: ApiClient, userId: string, query: Query = {}): Promise<T> {
  return api.kind === 'jellyfin' ? api.get<T>('/UserItems/Resume', { ...query, userId }) : api.get<T>(`/Users/${userId}/Items/Resume`, query);
}

export function markPlayed(api: ApiClient, userId: string, itemId: string): Promise<unknown> {
  return api.kind === 'jellyfin' ? api.post(`/UserPlayedItems/${itemId}`, { userId }) : api.post(`/Users/${userId}/PlayedItems/${itemId}`);
}
