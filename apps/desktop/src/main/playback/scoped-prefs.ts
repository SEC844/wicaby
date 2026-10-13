import type { RememberScope, RememberScopes } from '../../shared/contract';

// X-05: speed, delays and aspect remembered at the scope set in Réglages > Lecture > "Mémoriser les
// réglages". Pure, like ScopedPrefs.kt (fixtures in tools/checks/fixtures/track); the store is
// player-scopes.json in player-memory.ts.

export type ScopedProp = keyof RememberScopes;
interface Entry {
  v: unknown;
  at: number;
}
interface PropDoc {
  global?: Entry;
  library?: Record<string, Entry>;
  title?: Record<string, Entry>;
}
export type ScopesDoc = Partial<Record<ScopedProp, PropDoc>>;

// title: SeriesId ?? Id; library: the library view id. global: Live TV and downloads, always global.
export interface ScopeCtx {
  title?: string;
  library?: string;
  global?: boolean;
}

export const SCOPE_CAP = 300;

// Where a value lives for this context: null = not remembered.
function slot(scope: RememberScope, ctx: ScopeCtx): { map: 'library' | 'title'; key: string } | 'global' | null {
  if (scope === 'off') return null;
  if (scope === 'global' || ctx.global) return 'global';
  const key = scope === 'title' ? ctx.title : ctx.library;
  return key ? { map: scope, key } : null;
}

// Only the configured scope is read, then the global value; another scope's entries never come back.
export function readScoped(doc: ScopesDoc, prop: ScopedProp, scope: RememberScope, ctx: ScopeCtx): unknown {
  if (scope === 'off') return undefined;
  const d = doc[prop];
  const s = slot(scope, ctx);
  const own = s && s !== 'global' ? d?.[s.map]?.[s.key] : undefined;
  return (own ?? d?.global)?.v;
}

export function writeScoped(doc: ScopesDoc, prop: ScopedProp, scope: RememberScope, ctx: ScopeCtx, value: unknown, now = Date.now()): ScopesDoc {
  const s = slot(scope, ctx);
  if (!s) return doc;
  const d: PropDoc = { ...doc[prop] };
  if (s === 'global') d.global = { v: value, at: now };
  else {
    // The oldest entries go first past SCOPE_CAP.
    const entries = Object.entries({ ...d[s.map], [s.key]: { v: value, at: now } }).sort((a, b) => b[1].at - a[1].at);
    d[s.map] = Object.fromEntries(entries.slice(0, SCOPE_CAP));
  }
  return { ...doc, [prop]: d };
}
