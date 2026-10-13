// A disposable Jellyfin token per cast (cast-spec CA-11), through Quick Connect, so a renderer never gets the user's
// long-lived token: the DLNA renderer with the relay off, the Default Media Receiver with the relay off, and the
// Jellyfin receiver (which calls the API itself). Emby has no equivalent and keeps the relay or the user token.
// The token still carries the user's full rights: it is limited in time, not in scope.
// - sender: a cast this PC reports for (direct DLNA, DMR); revoked when the cast ends, however it ends.
// - receiver: the Jellyfin receiver plays on after the sender quits; revoked on "Arrêter la diffusion" only, or at a
//   cleanup once GET /Sessions?DeviceId= no longer lists the token's device.
// Every token is kept in the encrypted vault until it is revoked (Logout needs the token itself, not a hash), so a
// crash leaves nothing behind for longer than one app start.
import crypto from 'node:crypto';
import { ApiClient, ApiError } from '../connection/api-client';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';

const log = logger.scope('cast-token');

export type TokenKind = 'sender' | 'receiver';

export interface Disposable {
  token: string;
  deviceId: string;
  kind: TokenKind;
  serverId: string;
  // The renderer it was made for: the Device field it was minted with.
  name: string;
}

const valid = (d: unknown): d is Disposable => {
  const x = d as Disposable;
  return Boolean(x) && typeof x.token === 'string' && typeof x.deviceId === 'string' && (x.kind === 'sender' || x.kind === 'receiver') && typeof x.serverId === 'string' && typeof x.name === 'string';
};

export class EphemeralTokens {
  static vaultKey = 'cast:disposable-tokens';
  private cleaning: Promise<void> | null = null;

  constructor(
    private readonly vault: Pick<CredentialVault, 'get' | 'set' | 'delete'>,
    private readonly version: string,
  ) {}

  list(): Disposable[] {
    try {
      const v: unknown = JSON.parse(this.vault.get(EphemeralTokens.vaultKey)?.token ?? '[]');
      return Array.isArray(v) ? v.filter(valid) : [];
    } catch {
      return [];
    }
  }

  private save(list: Disposable[]): Promise<void> {
    const key = EphemeralTokens.vaultKey;
    return list.length ? this.vault.set(key, { userId: '', userName: 'cast', token: JSON.stringify(list) }) : this.vault.delete(key);
  }

  // Requests as the cast's own device (Client "Wicaby Cast", the renderer's name, a random DeviceId).
  private client(api: ApiClient, d: Pick<Disposable, 'deviceId' | 'name'>, token?: string): ApiClient {
    return new ApiClient(api.address, 'jellyfin', { client: 'Wicaby Cast', version: this.version, deviceId: d.deviceId, deviceName: d.name }, token);
  }

  // A fresh token for a cast to [name], in the vault before it is used. null on Emby, with Quick Connect off, or on
  // any failure: the caller falls back to §2.6.3 without an error.
  async mint(api: ApiClient, serverId: string, name: string, kind: TokenKind): Promise<Disposable | null> {
    if (api.kind !== 'jellyfin' || !api.token) return null;
    try {
      if ((await api.get<unknown>('/QuickConnect/Enabled')) !== true) return null;
      const dev = { deviceId: crypto.randomBytes(16).toString('hex'), name: name.slice(0, 64) || 'Cast' };
      const anon = this.client(api, dev);
      const init = await anon.post<{ Code?: string; Secret?: string }>('/QuickConnect/Initiate');
      if (!init?.Code || !init.Secret) return null;
      // [UNVERIFIED] without userId the server authorizes the code for the caller (RequestHelpers.GetUserId).
      await api.post('/QuickConnect/Authorize', { code: init.Code });
      const auth = await anon.post<{ AccessToken?: string }>('/Users/AuthenticateWithQuickConnect', undefined, { Secret: init.Secret });
      if (typeof auth?.AccessToken !== 'string' || !auth.AccessToken) return null;
      const d: Disposable = { token: auth.AccessToken, kind, serverId, ...dev };
      await this.save([...this.list(), d]);
      return d;
    } catch (err) {
      log.info(`no disposable token (${err instanceof Error ? err.message : String(err)}): the user token is used`);
      return null;
    }
  }

  // Logout with the token itself revokes it. A 401 means it is already gone. Otherwise it stays for a later cleanup.
  async revoke(d: Disposable, api: ApiClient): Promise<boolean> {
    try {
      await this.client(api, d, d.token).post('/Sessions/Logout');
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        log.info(`revoke failed, kept for a later cleanup: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    await this.save(this.list().filter((x) => x.token !== d.token));
    return true;
  }

  // Leftovers (a crash, a quit, a receiver left playing) on the servers signed in now. [inUse]: the live cast's.
  cleanup(onlineApi: (serverId: string) => ApiClient | null, inUse: (token: string) => boolean): Promise<void> {
    this.cleaning ??= (async () => {
      for (const d of this.list()) {
        const api = onlineApi(d.serverId);
        if (!api || inUse(d.token)) continue;
        if (d.kind === 'receiver') {
          // [UNVERIFIED] the receiver may report under its own DeviceId; this is the token's device session.
          const live = await api.get<unknown>('/Sessions', { DeviceId: d.deviceId }).catch(() => null);
          if (!Array.isArray(live) || live.length > 0) continue;
        }
        await this.revoke(d, api);
      }
    })().finally(() => (this.cleaning = null));
    return this.cleaning;
  }
}
