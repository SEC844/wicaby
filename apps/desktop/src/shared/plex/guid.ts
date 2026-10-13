// Plex GUIDs → Emby ProviderIds (plex-spec §4, triage §4.5). New agents send `Guid[]` ({id: 'imdb://tt…'});
// legacy agents a scalar `guid` ('com.plexapp.agents.imdb://tt…?lang=en', '…thetvdb://123/1/2', HAMA
// 'com.plexapp.agents.hama://anidb-123'). `Guid[]` wins over the scalar. Plex-internal ids (plex://, local://,
// none://) carry no provider id. Pure and erasable TypeScript: tools/checks/plex-map-check.mjs runs it.

// Provider spellings → Emby's ProviderIds keys (the ones Trakt and the Live TV match read).
const PROVIDERS: Readonly<Record<string, string>> = {
  imdb: 'Imdb',
  tmdb: 'Tmdb',
  themoviedb: 'Tmdb',
  tvdb: 'Tvdb',
  thetvdb: 'Tvdb',
  anidb: 'AniDB',
};

// HAMA prefixes 'anidb2-', 'tvdb3-' (episode-numbering variants) name the same provider.
const providerOf = (name: string): string | undefined => PROVIDERS[name.toLowerCase().replace(/\d+$/, '')];

// One provider id, or null. `id` is the value after '://' with no query.
function parseOne(scheme: string, value: string): [string, string] | null {
  const s = scheme.toLowerCase().replace(/^com\.plexapp\.agents\./, '').replace(/^tv\.plex\.agents\./, '');
  const v = decodeURIComponent(value.split('?')[0] ?? '').trim();
  if (!v) return null;
  if (s === 'hama' || s === 'xbmcnfo' || s === 'xbmcnfotv') {
    // HAMA and NFO agents: 'anidb-123', 'tvdb3-81189', or a bare 'tt…' / number.
    const m = /^([a-z]+\d*)-(.+)$/i.exec(v);
    if (m) {
      const p = providerOf(m[1]);
      return p ? [p, m[2].split('/')[0]] : null;
    }
    if (/^tt\d+$/.test(v)) return ['Imdb', v];
    if (s === 'xbmcnfotv' && /^\d+$/.test(v)) return ['Tvdb', v];
    return null;
  }
  const p = providerOf(s);
  if (!p) return null;
  // Legacy TV agents append '/season/episode' to the show id: that is not this item's own id.
  if (v.includes('/')) return null;
  if (p === 'Imdb' && !/^tt\d+$/.test(v)) return null;
  return [p, v];
}

function split(guid: string): [string, string] | null {
  const i = guid.indexOf('://');
  return i > 0 ? [guid.slice(0, i), guid.slice(i + 3)] : null;
}

export function providerIds(meta: { guid?: string; Guid?: { id?: string }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  const legacy = meta.guid ? split(meta.guid) : null;
  const legacyOne = legacy ? parseOne(legacy[0], legacy[1]) : null;
  if (legacyOne) out[legacyOne[0]] = legacyOne[1];
  for (const g of meta.Guid ?? []) {
    const parts = g?.id ? split(g.id) : null;
    const one = parts ? parseOne(parts[0], parts[1]) : null;
    if (one) out[one[0]] = one[1];
  }
  return out;
}
