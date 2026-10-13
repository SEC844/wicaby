// What the player remembers between items: X-05 speed, delays and aspect at the scope set in
// Réglages (scoped-prefs.ts), manual audio/subtitle picks per series (track-selection.ts) and the
// X-02 version picked per series.
import { join } from 'node:path';
import { app } from 'electron';
import type { BaseItem, MediaStream } from '../../shared/models';
import { JsonStore } from '../core/json-store';
import type { Current, PlaybackDeps } from './playback-model';
import { readScoped, writeScoped, type ScopeCtx, type ScopedProp, type ScopesDoc } from './scoped-prefs';
import { rememberChoice, type TrackMemoryDoc } from './track-selection';

export class PlayerMemory {
  // X-05: speed, delays and aspect at the scope set in Réglages (scoped-prefs.ts), and the current item's keys.
  private scopes = new JsonStore<ScopesDoc>(join(app.getPath('userData'), 'player-scopes.json'), {});
  scopeCtx: ScopeCtx = { global: true };
  // `${serverId}:${SeriesId ?? Id}` -> library view id ('' = none found), for the "Per library" scope.
  private libraries = new Map<string, string>();
  // Series whose "tracks from the previous episode" toast was shown in this run.
  private tracksToasted = new Set<string>();

  // Manual audio/subtitle picks per series (track-selection.ts).
  private trackMemory = new JsonStore<TrackMemoryDoc>(join(app.getPath('userData'), 'track-memory.json'), {});
  // X-02: the version picked in the player, per series, by signature ("2160p hevc dv"); 300 series.
  private versionMemory = new JsonStore<Record<string, { sig: string; at: number }>>(join(app.getPath('userData'), 'version-memory.json'), {});

  constructor(private readonly deps: PlaybackDeps) {}

  // X-05: the title (SeriesId ?? Id) and, when a setting is per library, the library of this item.
  async scopeCtxFor(sid: string | undefined, item: BaseItem, global: boolean): Promise<ScopeCtx> {
    if (global) return { global: true };
    const title = `${sid ?? ''}:${item.SeriesId ?? item.Id}`;
    if (!Object.values(this.deps.settings.value.playback.rememberScopes).includes('library')) return { title };
    let lib = this.libraries.get(title);
    if (lib === undefined) {
      const api = this.deps.connection.apiFor(sid);
      const ancestors = await api.get<BaseItem[]>(`/Items/${item.Id}/Ancestors`, { UserId: this.deps.connection.userIdFor(sid) }).catch(() => null);
      lib = ancestors?.find((a) => a.Type === 'CollectionFolder')?.Id ?? '';
      // A failed lookup is retried next time.
      if (ancestors) this.libraries.set(title, lib);
    }
    return { title, library: lib ? `${sid ?? ''}:${lib}` : undefined };
  }

  recall(prop: ScopedProp): unknown {
    return readScoped(this.scopes.value, prop, this.deps.settings.value.playback.rememberScopes[prop], this.scopeCtx);
  }

  remember(prop: ScopedProp, value: unknown): void {
    this.scopes.set(writeScoped(this.scopes.value, prop, this.deps.settings.value.playback.rememberScopes[prop], this.scopeCtx, value));
  }

  // "Oublier les réglages du lecteur" (Réglages).
  forget(): void {
    this.scopes.set({});
  }

  tracksFor(seriesId: string): TrackMemoryDoc[string] | undefined {
    return this.trackMemory.value[seriesId];
  }

  // A manual pick during an episode becomes the series default (track-selection.ts).
  rememberTrack(c: Current, seriesId: string, kind: 'audio' | 'subtitle', index: number | null): void {
    const streams: MediaStream[] = c.source?.MediaStreams ?? c.item.MediaStreams ?? [];
    const stream = index === null ? null : (streams.find((s) => s.Index === index) ?? null);
    if (index !== null && !stream) return;
    this.trackMemory.set(rememberChoice(this.trackMemory.value, seriesId, kind, stream, Date.now(), streams));
  }

  // X-05: once per series and run, when the memory changed the tracks.
  firstToast(seriesId: string): boolean {
    if (this.tracksToasted.has(seriesId)) return false;
    this.tracksToasted.add(seriesId);
    return true;
  }

  versionFor(seriesId: string): string | undefined {
    return this.versionMemory.value[seriesId]?.sig;
  }

  rememberVersion(seriesId: string, sig: string): void {
    const next = { ...this.versionMemory.value, [seriesId]: { sig, at: Date.now() } };
    this.versionMemory.set(Object.fromEntries(Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, 300)));
  }

  // Before stop(): a slow Stopped report may outlast the quit budget.
  flush(): void {
    this.trackMemory.flush();
    this.versionMemory.flush();
    this.scopes.flush();
  }
}
