// Emby / Jellyfin HTTP client: the browser counterpart of the desktop's main/connection/api-client.ts and of the
// Android core Emby.kt. One instance per signed-in server and user.
import type { AuthenticationResult, BaseItem, ItemsResult, SystemInfoPublic, UserDto } from '$shared/models';
import { CLIENT, VERSION, deviceId, deviceName } from './identity';

export type ServerKind = 'emby' | 'jellyfin';
export type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function quote(value: string): string {
  return `"${encodeURIComponent(value)}"`;
}

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// fetch() with a timeout. Engines before Chromium 66 ignore AbortSignal, so the request also races the timer.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new ApiError('timeout', 0));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Api {
  constructor(
    readonly address: string,
    readonly kind: ServerKind,
    public token?: string,
    public userId?: string,
  ) {}

  private get prefix(): string {
    return this.kind === 'emby' ? '/emby' : '';
  }

  url(path: string, query?: Query): string {
    return `${this.address}${this.prefix}${path}${buildQuery(query)}`;
  }

  authHeaders(): Record<string, string> {
    const parts = [`Client=${quote(CLIENT)}`, `Device=${quote(deviceName)}`, `DeviceId=${quote(deviceId)}`, `Version=${quote(VERSION)}`];
    if (this.kind === 'emby') {
      if (this.userId) parts.unshift(`UserId=${quote(this.userId)}`);
      const headers: Record<string, string> = { 'X-Emby-Authorization': `Emby ${parts.join(', ')}` };
      if (this.token) headers['X-Emby-Token'] = this.token;
      return headers;
    }
    if (this.token) parts.push(`Token=${quote(this.token)}`);
    return { Authorization: `MediaBrowser ${parts.join(', ')}` };
  }

  async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.authHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path, query), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, TIMEOUT_MS);
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0);
    }
    if (!res.ok) throw new ApiError((await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`, res.status);
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('json') ? await res.json() : await res.text()) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, query, body ?? {});
  }

  del<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, query);
  }

  // --- Sign-in ---

  publicUsers(): Promise<UserDto[]> {
    return this.get('/Users/Public');
  }

  async signIn(username: string, password: string): Promise<AuthenticationResult> {
    const r = await this.post<AuthenticationResult>('/Users/AuthenticateByName', { Username: username, Pw: password });
    this.token = r.AccessToken;
    this.userId = r.User.Id;
    return r;
  }

  // --- Browsing: the Android Emby.kt calls, same routes and queries ---

  get isEmby(): boolean {
    return this.kind === 'emby';
  }

  private get listFields(): string {
    return this.isEmby ? `${LIST_FIELDS},PremiereDate` : LIST_FIELDS;
  }

  // Jellyfin 10.9 moved several per-user routes; older Jellyfin only has the old ones.
  private async jellyfinOrLegacy<T>(modern: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
    try {
      return await modern();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return legacy();
      throw e;
    }
  }

  async views(): Promise<BaseItem[]> {
    const r = this.isEmby
      ? await this.get<ItemsResult>(`/Users/${this.userId}/Views`)
      : await this.jellyfinOrLegacy(() => this.get<ItemsResult>('/UserViews', { userId: this.userId }), () => this.get<ItemsResult>(`/Users/${this.userId}/Views`));
    return r.Items;
  }

  async resume(): Promise<BaseItem[]> {
    const q: Query = { Limit: 24, MediaTypes: 'Video', Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    const r = this.isEmby
      ? await this.get<ItemsResult>(`/Users/${this.userId}/Items/Resume`, q)
      : await this.jellyfinOrLegacy(() => this.get<ItemsResult>('/UserItems/Resume', { userId: this.userId, ...q }), () => this.get<ItemsResult>(`/Users/${this.userId}/Items/Resume`, q));
    return r.Items;
  }

  async nextUp(seriesId?: string, limit = 24): Promise<BaseItem[]> {
    const q: Query = { UserId: this.userId, SeriesId: seriesId, Limit: limit, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    return (await this.get<ItemsResult>('/Shows/NextUp', q)).Items;
  }

  // Episodes airing soon, soonest first.
  async upcoming(limit = 24): Promise<BaseItem[]> {
    const q: Query = { UserId: this.userId, Limit: limit, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    return (await this.get<ItemsResult>('/Shows/Upcoming', q)).Items.sort((a, b) => (a.PremiereDate ?? '').localeCompare(b.PremiereDate ?? ''));
  }

  latest(parentId?: string): Promise<BaseItem[]> {
    const q: Query = { ParentId: parentId, Limit: 24, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items/Latest`, q);
    return this.get<BaseItem[]>('/Items/Latest', { userId: this.userId, ...q }).catch(() => this.get<BaseItem[]>(`/Users/${this.userId}/Items/Latest`, q));
  }

  // Emby 4.10 joins a repeated query name ("1,1"): a default the query names is left out.
  items(query: Query): Promise<ItemsResult> {
    const named = new Set(Object.keys(query).map((k) => k.toLowerCase()));
    const defaults: Query = {};
    if (!named.has('fields')) defaults.Fields = this.listFields;
    if (!named.has('enableimagetypes')) defaults.EnableImageTypes = ART;
    if (!named.has('imagetypelimit')) defaults.ImageTypeLimit = 1;
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items`, { ...defaults, ...query });
    return this.get('/Items', { userId: this.userId, ...defaults, ...query });
  }

  item(id: string): Promise<BaseItem> {
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items/${id}`, { Fields: DETAIL_FIELDS });
    return this.jellyfinOrLegacy(
      () => this.get<BaseItem>(`/Items/${id}`, { userId: this.userId, Fields: DETAIL_FIELDS }),
      () => this.get<BaseItem>(`/Users/${this.userId}/Items/${id}`, { Fields: DETAIL_FIELDS }),
    );
  }

  async seasons(seriesId: string): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Shows/${seriesId}/Seasons`, { UserId: this.userId, Fields: this.listFields })).Items;
  }

  // No seasonId: every episode of the series, in order (specials included).
  async episodes(seriesId: string, seasonId?: string): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Shows/${seriesId}/Episodes`, { UserId: this.userId, SeasonId: seasonId, Fields: this.listFields })).Items;
  }

  async similar(id: string, limit = 16): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Items/${id}/Similar`, { UserId: this.userId, Limit: limit, Fields: this.listFields })).Items;
  }

  // Last played date per series, one batched call (Continue Watching's next-up order).
  async seriesUserData(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const r = await this.get<ItemsResult>(`/Users/${this.userId}/Items`, { Ids: ids.slice(0, 24).join(','), Fields: 'UserData', EnableImages: false });
    return new Map(r.Items.filter((i) => i.UserData?.LastPlayedDate).map((i) => [i.Id, i.UserData!.LastPlayedDate!]));
  }

  // "Retirer de Continuer à regarder": Emby only (Jellyfin has no equivalent; a 404 means unsupported).
  hideFromResume(id: string, hide: boolean): Promise<void> {
    return this.request('POST', `/Users/${this.userId}/Items/${id}/HideFromResume`, { Hide: hide }, {});
  }

  // The user's server-side configuration (audio/subtitle languages, subtitle mode): the servers pick default streams
  // from it, so every client follows the same preference (Settings.kt ServerConfig).
  async userConfiguration(): Promise<Record<string, unknown>> {
    return (await this.get<{ Configuration?: Record<string, unknown> }>(`/Users/${this.userId}`)).Configuration ?? {};
  }

  setUserConfiguration(config: Record<string, unknown>): Promise<void> {
    return this.isEmby
      ? this.request('POST', `/Users/${this.userId}/Configuration`, undefined, config)
      : this.request('POST', '/Users/Configuration', { userId: this.userId }, config);
  }

  // --- Images (core data/Images.kt: the fallbacks Emby web uses) ---

  image(id: string, type: string, tag: string | undefined, size: { maxWidth?: number; maxHeight?: number }): string | undefined {
    if (!tag) return undefined;
    return this.url(`/Items/${id}/Images/${type}`, { tag, maxWidth: size.maxWidth && Math.round(size.maxWidth), maxHeight: size.maxHeight && Math.round(size.maxHeight), quality: 90 });
  }

  poster(item: BaseItem, maxHeight: number): string | undefined {
    const own = item.ImageTags?.Primary;
    if (own) return this.image(item.Id, 'Primary', own, { maxHeight });
    if (item.SeriesId && item.SeriesPrimaryImageTag) return this.image(item.SeriesId, 'Primary', item.SeriesPrimaryImageTag, { maxHeight });
    if (item.AlbumId && item.AlbumPrimaryImageTag) return this.image(item.AlbumId, 'Primary', item.AlbumPrimaryImageTag, { maxHeight });
    return undefined;
  }

  thumb(item: BaseItem, maxWidth: number): string | undefined {
    if (item.Type === 'Episode' && item.ImageTags?.Primary) return this.image(item.Id, 'Primary', item.ImageTags.Primary, { maxWidth });
    if (item.ImageTags?.Thumb) return this.image(item.Id, 'Thumb', item.ImageTags.Thumb, { maxWidth });
    if (item.ParentThumbItemId && item.ParentThumbImageTag) return this.image(item.ParentThumbItemId, 'Thumb', item.ParentThumbImageTag, { maxWidth });
    return this.backdrop(item, maxWidth);
  }

  backdrop(item: BaseItem, maxWidth = 1920): string | undefined {
    const own = item.BackdropImageTags?.[0];
    if (own) return this.image(item.Id, 'Backdrop', own, { maxWidth });
    const parent = item.ParentBackdropImageTags?.[0];
    if (item.ParentBackdropItemId && parent) return this.image(item.ParentBackdropItemId, 'Backdrop', parent, { maxWidth });
    return undefined;
  }

  logo(item: BaseItem, maxWidth = 800): string | undefined {
    if (item.ImageTags?.Logo) return this.image(item.Id, 'Logo', item.ImageTags.Logo, { maxWidth });
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return this.image(item.ParentLogoItemId, 'Logo', item.ParentLogoImageTag, { maxWidth });
    return undefined;
  }

  // Jellyfin 10.9 moved user avatars to /UserImage?userId=.
  userImage(user: { Id: string; PrimaryImageTag?: string }, maxHeight: number): string | undefined {
    const tag = user.PrimaryImageTag;
    if (!tag) return undefined;
    return this.isEmby
      ? this.url(`/Users/${user.Id}/Images/Primary`, { tag, maxHeight, quality: 90 })
      : this.url('/UserImage', { userId: user.Id, tag, maxHeight, quality: 90 });
  }

  // --- Library grid (tv Main.kt LibraryGrid) ---

  // A Live TV library's grid: the channel list rather than the view's folders.
  liveChannelsPage(start: number, limit: number): Promise<ItemsResult> {
    return this.get('/LiveTv/Channels', { UserId: this.userId, StartIndex: start, Limit: limit, EnableImageTypes: 'Primary,Thumb', Fields: 'PrimaryImageAspectRatio' });
  }
}

// core data/Emby.kt LIST_FIELDS and DETAIL_FIELDS.
export const LIST_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,ChildCount,RecursiveItemCount,OfficialRating,CommunityRating,Overview,Genres,ProviderIds,DateCreated,Etag';
export const DETAIL_FIELDS = `${LIST_FIELDS},Taglines,MediaSources,MediaStreams,People,Studios,Chapters,RemoteTrailers,LocalTrailerCount,Trickplay`;
const ART = 'Primary,Backdrop,Thumb,Logo';

// --- Finding a server from what the user typed ---

// The Android Api.candidates (core Emby.kt): "192.168.1.20", "nas:8920", "https://media.example.org/jellyfin" →
// base URLs to try. 8920 / 8096 are the Emby and Jellyfin default HTTPS / HTTP ports.
export function candidates(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  raw = raw.replace(/^\/+/, '');
  const slash = raw.indexOf('/');
  const host = slash < 0 ? raw : raw.slice(0, slash);
  if (/:\d+$/.test(host)) return [`https://${raw}`, `http://${raw}`];
  const tail = slash < 0 ? '' : raw.slice(slash);
  return [`https://${raw}`, `https://${host}:8920${tail}`, `http://${host}:8096${tail}`, `http://${raw}`];
}

export interface FoundServer {
  address: string;
  kind: ServerKind;
  info: SystemInfoPublic;
}

// Android Api.probeOne: /emby first (Emby only), then the root. No HTTP answer at all (refused, TLS failure) ends the
// address: the root path would not do better.
async function probeOne(address: string): Promise<FoundServer> {
  for (const prefix of ['/emby', '']) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${address}${prefix}/System/Info/Public`, { headers: { Accept: 'application/json' } }, 6_000);
    } catch {
      break;
    }
    const info = res.ok ? ((await res.json().catch(() => null)) as (SystemInfoPublic & { ProductName?: string }) | null) : null;
    if (!info?.Id) continue;
    const product = info.ProductName ?? '';
    const kind: ServerKind = /jellyfin/i.test(product) ? 'jellyfin' : prefix === '/emby' || /emby/i.test(product) ? 'emby' : 'jellyfin';
    return { address, kind, info };
  }
  throw new Error('not a server');
}

// The first address of [list] that answers, or null.
function race(list: string[]): Promise<FoundServer | null> {
  if (!list.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = list.length;
    for (const a of list)
      probeOne(a).then(resolve, () => {
        if (--pending === 0) resolve(null);
      });
  });
}

// Android Api.probe: HTTPS and plain HTTP are probed at once, but an HTTP answer is used only once every HTTPS
// candidate has failed, so a faster HTTP answer never wins over HTTPS.
export async function probe(input: string): Promise<FoundServer | null> {
  const list = candidates(input);
  const secure = race(list.filter((a) => /^https:/i.test(a)));
  const plain = race(list.filter((a) => !/^https:/i.test(a)));
  return (await secure) ?? (await plain);
}
