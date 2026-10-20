// window.wicaby for the web TV app: what the desktop's main process answers over IPC (preload/index.ts), answered
// in the page instead. Real: app, settings, servers, session, api, playback, htmlPlayer, events, ratings. Everything that
// needs the desktop (downloads, torrents, VPN, cast, file sources, IPTV, Plex, admin uploads) is a stub: lists come
// back empty, actions fail with "Not available in the TV app", and the UI hides them (lib/platform.ts `web`).
import type {
  AppInfo,
  DeepPartial,
  HtmlPlayerCommand,
  HtmlPlayerEvent,
  HtmlPlayerLoad,
  PlaybackState,
  PublicUser,
  ServerInfo,
  ServerSession,
  SessionState,
  Settings,
  Toast,
  WicabyBridge,
} from '../../desktop/src/shared/contract';
import { defaultSettings, merge } from '../../desktop/src/shared/default-settings';
import { MDBLIST_API, MDBLIST_KEY_RE, MDBLIST_PATH_RE, parseMdblist, RATINGS_TTL_MS, type ExternalRating } from '../../desktop/src/shared/ratings';
import { t } from '../../desktop/src/renderer/lib/i18n.svelte';
import { DEMO_ADDRESS, DEMO_BASE, DEMO_ID, demoAvailable, loadDemo } from './demo';
import { apiBase, HttpError, probe, redact, request, type Identity, type StoredServer } from './http';
import { WebPlayback } from './playback';
import { SyncPlay } from './syncplay';
import { exitApp, onTv, platform } from './tv';

type AuthResult = { AccessToken: string; User: { Id: string; Name: string; Policy?: { IsAdministrator?: boolean }; PrimaryImageTag?: string } };

const SERVERS_KEY = 'wicaby.web.servers';
const SETTINGS_KEY = 'wicaby.web.settings';
const DEVICE_KEY = 'wicaby.web.device';
const PRIMARY_KEY = 'wicaby.web.primary';
// The MDBList key sits with the server tokens (localStorage, the TV app's own origin); answers are cached a week.
const RATINGS_KEY = 'wicaby.web.mdblist';
const RATINGS_CACHE = 'wicaby.web.ratings';

function read<T>(key: string, fallback: T, store: () => Storage = () => localStorage): T {
  try {
    const v = store().getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown, store: () => Storage = () => localStorage): void {
  try {
    store().setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: this session keeps working, the next starts over.
  }
}

// Tiny event hub: on(cb) returns the unsubscribe the contract expects.
function hub<T>() {
  const subs = new Set<(v: T) => void>();
  return {
    on: (cb: (v: T) => void) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    emit: (v: T) => subs.forEach((cb) => cb(v)),
  };
}

function deviceId(): string {
  let id = read<string>(DEVICE_KEY, '');
  if (!/^[a-z0-9-]{16,64}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    write(DEVICE_KEY, id);
  }
  return id;
}

// The web app's defaults: no first-run wizard (it sets up VPNs and file sources), the <video> player, and on a TV
// no backdrop blur (slow on TV GPUs) nor autoplaying hero trailers.
export function webDefaults(): Settings {
  const d = defaultSettings('');
  d.ui.onboarded = true;
  d.playback.player = 'html';
  if (onTv) {
    d.ui.reduceTransparency = true;
    d.ui.heroAutoplay = false;
  }
  return d;
}

const LOG_MAX = 300;
export const logLines: string[] = [];

export function createWebBridge(): { bridge: WicabyBridge; mediaBase: (serverId?: string) => string; playing: () => boolean } {
  const identity: Identity = {
    client: 'Wicaby',
    version: import.meta.env.VITE_WICABY_VERSION ?? '0',
    deviceId: deviceId(),
    deviceName: platform === 'webos' ? 'LG webOS TV' : platform === 'tizen' ? 'Samsung Tizen TV' : 'Web browser',
  };
  // Pages demo: <owner>.github.io is one origin shared by all the owner's Pages sites, so a real server (its token)
  // stays in this tab (sessionStorage); only the demo entry is kept. The TV packages run from their own origin.
  const session = () => sessionStorage;
  let servers = [...(demoAvailable ? read<StoredServer[]>(SERVERS_KEY, [], session) : []), ...read<StoredServer[]>(SERVERS_KEY, [])].filter((s) => s && typeof s.id === 'string' && typeof s.address === 'string');
  const savedPrimary = read<string>(PRIMARY_KEY, '');
  let primary: string | undefined = servers.some((s) => s.id === savedPrimary) ? savedPrimary : servers[0]?.id;
  const setPrimary = (id: string | undefined) => {
    primary = id;
    write(PRIMARY_KEY, id ?? '');
  };
  const sessions = new Map<string, ServerSession>();
  let settings: Settings = merge(webDefaults(), read<DeepPartial<Settings>>(SETTINGS_KEY, {}));

  const sessionHub = hub<SessionState>();
  const settingsHub = hub<Settings>();
  const playbackHub = hub<PlaybackState>();
  const loadHub = hub<HtmlPlayerLoad>();
  const commandHub = hub<HtmlPlayerCommand>();
  const toastHub = hub<Toast>();

  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.shift();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(line);
  };

  const isDemo = (s: StoredServer) => s.address === DEMO_ADDRESS;
  const origin = (address: string) => {
    try {
      return new URL(address).origin;
    } catch {
      return address; // the demo's 'demo'
    }
  };
  const saveServers = () => {
    if (!demoAvailable) return write(SERVERS_KEY, servers);
    write(SERVERS_KEY, servers.filter(isDemo));
    write(SERVERS_KEY, servers.filter((s) => !isDemo(s)), session);
  };
  const find = (id?: string) => servers.find((s) => s.id === (id ?? primary));
  // Quick Connect requests waiting for approval, per server (the secret stays here).
  const quick = new Map<string, string>();
  const signedIn = (s: StoredServer, res: AuthResult) => {
    Object.assign(s, { token: res.AccessToken, userId: res.User.Id, userName: res.User.Name });
    saveServers();
    setPrimary(s.id);
    setSession(s, { status: 'signed-in', user: { id: res.User.Id, name: res.User.Name, isAdmin: Boolean(res.User.Policy?.IsAdministrator), imageTag: res.User.PrimaryImageTag } });
    return state();
  };
  const info = (s: StoredServer): ServerInfo => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    version: s.version,
    manualAddress: s.address === DEMO_ADDRESS ? undefined : s.address,
    lastAddress: s.address === DEMO_ADDRESS ? undefined : s.address,
    userId: s.userId,
    userName: s.userName,
    hasToken: Boolean(s.token),
  });

  function state(): SessionState {
    const list = [...sessions.values()].sort((a, b) => (a.server.id === primary ? -1 : b.server.id === primary ? 1 : 0));
    const first = list[0];
    if (!first) return { status: 'no-server', sessions: [] };
    const status = list.some((s) => s.status === 'signed-in') ? 'signed-in' : first.status;
    return { status, server: first.server, user: first.user, address: first.address, sessions: list };
  }
  const publish = () => sessionHub.emit(state());
  const setSession = (s: StoredServer, patch: Partial<ServerSession> & { status: ServerSession['status'] }) => {
    sessions.set(s.id, { server: info(s), address: s.address, route: 'local', ...patch });
    publish();
  };

  // An offline server (the TV started before its Wi-Fi, the server rebooting) is retried on its own: 5 s doubling to
  // 60 s, and at once when the browser comes back online.
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>();
  const isOffline = (s: StoredServer) => servers.includes(s) && sessions.get(s.id)?.status === 'offline';
  const retryLater = (s: StoredServer) => {
    const prev = retries.get(s.id);
    if (prev) clearTimeout(prev.timer);
    const delay = prev ? Math.min(prev.delay * 2, 60_000) : 5000;
    retries.set(s.id, { delay, timer: setTimeout(() => void (isOffline(s) && connect(s)), delay) });
  };
  if (typeof window !== 'undefined') window.addEventListener('online', () => servers.filter(isOffline).forEach((s) => void connect(s)));

  async function connect(s: StoredServer): Promise<void> {
    if (!s.token || !s.userId) return setSession(s, { status: 'server-selected' });
    setSession(s, { status: 'connecting' });
    try {
      const u = await request<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean }; PrimaryImageTag?: string }>(s, identity, 'GET', `/Users/${s.userId}`);
      clearTimeout(retries.get(s.id)?.timer);
      retries.delete(s.id);
      setSession(s, { status: 'signed-in', user: { id: u.Id, name: u.Name, isAdmin: Boolean(u.Policy?.IsAdministrator), imageTag: u.PrimaryImageTag } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        // The server forgot this sign-in: sign in again.
        s.token = undefined;
        saveServers();
        setSession(s, { status: 'server-selected' });
      } else {
        setSession(s, { status: 'offline' });
        retryLater(s);
      }
    }
  }

  const playback = new WebPlayback({
    server: (id) => find(id),
    identity,
    settings: () => settings,
    load: (l) => loadHub.emit(l),
    command: (c) => commandHub.emit(c),
    publish: (s) => {
      playbackHub.emit(s);
      if (s.error) toastHub.emit({ kind: 'error', message: s.error });
      syncplay.onState(s);
    },
    log,
  });
  // Jellyfin watch together, on the item's server (the primary when none), whose socket SyncPlay then owns.
  const syncplay = new SyncPlay({
    server: (id) => find(id),
    identity,
    state: () => playback.value,
    play: (req) => playback.play(req),
    local: (c) => playback.command(c),
    toast: (message) => toastHub.emit({ kind: 'info', message }),
    log,
  });

  // The UI waits for the primary server only: the others publish their state through sessionHub when they settle.
  const connecting = new Map(servers.filter((s) => s.token).map((s) => [s.id, connect(s)]));
  const ready = connecting.get(primary ?? '') ?? Promise.resolve();
  const notAvailable = () => Promise.reject(new Error(t('errors.web.notAvailable')));
  const apiCall = <T>(method: string, path: string, query?: Parameters<WicabyBridge['api']['get']>[1], body?: unknown, serverId?: string): Promise<T> => {
    const s = find(serverId);
    if (!s) return Promise.reject(new Error(t('errors.connection.noServerConnected')));
    return request<T>(s, identity, method, path, query ?? undefined, body).catch((err: unknown) => {
      log('warn', `${method} ${path}: ${String(err)}`);
      throw err;
    });
  };

  const real = {
    app: {
      info: async (): Promise<AppInfo> => ({
        name: 'Wicaby',
        version: identity.version,
        electron: '',
        chromium: /Chrom(?:e|ium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '',
        node: '',
        platform,
        osRelease: '',
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        mpvPath: null,
        mpvVersion: null,
        userDataPath: '',
        logPath: '',
        isPackaged: true,
        vaultPlainText: true,
        refreshRateMatch: false,
      }),
      quit: async () => exitApp(),
      openExternal: async (url: string) => {
        if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
      },
      openPath: notAvailable,
      log: (level: 'info' | 'warn' | 'error', message: string) => log(level, message),
      storage: async () => ({ http: 0, comics: 0, logs: logLines.join('\n').length }),
      clearStorage: async () => {
        logLines.length = 0;
        return { http: 0, comics: 0, logs: 0 };
      },
    },
    updates: {
      state: async () => ({ status: 'idle' as const, update: null, dismissed: false }),
      check: async () => ({ status: 'current' as const, update: null, dismissed: false }),
      open: notAvailable,
      dismiss: async () => ({ status: 'idle' as const, update: null, dismissed: true }),
      onState: () => () => undefined,
    },
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      toggleFullscreen: async () => {
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        else await document.documentElement.requestFullscreen?.().catch(() => undefined);
      },
      getState: async () => ({ maximized: true, fullscreen: onTv || Boolean(document.fullscreenElement), focused: document.hasFocus() }),
      onState: () => () => undefined,
      mini: notAvailable,
    },
    settings: {
      get: async () => settings,
      update: async (patch: DeepPartial<Settings>) => {
        settings = merge(settings, patch);
        write(SETTINGS_KEY, settings);
        settingsHub.emit(settings);
        return settings;
      },
      pickFolder: async () => null,
      pickMpv: async () => null,
      onChange: settingsHub.on,
      audioDevices: async () => [],
      exportFile: async () => false,
      importFile: async () => null,
      reset: async () => {
        settings = webDefaults();
        write(SETTINGS_KEY, settings);
        settingsHub.emit(settings);
        return settings;
      },
    },
    servers: {
      // No UDP discovery in a browser; the demo server (Pages build) shows up as found nearby.
      discover: async () => (demoAvailable ? [{ id: DEMO_ID, name: 'Wicaby Demo', address: DEMO_ADDRESS, kind: 'emby' as const }] : []),
      list: async () => servers.map(info),
      add: async (address: string) => {
        let s: StoredServer;
        if (address.trim().toLowerCase() === DEMO_ADDRESS && demoAvailable) {
          const c = await loadDemo();
          s = { id: DEMO_ID, name: c.server.ServerName, kind: 'emby', version: c.server.Version, address: DEMO_ADDRESS };
        } else {
          const p = await probe(address);
          s = { id: p.info.Id, name: p.info.ServerName || p.address, kind: p.kind, version: p.info.Version ?? '', address: p.address };
        }
        const known = servers.find((x) => x.id === s.id);
        // The Id comes from the unauthenticated /System/Info/Public: a token only goes back to the origin it was
        // issued at, so a new origin (another host, or http where it was https) means signing in again.
        if (known?.token && origin(s.address) !== origin(known.address)) Object.assign(known, { token: undefined, userId: undefined, userName: undefined });
        if (known) Object.assign(known, { address: s.address, name: s.name, version: s.version, kind: s.kind });
        else servers.push(s);
        saveServers();
        return info(known ?? s);
      },
      embyConnect: notAvailable,
      select: async (id: string) => {
        const s = find(id);
        if (!s) throw new Error(t('errors.connection.unknownServer'));
        setPrimary(id);
        await connect(s);
        return state();
      },
      remove: async (id: string) => {
        const s = find(id);
        if (s?.token) await request(s, identity, 'POST', '/Sessions/Logout').catch(() => undefined);
        servers = servers.filter((x) => x.id !== id);
        sessions.delete(id);
        if (primary === id) setPrimary(servers[0]?.id);
        saveServers();
        publish();
      },
      wake: async () => false,
      plexLink: notAvailable,
      plexPoll: notAvailable,
      plexAccounts: async () => [],
      plexUnlink: notAvailable,
      plexSetHidden: async () => servers.map(info),
      plexConfirm: notAvailable,
    },
    session: {
      get: async () => {
        await ready;
        return state();
      },
      publicUsers: async (serverId?: string): Promise<PublicUser[]> => {
        const s = find(serverId);
        if (!s) return [];
        const list = await request<{ Id: string; Name: string; HasPassword?: boolean; PrimaryImageTag?: string }[]>(s, identity, 'GET', '/Users/Public').catch(() => []);
        return list.map((u) => ({ id: u.Id, name: u.Name, hasPassword: u.HasPassword !== false, imageTag: u.PrimaryImageTag }));
      },
      login: async (username: string, password: string, serverId?: string) => {
        const s = find(serverId);
        if (!s) throw new Error(t('errors.connection.noServerSelected'));
        let res: AuthResult;
        try {
          res = await request(s, identity, 'POST', '/Users/AuthenticateByName', undefined, { Username: username, Pw: password });
        } catch (err) {
          if (err instanceof HttpError && (err.status === 401 || err.status === 400)) throw new Error(t('errors.connection.wrongCredentials'));
          throw err;
        }
        return signedIn(s, res);
      },
      // Jellyfin Quick Connect: starts a request (its code), then polls it and signs in once approved elsewhere.
      quickConnect: async (serverId?: string) => {
        const s = find(serverId);
        if (!s) throw new Error(t('errors.connection.noServerSelected'));
        if (s.kind !== 'jellyfin') return null;
        const secret = quick.get(s.id);
        if (secret) {
          const r = await request<{ Code: string; Authenticated?: boolean }>(s, identity, 'GET', '/QuickConnect/Connect', { secret }).catch((err: unknown) => {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
          });
          if (r && !r.Authenticated) return { code: r.Code };
          quick.delete(s.id);
          if (r) return { state: signedIn(s, await request<AuthResult>(s, identity, 'POST', '/Users/AuthenticateWithQuickConnect', undefined, { Secret: secret })) };
        }
        if ((await request<unknown>(s, identity, 'GET', '/QuickConnect/Enabled').catch(() => false)) !== true) return null;
        // Jellyfin 10.9+ wants POST, older servers only answer GET.
        const init = await request<{ Code: string; Secret: string }>(s, identity, 'POST', '/QuickConnect/Initiate').catch((err: unknown) => {
          if (err instanceof HttpError && (err.status === 405 || err.status === 404)) return request<{ Code: string; Secret: string }>(s, identity, 'GET', '/QuickConnect/Initiate');
          throw err;
        });
        quick.set(s.id, init.Secret);
        return { code: init.Code };
      },
      logout: async (serverId?: string) => {
        const s = find(serverId);
        if (s?.token) {
          await request(s, identity, 'POST', '/Sessions/Logout').catch(() => undefined);
          s.token = undefined;
          saveServers();
          setSession(s, { status: 'server-selected' });
        }
        return state();
      },
      disconnect: async (serverId?: string) => {
        if (serverId) sessions.delete(serverId);
        else sessions.clear();
        publish();
        return state();
      },
      onChange: sessionHub.on,
    },
    api: {
      get: <T>(path: string, query?: Parameters<WicabyBridge['api']['get']>[1], serverId?: string) => apiCall<T>('GET', path, query, undefined, serverId),
      post: <T>(path: string, query?: Parameters<WicabyBridge['api']['get']>[1], body?: unknown, serverId?: string) => apiCall<T>('POST', path, query, body, serverId),
      del: <T>(path: string, query?: Parameters<WicabyBridge['api']['get']>[1], serverId?: string) => apiCall<T>('DELETE', path, query, undefined, serverId),
      put: <T>(path: string, query?: Parameters<WicabyBridge['api']['get']>[1], body?: unknown, serverId?: string) => apiCall<T>('PUT', path, query, body, serverId),
      uploadImage: notAvailable,
    },
    playback: {
      // In a watch-together group, playing and the remote's play/pause/seek go through the group.
      play: (req: Parameters<WicabyBridge['playback']['play']>[0]) => (syncplay.current() && !req.trailer ? syncplay.queue(req) : playback.play(req)),
      command: (c: Parameters<WicabyBridge['playback']['command']>[0]) => syncplay.command(c) ?? playback.command(c),
      getState: async () => playback.value,
      onState: playbackHub.on,
    },
    htmlPlayer: {
      onLoad: loadHub.on,
      onCommand: commandHub.on,
      emit: (ev: HtmlPlayerEvent) => playback.onEvent(ev),
    },
    events: {
      onServerEvent: () => () => undefined,
      onNavigate: () => () => undefined,
      onToast: toastHub.on,
    },
    syncplay: { list: (serverId?: string) => syncplay.list(serverId), create: (name: string, serverId?: string) => syncplay.create(name, serverId), join: (id: string, serverId?: string) => syncplay.join(id, serverId), leave: () => syncplay.leave(), current: syncplay.current, onChange: syncplay.onChange },
    // Lists the shared UI reads on its own (sidebar, sources page, live TV): empty.
    downloads: { list: async () => [], onChange: () => () => undefined },
    files: { list: async () => [] },
    iptv: { list: async () => [] },
    reminders: { list: async () => [], onCountdown: () => () => undefined },
    cast: { getState: async () => null, onState: () => () => undefined, onTargets: () => () => undefined, targets: async () => [] },
    vpn: { status: async () => [], embedded: { status: notAvailable, onChange: () => () => undefined } },
    photos: { immich: { sources: async () => [], onSources: () => () => undefined } },
    torrents: { state: async () => ({ status: 'unconfigured' as const, torrents: [] }) },
    trakt: { state: async () => ({ clientId: '', user: null, pending: null }) },
    ratings: {
      configured: async () => Boolean(read<string>(RATINGS_KEY, '')),
      setKey: async (key: string) => {
        const k = key.trim();
        if (k && !MDBLIST_KEY_RE.test(k)) throw new Error(t('errors.ratings.invalidKey'));
        write(RATINGS_KEY, k);
        write(RATINGS_CACHE, {});
        return Boolean(k);
      },
      get: async (path: string): Promise<ExternalRating[]> => {
        const key = read<string>(RATINGS_KEY, '');
        if (!key || !MDBLIST_PATH_RE.test(path)) return [];
        const cache = read<Record<string, { at: number; ratings: ExternalRating[] }>>(RATINGS_CACHE, {});
        const hit = cache[path];
        if (hit && Date.now() - hit.at < RATINGS_TTL_MS) return hit.ratings;
        try {
          const res = await fetch(`${MDBLIST_API}/${path}?apikey=${encodeURIComponent(key)}`);
          if (!res.ok && res.status !== 404) return [];
          const ratings = res.ok ? parseMdblist(await res.json()) : [];
          // shortcut: keeps the newest 300 titles in localStorage; a TV browses far fewer in a week.
          const kept = Object.entries(cache).filter(([p]) => p !== path).slice(-299);
          write(RATINGS_CACHE, Object.fromEntries([...kept, [path, { at: Date.now(), ratings }]]));
          return ratings;
        } catch {
          return [];
        }
      },
    },
  };
  return {
    bridge: stubbed(real, true) as unknown as WicabyBridge,
    // lib/images.ts setMediaBase: the server's own API base (the primary one without an id), or the demo's files.
    mediaBase: (serverId?: string) => {
      const s = find(serverId);
      return !s || s.address === DEMO_ADDRESS ? DEMO_BASE : apiBase(s);
    },
    playing: () => playback.value.active,
  };
}

// Any member the web app does not implement: `on*` subscriptions do nothing, calls fail with "Not available".
// top: a missing namespace (torrents, trakt…) is itself a stub.
function stubbed<T extends object>(obj: T, top = false): T {
  return new Proxy(obj, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return Reflect.get(target, key);
      const v = Reflect.get(target, key);
      if (v && typeof v === 'object') return stubbed(v);
      if (v !== undefined) return v;
      if (top) return stubbed({});
      if (/^on[A-Z]/.test(key)) return () => () => undefined;
      return () => Promise.reject(new Error(t('errors.web.notAvailable')));
    },
  });
}
