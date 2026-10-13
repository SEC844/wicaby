import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, type Query, type WicabyBridge } from '../shared/contract';

// Strips Electron's "Error invoking remote method 'x': Error: " wrapper so the
// UI can show the main-process message as is.
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, ''));
  }
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: WicabyBridge = {
  app: {
    info: () => invoke(Channels.appInfo),
    quit: () => invoke(Channels.appQuit),
    openExternal: (url) => invoke(Channels.appOpenExternal, url),
    openPath: (kind) => invoke(Channels.appOpenPath, kind),
    log: (level, message) => ipcRenderer.send(Channels.appLog, level, String(message).slice(0, 8000)),
    storage: () => invoke(Channels.appStorage),
    clearStorage: (kind) => invoke(Channels.appClearStorage, kind),
  },
  window: {
    minimize: () => invoke(Channels.windowMinimize),
    toggleMaximize: () => invoke(Channels.windowToggleMaximize),
    close: () => invoke(Channels.windowClose),
    toggleFullscreen: () => invoke(Channels.windowToggleFullscreen),
    getState: () => invoke(Channels.windowGetState),
    onState: (cb) => on(Channels.windowState, cb),
    mini: (action) => invoke(Channels.windowMini, action),
  },
  settings: {
    get: () => invoke(Channels.settingsGet),
    update: (patch) => invoke(Channels.settingsUpdate, patch),
    pickFolder: () => invoke(Channels.settingsPickFolder),
    pickMpv: () => invoke(Channels.settingsPickMpv),
    onChange: (cb) => on(Channels.settingsChanged, cb),
    audioDevices: () => invoke(Channels.settingsAudioDevices),
    exportFile: () => invoke(Channels.settingsExport),
    importFile: () => invoke(Channels.settingsImport),
    reset: () => invoke(Channels.settingsReset),
  },
  servers: {
    discover: () => invoke(Channels.serversDiscover),
    list: () => invoke(Channels.serversList),
    add: (address) => invoke(Channels.serversAdd, address),
    embyConnect: (username, password) => invoke(Channels.serversEmbyConnect, username, password),
    select: (id) => invoke(Channels.serversSelect, id),
    remove: (id) => invoke(Channels.serversRemove, id),
    wake: (id) => invoke(Channels.serversWake, id),
    plexLink: () => invoke(Channels.serversPlexLink),
    plexPoll: () => invoke(Channels.serversPlexPoll),
    plexAccounts: () => invoke(Channels.serversPlexAccounts),
    plexUnlink: (accountId) => invoke(Channels.serversPlexUnlink, accountId),
    plexSetHidden: (id, hidden) => invoke(Channels.serversPlexSetHidden, id, hidden),
    plexConfirm: (id, address) => invoke(Channels.serversPlexConfirm, id, address),
  },
  session: {
    get: () => invoke(Channels.sessionGet),
    publicUsers: (serverId) => invoke(Channels.sessionPublicUsers, serverId),
    login: (username, password, serverId) => invoke(Channels.sessionLogin, username, password, serverId),
    logout: (serverId) => invoke(Channels.sessionLogout, serverId),
    disconnect: (serverId) => invoke(Channels.sessionDisconnect, serverId),
    onChange: (cb) => on(Channels.sessionChanged, cb),
  },
  api: {
    get: <T>(path: string, query?: Query, serverId?: string) => invoke<T>(Channels.apiRequest, 'GET', path, query, undefined, serverId),
    post: <T>(path: string, query?: Query, body?: unknown, serverId?: string) => invoke<T>(Channels.apiRequest, 'POST', path, query, body, serverId),
    del: <T>(path: string, query?: Query, serverId?: string) => invoke<T>(Channels.apiRequest, 'DELETE', path, query, undefined, serverId),
    put: <T>(path: string, query?: Query, body?: unknown, serverId?: string) => invoke<T>(Channels.apiRequest, 'PUT', path, query, body, serverId),
    uploadImage: (itemId, type, mime, data, serverId) => invoke(Channels.apiUploadImage, itemId, type, mime, data, serverId),
  },
  files: {
    list: () => invoke(Channels.filesList),
    test: (input) => invoke(Channels.filesTest, input),
    add: (input) => invoke(Channels.filesAdd, input),
    remove: (id) => invoke(Channels.filesRemove, id),
    rename: (id, name) => invoke(Channels.filesRename, id, name),
    setCredentials: (id, user, pass, domain, insecure) => invoke(Channels.filesSetCredentials, id, user, pass, domain, insecure),
    trustCert: (id, sha256) => invoke(Channels.filesTrustCert, id, sha256),
    discover: () => invoke(Channels.filesDiscover),
    pickFolder: () => invoke(Channels.filesPickFolder),
    refresh: (id) => invoke(Channels.filesRefresh, id),
  },
  playback: {
    play: (request) => invoke(Channels.playbackPlay, request),
    command: (command) => invoke(Channels.playbackCommand, command),
    getState: () => invoke(Channels.playbackGetState),
    onState: (cb) => on(Channels.playbackState, cb),
  },
  music: {
    lrclib: (track) => invoke(Channels.musicLrclib, track),
  },
  htmlPlayer: {
    onLoad: (cb) => on(Channels.htmlPlayerLoad, cb),
    onCommand: (cb) => on(Channels.htmlPlayerCommand, cb),
    emit: (event) => ipcRenderer.send(Channels.htmlPlayerEvent, event),
  },
  downloads: {
    list: () => invoke(Channels.downloadsList),
    add: (itemIds, serverId) => invoke(Channels.downloadsAdd, itemIds, serverId),
    pause: (id) => invoke(Channels.downloadsPause, id),
    resume: (id) => invoke(Channels.downloadsResume, id),
    remove: (id) => invoke(Channels.downloadsRemove, id),
    reveal: (id) => invoke(Channels.downloadsReveal, id),
    onChange: (cb) => on(Channels.downloadsChanged, cb),
  },
  photos: {
    keepAwake: (on) => invoke(Channels.photosKeepAwake, on),
    immich: {
      sources: () => invoke(Channels.immichSources),
      onSources: (cb) => on(Channels.immichChanged, cb),
      test: (url, key) => invoke(Channels.immichTest, url, key),
      add: (url, key) => invoke(Channels.immichAdd, url, key),
      remove: (id) => invoke(Channels.immichRemove, id),
      request: (id, method, path, query, body) => invoke(Channels.immichRequest, id, method, path, query, body),
      saveOriginal: (id, assetId) => invoke(Channels.immichSaveOriginal, id, assetId),
    },
  },
  comics: {
    open: (itemId, serverId) => invoke(Channels.comicsOpen, itemId, serverId),
    saveProgress: (itemId, page, pageCount, serverId) => invoke(Channels.comicsSaveProgress, itemId, page, pageCount, serverId),
  },
  vpn: {
    status: () => invoke(Channels.vpnStatus),
    connect: (kind, options) => invoke(Channels.vpnConnect, kind, options),
    peers: (kind, withServers) => invoke(Channels.vpnPeers, kind, withServers),
    diagnostics: () => invoke(Channels.vpnDiagnostics),
    embedded: {
      status: () => invoke(Channels.vpnEmbeddedStatus),
      logout: () => invoke(Channels.vpnEmbeddedLogout),
      turnOff: () => invoke(Channels.vpnEmbeddedTurnOff),
      onChange: (cb) => on(Channels.vpnEmbeddedChanged, cb),
    },
  },
  torrents: {
    state: () => invoke(Channels.torrentsState),
    onState: (cb) => on(Channels.torrentsChanged, cb),
    watch: (mode) => invoke(Channels.torrentsWatch, mode),
    test: (config) => invoke(Channels.torrentsTest, config),
    configure: (config) => invoke(Channels.torrentsConfigure, config),
    forget: () => invoke(Channels.torrentsForget),
    trustCertificate: (host, fingerprint) => invoke(Channels.torrentsTrustCert, host, fingerprint),
    add: (request) => invoke(Channels.torrentsAdd, request),
    action: (hashes, action) => invoke(Channels.torrentsAction, hashes, action),
    remove: (hashes, deleteFiles) => invoke(Channels.torrentsRemove, hashes, deleteFiles),
    setCategory: (hashes, category) => invoke(Channels.torrentsSetCategory, hashes, category),
    toggleAltSpeed: () => invoke(Channels.torrentsToggleAltSpeed),
    clipboardMagnet: () => invoke(Channels.torrentsClipboardMagnet),
    takeMagnet: () => invoke(Channels.torrentsTakeMagnet),
    onMagnet: (cb) => on(Channels.torrentsMagnet, () => cb()),
  },
  trakt: {
    state: () => invoke(Channels.traktState),
    onState: (cb) => on(Channels.traktChanged, cb),
    connect: (clientId, clientSecret) => invoke(Channels.traktConnect, clientId, clientSecret),
    cancel: () => invoke(Channels.traktCancel),
    disconnect: () => invoke(Channels.traktDisconnect),
  },
  reminders: {
    list: () => invoke(Channels.remindersList),
    toggle: (r) => invoke(Channels.remindersToggle, r),
    stay: () => invoke(Channels.remindersStay),
    onCountdown: (cb) => on(Channels.remindersCountdown, cb),
  },
  cast: {
    targets: (itemId, serverId) => invoke(Channels.castTargets, itemId, serverId),
    onTargets: (cb) => on(Channels.castTargetsUpdated, cb),
    start: (targetKey, options) => invoke(Channels.castStart, targetKey, options),
    control: (command) => invoke(Channels.castControl, command),
    stop: () => invoke(Channels.castStop),
    takeBack: () => invoke(Channels.castTakeBack),
    getState: () => invoke(Channels.castGetState),
    onState: (cb) => on(Channels.castState, cb),
  },
  events: {
    onServerEvent: (cb) => on(Channels.serverEvent, cb),
    onNavigate: (cb) => on(Channels.navigate, cb),
    onToast: (cb) => on(Channels.toast, cb),
  },
};

contextBridge.exposeInMainWorld('wicaby', bridge);
