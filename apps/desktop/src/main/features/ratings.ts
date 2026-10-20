import { net } from 'electron';
import type { ExternalRating } from '../../shared/ratings';
import { MDBLIST_API, MDBLIST_KEY_RE, MDBLIST_PATH_RE, parseMdblist, RATINGS_TTL_MS } from '../../shared/ratings';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';
import { t } from '../i18n';

const log = logger.scope('ratings');
const VAULT_KEY = 'ratings:mdblist';
const MAX_CACHED = 2000;

type Cache = Record<string, { at: number; ratings: ExternalRating[] }>;

// External ratings for the Item page (shared/ratings.ts): the user's MDBList key in the vault, answers cached
// on disk for a week. Off (no request at all) until a key is set.
export class RatingsService {
  private readonly cache: JsonStore<Cache>;
  private readonly inflight = new Map<string, Promise<ExternalRating[]>>();

  constructor(
    private readonly vault: CredentialVault,
    file: string,
  ) {
    this.cache = new JsonStore<Cache>(file, {});
  }

  configured(): boolean {
    return Boolean(this.vault.get(VAULT_KEY)?.token);
  }

  // An empty key turns the feature off. The cache goes too: it was built with the old key's account.
  async setKey(key: string): Promise<boolean> {
    const k = key.trim();
    if (k && !MDBLIST_KEY_RE.test(k)) throw new Error(t('errors.ratings.invalidKey'));
    if (k) await this.vault.set(VAULT_KEY, { userId: '', userName: 'mdblist', token: k });
    else if (this.vault.get(VAULT_KEY)) await this.vault.delete(VAULT_KEY);
    this.cache.set({});
    return Boolean(k);
  }

  get(path: string): Promise<ExternalRating[]> {
    const key = this.vault.get(VAULT_KEY)?.token;
    if (!key || !MDBLIST_PATH_RE.test(path)) return Promise.resolve([]);
    const hit = this.cache.value[path];
    if (hit && Date.now() - hit.at < RATINGS_TTL_MS) return Promise.resolve(hit.ratings);
    let p = this.inflight.get(path);
    if (!p) {
      p = this.fetch(path, key).finally(() => this.inflight.delete(path));
      this.inflight.set(path, p);
    }
    return p;
  }

  private async fetch(path: string, key: string): Promise<ExternalRating[]> {
    try {
      const res = await net.fetch(`${MDBLIST_API}/${path}?apikey=${encodeURIComponent(key)}`, { redirect: 'error' });
      // 404: MDBList does not know the title, remembered like an answer. Anything else (bad key, rate limit) is retried later.
      if (!res.ok && res.status !== 404) {
        log.warn(`MDBList ${path}: HTTP ${res.status}`);
        return [];
      }
      const ratings = res.ok ? parseMdblist(await res.json()) : [];
      this.cache.update((c) => {
        delete c[path];
        c[path] = { at: Date.now(), ratings };
        const keys = Object.keys(c);
        // Oldest first (insertion order): the file stays small.
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHED))) delete c[k];
      });
      return ratings;
    } catch (err) {
      // The URL carries the key: only the path is logged.
      log.warn(`MDBList ${path}: ${err instanceof Error ? err.name : 'error'}`);
      return [];
    }
  }
}
