// Community timestamps (intro, recap, credits, preview) from TheIntroDB for titles the server has no markers for,
// with the desktop's pure shared/community-segments.ts. Third party: off by default (Settings > Playback); sends the
// title's TMDB, TVDB or IMDb id and the episode numbers.
// IntroDB is left out here: api.introdb.app answers every origin with Access-Control-Allow-Origin: https://introdb.app,
// so the TV's browser engine may not read it. The desktop and Android apps (no CORS) ask both.
import { communityMarkers, communityTarget, theIntroDbTimes, theIntroDbUrl } from '$shared/community-segments';
import type { BaseItem } from '$shared/models';
import type { Api } from './api';
import { fromMarkers, type Segments } from './segments';

// In memory for the run: one answer body per title / episode ("no data" included), parsed per play as the sanity
// drops depend on the runtime; and when a 429 lets us ask again.
const cache = new Map<string, unknown>();
let retryAt = 0;

// Engines before Chromium 66 have no AbortController, so the request races a 5 s timer (as api.ts does) and is
// cancelled only where it can be.
function get(url: string): Promise<Response> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => (ctl?.abort(), reject(new Error('theintrodb timeout'))), 5000);
  });
  const done = () => clearTimeout(timer);
  // No Promise.prototype.finally before Chromium 63.
  return Promise.race([fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: ctl?.signal }), timeout]).then(
    (r) => (done(), r),
    (e) => (done(), Promise.reject(e)),
  );
}

export async function communitySegments(api: Api, item: BaseItem): Promise<Segments | null> {
  const runtimeMs = (item.RunTimeTicks ?? 0) / 10_000;
  if ((item.Type !== 'Movie' && !(item.Type === 'Episode' && item.SeriesId)) || runtimeMs <= 0) return null;
  const ids = item.Type === 'Movie' && item.ProviderIds ? item.ProviderIds : (await api.item(item.Type === 'Episode' ? item.SeriesId! : item.Id)).ProviderIds;
  const target = communityTarget(item, ids);
  if (!target) return null;
  const url = theIntroDbUrl(target);
  if (!cache.has(url)) {
    if (retryAt > Date.now()) return null;
    // The browser sets the User-Agent itself.
    const res = await get(url);
    if (res.status === 429) {
      retryAt = Date.now() + (Number(res.headers.get('retry-after')) || 60) * 1000;
      return null;
    }
    if (!res.ok && res.status !== 404) throw new Error(`theintrodb ${res.status}`);
    cache.set(url, res.ok ? await res.json() : null);
  }
  const m = communityMarkers(theIntroDbTimes(cache.get(url), runtimeMs));
  return m ? fromMarkers(m) : null;
}
