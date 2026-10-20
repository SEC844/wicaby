// X-05: the player's speed and picture format remembered at the scope set in Settings > Playback ("Remember
// settings"), with the desktop's pure rules and JSON (main/playback/scoped-prefs.ts, as core ScopedPrefs.kt):
// only the configured scope is read, then the global value. Stored on the TV.
import type { BaseItem } from '$shared/models';
import type { RememberScope } from '$shared/contract';
import { readScoped, writeScoped, type ScopeCtx, type ScopesDoc } from '../../../desktop/src/main/playback/scoped-prefs';
import type { Api } from './api';
import { settings } from './settings.svelte';
import { load, save } from './storage';

export type { ScopeCtx };

const KEY = 'player_scopes';
const SCOPES: RememberScope[] = ['off', 'global', 'library', 'title'];
type Prop = 'speed' | 'aspect';

const scope = (prop: Prop): RememberScope => SCOPES[(prop === 'speed' ? settings.rememberSpeed : settings.rememberAspect).value] ?? 'off';

// Libraries looked up this session (the item's CollectionFolder), by title key.
const libraries = new Map<string, string>();

// title: "serverId:SeriesId ?? Id"; library: "serverId:library view id" (looked up only when a scope needs it).
export async function scopeCtx(api: Api, item: BaseItem): Promise<ScopeCtx> {
  const server = api.serverId ?? '';
  const title = `${server}:${item.SeriesId ?? item.Id}`;
  if (scope('speed') !== 'library' && scope('aspect') !== 'library') return { title };
  let lib = libraries.get(title);
  if (lib === undefined) {
    const ancestors = await api.get<BaseItem[]>(`/Items/${item.Id}/Ancestors`, { UserId: api.userId }).catch(() => null);
    // A failed lookup is retried next time.
    if (ancestors) libraries.set(title, (lib = ancestors.find((a) => a.Type === 'CollectionFolder')?.Id ?? ''));
  }
  return { title, library: lib ? `${server}:${lib}` : undefined };
}

export function recall(prop: Prop, ctx: ScopeCtx | null): unknown {
  return ctx ? readScoped(load<ScopesDoc>(KEY, {}), prop, scope(prop), ctx) : undefined;
}

export function remember(prop: Prop, ctx: ScopeCtx | null, value: unknown): void {
  if (ctx) save(KEY, writeScoped(load<ScopesDoc>(KEY, {}), prop, scope(prop), ctx, value));
}

export function clearRemembered(): void {
  save(KEY, {});
}
