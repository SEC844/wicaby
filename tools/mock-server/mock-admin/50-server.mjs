// Mock admin: server settings, transcoding, plugins and catalogue, API keys and logs.
// Loaded by tools/mock-server/mock-emby.mjs. Everything lives in memory; restarting the mock resets it.
// Emby routes, plus the Jellyfin variants the UI uses for these sections (so a path
// typo shows up as a 404 either way). Under mock-jellyfin (or MOCK_ADMIN_FLAVOR=jellyfin) it returns a
// Jellyfin-shaped encoding configuration and plugin list (Status, CanUninstall).
import { randomUUID } from 'node:crypto';
import { DEMO_ADMIN } from '../demo/admin-demo.mjs';

const JF = process.env.MOCK_ADMIN_FLAVOR === 'jellyfin' || /mock-jellyfin/i.test(process.argv[1] ?? '');
const DAY = 86_400_000;
const now = Date.now();

function authed(req, q, tokens) {
  const token = req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(String(req.headers['x-emby-authorization'] ?? ''))?.[1];
  return token && tokens.has(token);
}

// ---- Configuration ----

let config = {
  ServerName: 'Wicaby Mock Emby',
  UICulture: 'fr',
  PreferredMetadataLanguage: 'fr',
  MetadataCountryCode: 'FR',
  CachePath: 'D:\\Emby\\cache',
  MetadataPath: 'D:\\Emby\\metadata',
  LogFileRetentionDays: 7,
  HttpServerPortNumber: 8096,
  HttpsPortNumber: 8920,
  PublicPort: 8096,
  PublicHttpsPort: 8920,
  EnableHttps: false,
  EnableRemoteAccess: true,
  WanDdns: 'media.example.org',
  EnableUPnP: false,
  LocalNetworkSubnets: ['192.168.1.0/24'],
  LocalNetworkAddresses: [],
  RemoteClientBitrateLimit: 0,
  IsStartupWizardCompleted: true,
  EnableAutomaticRestart: true,
  EnableDebugLevelLogging: false,
};

const embyEncoding = {
  EncodingThreadCount: -1,
  TranscodingTempPath: 'D:\\Emby\\transcoding-temp',
  DownMixAudioBoost: 2,
  EnableThrottling: true,
  ThrottleBufferSize: 120,
  H264Preset: 'veryfast',
  H264Crf: 23,
  EnableSubtitleExtraction: true,
  MaxConcurrentTranscodes: 4,
  EnableHardwareToneMapping: true,
  HardwareDecodingMode: 'Auto',
  CodecConfigurations: [
    { CodecId: 'qsv-h264-dec', IsEnabled: true, Priority: 10 },
    { CodecId: 'qsv-h264-enc', IsEnabled: true, Priority: 10 },
    { CodecId: 'qsv-hevc-dec', IsEnabled: false, Priority: 5 },
  ],
};

const jellyfinEncoding = {
  EncodingThreadCount: -1,
  TranscodingTempPath: '/var/lib/jellyfin/transcodes',
  FallbackFontPath: '',
  EnableFallbackFont: false,
  EnableAudioVbr: false,
  DownMixAudioBoost: 2,
  DownMixStereoAlgorithm: 'None',
  MaxMuxingQueueSize: 2048,
  EnableThrottling: false,
  ThrottleDelaySeconds: 180,
  EnableSegmentDeletion: false,
  SegmentKeepSeconds: 720,
  HardwareAccelerationType: 'vaapi',
  EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg',
  EncoderAppPathDisplay: '/usr/lib/jellyfin-ffmpeg/ffmpeg',
  VaapiDevice: '/dev/dri/renderD128',
  QsvDevice: '',
  EnableTonemapping: true,
  EnableVppTonemapping: false,
  TonemappingAlgorithm: 'bt2390',
  TonemappingMode: 'auto',
  TonemappingRange: 'auto',
  TonemappingDesat: 0,
  TonemappingPeak: 100,
  TonemappingParam: 0,
  H264Crf: 23,
  H265Crf: 28,
  EncoderPreset: 'auto',
  DeinterlaceDoubleRate: false,
  DeinterlaceMethod: 'yadif',
  EnableDecodingColorDepth10Hevc: true,
  EnableDecodingColorDepth10Vp9: true,
  EnableEnhancedNvdecDecoder: true,
  PreferSystemNativeHwDecoder: true,
  EnableHardwareEncoding: true,
  AllowHevcEncoding: false,
  AllowAv1Encoding: false,
  EnableSubtitleExtraction: true,
  HardwareDecodingCodecs: ['h264', 'hevc', 'vc1', 'vp9'],
  AllowOnDemandMetadataBasedKeyframeExtractionForExtensions: ['mkv'],
};

let encoding = structuredClone(JF ? jellyfinEncoding : embyEncoding);
const network = {
  BaseUrl: '',
  EnableHttps: false,
  RequireHttps: false,
  InternalHttpPort: 8096,
  InternalHttpsPort: 8920,
  PublicHttpPort: 8096,
  PublicHttpsPort: 8920,
  AutoDiscovery: true,
  EnableUPnP: false,
  EnableIPv4: true,
  EnableIPv6: false,
  EnableRemoteAccess: true,
  LocalNetworkSubnets: [],
  LocalNetworkAddresses: [],
  KnownProxies: [],
};

const codecInfo = [
  { Id: 'qsv-h264-dec', Name: 'Intel Quick Sync H.264', Description: 'Integrated GPU', IsHardwareCodec: true, Direction: 'Decoder', IsEnabledByDefault: true, DefaultPriority: 10, MediaTypeName: 'h264' },
  { Id: 'd3d11-hevc-dec', Name: 'DirectX 11 HEVC', Description: 'Integrated GPU', IsHardwareCodec: true, Direction: 'Decoder', IsEnabledByDefault: true, DefaultPriority: 10, MediaTypeName: 'hevc' },
  { Id: 'qsv-h264-enc', Name: 'Intel Quick Sync H.264', Description: 'Integrated GPU', IsHardwareCodec: true, Direction: 'Encoder', IsEnabledByDefault: true, DefaultPriority: 10, MediaTypeName: 'h264' },
  { Id: 'qsv-hevc-dec', Name: 'Intel Quick Sync HEVC', Description: 'Integrated GPU', IsHardwareCodec: true, Direction: 'Decoder', IsEnabledByDefault: true, DefaultPriority: 5, MediaTypeName: 'hevc' },
  { Id: 'sw-h264', Name: 'libx264', IsHardwareCodec: false, Direction: 'Encoder', IsEnabledByDefault: true, DefaultPriority: 0, MediaTypeName: 'h264' },
];

const uiCultures = [
  ['Français', 'fr'],
  ['English (United States)', 'en-US'],
  ['English (United Kingdom)', 'en-GB'],
  ['Deutsch', 'de'],
  ['Español', 'es'],
  ['Italiano', 'it'],
  ['日本語', 'ja'],
].map(([Name, Value]) => ({ Name, Value }));

// ---- Plugins and catalogue ----

const G = {
  trakt: '8abc6789fde24b0a9e1b8d6c1c4b3a21',
  opensubs: '4b9ed42ff5694c2db5cd2b9e1a0c0f10',
  tvdb: 'a677c0dafbd64b0c9d1e3f2a4b6c8e01',
  webhooks: '71552a5a5c5c4350a2aec1c2a0f2ab30',
  intro: 'c83d86bb0c534f5ba1b2c3d4e5f60718',
  tmdbbox: '1fc322a1e1e44d3c8b7a6f5e4d3c2b10',
  ldap: '958aad66b3b8441b9c4c5bd6c1c2d3e4',
};
let plugins = [
  { Id: G.opensubs, Name: 'Open Subtitles', Version: '1.4.2.0', Description: 'Télécharge des sous-titres depuis OpenSubtitles.com.', ConfigurationFileName: 'opensubtitles.xml', status: 'Active' },
  { Id: G.trakt, Name: 'Trakt', Version: '3.2.0.0', Description: 'Synchronise l’historique de lecture avec Trakt.tv.', ConfigurationFileName: 'trakt.xml', status: 'Active' },
  { Id: G.tvdb, Name: 'TheTVDB', Version: '2.0.1.0', Description: 'Métadonnées des séries depuis TheTVDB.', status: 'Active', canUninstall: false },
  { Id: G.webhooks, Name: 'Webhooks', Version: '1.1.0.0', Description: 'Envoie les événements du serveur vers des URL externes.', status: 'Disabled' },
];
const configPages = [
  { Name: 'OpenSubtitles', PluginId: G.opensubs, DisplayName: 'Open Subtitles' },
  { Name: 'Trakt', PluginId: G.trakt, DisplayName: 'Trakt' },
];
const pkg = (guid, name, category, shortDescription, versions, extra = {}) => ({
  guid,
  name,
  category,
  owner: 'Emby',
  shortDescription,
  overview: shortDescription,
  targetSystem: 'Server',
  type: 'UserInstalled',
  versions: versions.map((v) => ({ name, guid, versionStr: v, version: v, classification: 'Release', repositoryUrl: 'https://repo.example.org/manifest.json' })),
  ...extra,
});
const packages = [
  pkg(G.trakt, 'Trakt', 'Social', 'Synchronise l’historique de lecture avec Trakt.tv.', ['3.3.0.0', '3.2.0.0']),
  pkg(G.opensubs, 'Open Subtitles', 'Metadata', 'Télécharge des sous-titres depuis OpenSubtitles.com.', ['1.4.2.0']),
  pkg(G.tvdb, 'TheTVDB', 'Metadata', 'Métadonnées des séries depuis TheTVDB.', ['2.0.1.0']),
  pkg(G.webhooks, 'Webhooks', 'Notifications', 'Envoie les événements du serveur vers des URL externes.', ['1.1.0.0']),
  pkg(G.intro, 'Intro Skipper', 'General', 'Détecte les génériques d’ouverture et permet de les passer.', ['0.9.4.0', '0.9.3.0']),
  pkg(G.tmdbbox, 'TMDb Box Sets', 'Metadata', 'Crée automatiquement les collections de films depuis TMDb.', ['1.6.0.0']),
  pkg(G.ldap, 'LDAP Authentication', 'Authentication', 'Connexion des utilisateurs avec un annuaire LDAP.', ['2.1.0.0'], { isPremium: true }),
  pkg('5e1c2b3a4d5e6f708192a3b4c5d6e7f8', 'Kodi Sync Queue', 'General', 'Synchronise rapidement les bibliothèques Kodi.', ['2.0.0.0']),
  pkg('6f2d3c4b5a69788796a5b4c3d2e1f001', 'Cover Art Archive', 'Metadata', 'Pochettes d’albums depuis Cover Art Archive.', ['1.0.3.0']),
];
let repos = [
  { Name: 'Jellyfin Stable', Url: 'https://repo.jellyfin.org/files/plugin/manifest.json', Enabled: true },
  { Name: 'Intro Skipper', Url: 'https://intro-skipper.org/manifest.json', Enabled: false },
];

function pluginView(p) {
  const { status, canUninstall, ...rest } = p;
  return JF ? { ...rest, Status: status, CanUninstall: canUninstall !== false, HasImage: false } : rest;
}

// ---- API keys ----

const hex = () => randomUUID().replace(/-/g, '');
let keys = [
  { AccessToken: hex(), AppName: 'Home Assistant', DateCreated: new Date(now - 41 * DAY).toISOString(), DateLastActivity: new Date(now - 2 * 3600_000).toISOString(), IsActive: true },
  { AccessToken: hex(), AppName: 'Sonarr', DateCreated: new Date(now - 120 * DAY).toISOString(), DateLastActivity: new Date(now - 9 * DAY).toISOString(), IsActive: true },
];

// ---- Logs ----

const SOURCES = ['App', 'HttpServer', 'LibraryMonitor', 'TaskManager', 'MediaEncoder', 'SessionManager', 'Main', 'PluginManager'];
const MESSAGES = {
  Info: [
    'HTTP GET http://192.168.1.20:8096/emby/Users/u-wika/Items?ParentId=lib-movies. UserAgent: Wicaby/0.1',
    'Scheduled task "Scan media library" completed after 12 seconds',
    `Playback started: ${DEMO_ADMIN?.log.playing ?? 'Néon Fantôme'} on Living room (Wicaby)`,
    'Session ended for Wika on Office',
    `Refreshing metadata for "${DEMO_ADMIN?.log.refreshing ?? 'La Dernière Manche'}"`,
    'ffmpeg exited with code 0',
  ],
  Debug: [`Probing ${DEMO_ADMIN?.log.probe ?? '/media/movies/Clutch (2025)/Clutch.mkv'}`, 'Cache hit for image tag p', 'Websocket message received: KeepAlive'],
  Warn: ['Slow HTTP response: 2140 ms for /emby/Items/movie-3/Images/Primary', 'Library monitor: path not available, retrying', 'Plugin Webhooks is disabled; skipping event'],
  Error: ['Error processing request', 'Failed to fetch metadata from TheTVDB: The operation has timed out.'],
};
const stack = [
  '*** Error Report ***',
  'System.Net.Http.HttpRequestException: Connection refused (api.thetvdb.com:443)',
  '   at System.Net.Http.HttpConnectionPool.ConnectAsync(HttpRequestMessage request)',
  '   at Emby.Server.Implementations.HttpClientManager.SendAsyncInternal(HttpRequestOptions options)',
  '   at MediaBrowser.Providers.TV.TvdbSeriesProvider.GetMetadata(SeriesInfo info)',
];
function stamp(t) {
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function logLines(start, count, seed) {
  const out = [];
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < count; i++) {
    const x = rnd();
    const level = x < 0.02 ? 'Error' : x < 0.08 ? 'Warn' : x < 0.3 ? 'Debug' : 'Info';
    const list = MESSAGES[level];
    out.push(`${stamp(start + i * 4100)} ${level} ${SOURCES[Math.floor(rnd() * SOURCES.length)]}: ${list[Math.floor(rnd() * list.length)]}`);
    if (level === 'Error' && rnd() < 0.6) out.push(...stack);
  }
  return out;
}
const logStart = now - 3 * 3600_000;
const logs = [
  { Name: 'embyserver.txt', created: logStart, lines: logLines(logStart, 2400, 7) },
  { Name: 'embyserver-63894123000.txt', created: now - DAY, lines: logLines(now - DAY, 5200, 11) },
  { Name: 'embyserver-63894036600.txt', created: now - 2 * DAY, lines: logLines(now - 2 * DAY, 3100, 23) },
  { Name: 'ffmpeg-transcode-4b1f2c.txt', created: now - 40 * 60_000, lines: ['ffmpeg version 6.1-emby Copyright (c) 2000-2024', '  built with gcc 13.2', `Input #0, matroska,webm, from '${DEMO_ADMIN?.log.ffmpegInput ?? '/media/movies/Néon Fantôme.mkv'}':`, '  Duration: 01:58:12.04, start: 0.000000, bitrate: 42012 kb/s', 'Stream mapping:', '  Stream #0:0 -> #0:0 (hevc (hevc_qsv) -> h264 (h264_qsv))', 'frame= 2400 fps= 96 q=23.0 size=  48128kB time=00:01:40.10 bitrate=3938.4kbits/s speed=4.01x'] },
];
// The current log grows while the mock runs, so "follow" has something to show.
function grow() {
  const cur = logs[0];
  const last = cur.lastGrow ?? now;
  const add = Math.min(20, Math.floor((Date.now() - last) / 3000));
  if (add > 0) {
    cur.lines.push(...logLines(Date.now() - add * 3000, add, Date.now() % 9973));
    cur.lastGrow = Date.now();
  }
}
const logText = (l) => `${l.lines.join('\n')}\n`;
const logFile = (l) => ({ Name: l.Name, Size: Buffer.byteLength(logText(l)), DateCreated: new Date(l.created).toISOString(), DateModified: new Date(l === logs[0] ? Date.now() : Math.min(Date.now(), l.created + 3600_000)).toISOString() });

// ---- Router ----

export async function route({ req, res, p, parts, q, send, body, tokens }) {
  const lp = p.toLowerCase();
  const mine =
    lp.startsWith('/system/configuration') ||
    lp === '/localization/options' ||
    lp.startsWith('/encoding/codecinformation') ||
    lp.startsWith('/plugins') ||
    lp.startsWith('/packages') ||
    lp === '/repositories' ||
    lp.startsWith('/web/configurationpages') ||
    lp.startsWith('/auth/keys') ||
    lp.startsWith('/system/logs');
  if (!mine) return false;
  if (!authed(req, q, tokens)) return send(res, 401, 'Unauthorized', 'text/plain'), true;
  const M = req.method;
  const ok = () => (send(res, 204), true);
  const json = (v) => (send(res, 200, v), true);

  // Configuration
  if (lp === '/system/configuration') {
    if (M === 'GET') return json(config);
    if (M === 'POST') {
      config = { ...config, ...(await body(req)) };
      console.log('[admin] configuration saved');
      return ok();
    }
  }
  if (parts[0] === 'System' && parts[1] === 'Configuration' && parts[2]) {
    const key = parts[2].toLowerCase();
    if (M === 'GET') return json(key === 'encoding' ? encoding : key === 'network' ? network : {});
    if (M === 'POST') {
      const b = await body(req);
      if (key === 'encoding') encoding = b;
      else if (key === 'network') Object.assign(network, b);
      console.log(`[admin] configuration "${key}" saved`);
      return ok();
    }
  }
  if (lp === '/localization/options') return json(uiCultures);
  if (lp === '/encoding/codecinformation/video') return json(codecInfo);

  // Plugins
  if (lp === '/plugins' && M === 'GET') return json(plugins.map(pluginView));
  if (parts[0] === 'Plugins' && parts[1]) {
    const pl = plugins.find((x) => x.Id === parts[1]);
    if (!pl) return send(res, 404, 'Plugin not found', 'text/plain'), true;
    // Emby: DELETE /Plugins/{id} or POST /Plugins/{id}/Delete; Jellyfin: DELETE /Plugins/{id}/{version}.
    if ((M === 'DELETE' && parts.length <= 3) || (M === 'POST' && parts[2] === 'Delete')) {
      if (JF) pl.status = 'Deleted';
      else plugins = plugins.filter((x) => x !== pl);
      console.log(`[admin] plugin ${pl.Name} uninstalled`);
      return ok();
    }
    if (M === 'POST' && (parts[3] === 'Enable' || parts[3] === 'Disable')) {
      pl.status = parts[3] === 'Enable' ? 'Restart' : 'Disabled';
      return ok();
    }
  }
  if (lp === '/web/configurationpages') return json(configPages);

  // Catalogue
  if (lp === '/packages' && M === 'GET') return json(packages);
  if (parts[0] === 'Packages' && parts[1] === 'Installed' && parts[2] && M === 'POST') {
    const name = decodeURIComponent(parts[2]);
    const k = packages.find((x) => x.name === name);
    if (!k) return send(res, 404, 'Package not found', 'text/plain'), true;
    const version = q.get('Version') ?? q.get('version') ?? k.versions[0].versionStr;
    const existing = plugins.find((x) => x.Id === k.guid);
    if (existing) {
      existing.Version = version;
      existing.status = 'Restart';
    } else plugins.push({ Id: k.guid, Name: k.name, Version: version, Description: k.shortDescription, status: 'Restart' });
    console.log(`[admin] package ${name} ${version} installed`);
    return ok();
  }
  if (lp === '/repositories') {
    if (M === 'GET') return json(repos);
    if (M === 'POST') {
      repos = await body(req);
      return ok();
    }
  }

  // API keys
  if (lp === '/auth/keys') {
    if (M === 'GET') return json({ Items: keys, TotalRecordCount: keys.length });
    if (M === 'POST') {
      const app = q.get('App') ?? q.get('app');
      if (!app) return send(res, 400, 'App is required', 'text/plain'), true;
      keys.push({ AccessToken: hex(), AppName: app, DateCreated: new Date().toISOString(), IsActive: true });
      return ok();
    }
  }
  if (parts[0] === 'Auth' && parts[1] === 'Keys' && parts[2] && (M === 'DELETE' || (M === 'POST' && parts[3] === 'Delete'))) {
    keys = keys.filter((k) => k.AccessToken !== parts[2]);
    return ok();
  }

  // Logs
  if (lp === '/system/logs/query') {
    grow();
    return json({ Items: logs.map(logFile), TotalRecordCount: logs.length });
  }
  if (lp === '/system/logs') return grow(), json(logs.map(logFile));
  if (parts[0] === 'System' && parts[1] === 'Logs' && parts[2]) {
    const name = parts[2] === 'Log' ? q.get('name') : decodeURIComponent(parts[2]);
    const l = logs.find((x) => x.Name === name);
    if (!l) return send(res, 404, 'Log not found', 'text/plain'), true;
    if (l === logs[0]) grow();
    return send(res, 200, logText(l), 'text/plain; charset=utf-8'), true;
  }
  return false;
}
