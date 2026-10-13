// Mock Emby user and device administration (in memory, reset on restart).
// Users: Wika (the signed-in admin, mock-emby's USER object, shared so edits show
// everywhere), plus the dashboard's Léa, Marc and Enfants, and a disabled guest. Devices: a few fixed clients, and every client
// that calls the mock with a DeviceId in its auth header (Wicaby itself).
import { randomUUID } from 'node:crypto';

const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();

// Emby 4.9 UserPolicy defaults (fields from the 4.9.5 / 4.10.1 OpenAPI specs).
function policy(over = {}) {
  return {
    IsAdministrator: false,
    IsHidden: false,
    IsHiddenRemotely: true,
    IsHiddenFromUnusedDevices: false,
    IsDisabled: false,
    LockedOutDate: 0,
    AllowTagOrRating: false,
    BlockedTags: [],
    IsTagBlockingModeInclusive: false,
    IncludeTags: [],
    EnableUserPreferenceAccess: true,
    AccessSchedules: [],
    BlockUnratedItems: [],
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: true,
    EnableRemoteAccess: true,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: true,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: true,
    EnablePlaybackRemuxing: true,
    EnableContentDeletion: false,
    RestrictedFeatures: [],
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: true,
    EnableSubtitleDownloading: false,
    EnableSubtitleManagement: false,
    EnableSyncTranscoding: true,
    EnableMediaConversion: false,
    EnabledChannels: [],
    EnableAllChannels: true,
    EnabledFolders: [],
    EnableAllFolders: true,
    InvalidLoginAttemptCount: 0,
    EnablePublicSharing: false,
    RemoteClientBitrateLimit: 0,
    AuthenticationProviderId: 'Emby.Server.Implementations.Library.DefaultAuthenticationProvider',
    ExcludedSubFolders: [],
    SimultaneousStreamLimit: 0,
    EnabledDevices: [],
    EnableAllDevices: true,
    AllowCameraUpload: true,
    AllowSharingPersonalItems: true,
    ...over,
  };
}

// Library Guids for EnabledFolders (Emby keys policies by Guid, not by the numeric Id).
const FOLDERS = [
  { Name: 'Films', Id: '3', Guid: '5f0b1c2d3e4f40718293a4b5c6d7e801', CollectionType: 'movies' },
  { Name: 'Séries', Id: '4', Guid: '5f0b1c2d3e4f40718293a4b5c6d7e802', CollectionType: 'tvshows' },
  { Name: 'Bandes dessinées', Id: '5', Guid: '5f0b1c2d3e4f40718293a4b5c6d7e803', CollectionType: 'books' },
  { Name: 'Musique', Id: '6', Guid: '5f0b1c2d3e4f40718293a4b5c6d7e804', CollectionType: 'music' },
];

let users = null;
function store(USER) {
  if (users) return users;
  // Wika is mock-emby's own USER: fill in what the login mock leaves out.
  Object.assign(USER, {
    PrimaryImageTag: undefined,
    LastLoginDate: ago(3),
    LastActivityDate: ago(1),
    Policy: policy({ ...USER.Policy, IsAdministrator: true, EnableContentDeletion: true, EnableLiveTvManagement: true, EnableRemoteControlOfOtherUsers: true, EnableSubtitleManagement: true, EnableSubtitleDownloading: true, IsHiddenRemotely: false }),
    Configuration: { ...USER.Configuration, PlayDefaultAudioTrack: true, SubtitleMode: 'Smart' },
  });
  const mk = (Id, Name, extra, pol) => ({ Id, Name, HasPassword: true, HasConfiguredPassword: true, Configuration: { PlayDefaultAudioTrack: true, SubtitleMode: 'Default' }, Policy: policy(pol), ...extra });
  users = [
    USER,
    mk('u-lea', 'Léa', { PrimaryImageTag: 'lea1', LastLoginDate: ago(60 * 26), LastActivityDate: ago(45), ConnectUserName: 'lea.martin', ConnectLinkType: 'LinkedUser' }, { RemoteClientBitrateLimit: 20_000_000, EnableContentDeletion: false, EnableContentDeletionFromFolders: [FOLDERS[0].Guid] }),
    mk('u-kids', 'Enfants', { PrimaryImageTag: 'kids1', LastLoginDate: ago(60 * 24 * 3), LastActivityDate: ago(60 * 24 * 2) }, { EnableAllFolders: false, EnabledFolders: [FOLDERS[0].Guid, FOLDERS[2].Guid], MaxParentalRating: 10, BlockedTags: ['Horreur', 'Violence'], AccessSchedules: [{ DayOfWeek: 'Weekday', StartHour: 16, EndHour: 20 }, { DayOfWeek: 'Weekend', StartHour: 9, EndHour: 21 }], EnableRemoteAccess: false, EnableContentDownloading: false, SimultaneousStreamLimit: 1 }),
    mk('u-marc', 'Marc', { HasPassword: false, HasConfiguredPassword: false, LastLoginDate: ago(60 * 24 * 40), LastActivityDate: ago(60 * 24 * 38) }, { IsAdministrator: true, EnableContentDeletion: true }),
    mk('u-guest', 'Invité', { HasPassword: false, HasConfiguredPassword: false }, { IsDisabled: true, IsHidden: true, EnableRemoteAccess: false, EnableLiveTvAccess: false }),
  ];
  return users;
}

// TP-11: a user's live policy (the admin store's; Wika's is mock-emby's USER): mock-emby enforces its AccessSchedules
// per user, and POST /Mock/AccessSchedules?userId= edits them.
export function policyOf(USER, id) {
  return store(USER).find((u) => u.Id === id)?.Policy;
}

let devSeq = 100;
// Same clients as the dashboard's sessions (10-dashboard.mjs), keyed by the server's own Id.
const devices = [
  { Name: 'Living room · Shield TV', Id: '11', ReportedDeviceId: 'dev-shield', AppName: 'Emby for Android TV', AppVersion: '2.1.14', LastUserId: 'u-lea', LastUserName: 'Léa', DateLastActivity: ago(2), IpAddress: '192.0.2.21' },
  { Name: 'iPhone de Wika', Id: '12', ReportedDeviceId: 'dev-iphone', AppName: 'Emby for iOS', AppVersion: '2.2.30', LastUserId: 'u-wika', LastUserName: 'Wika', DateLastActivity: ago(9), IpAddress: '192.0.2.33' },
  { Name: 'Chrome · Windows', Id: '13', ReportedDeviceId: 'dev-chrome', AppName: 'Emby Web', AppVersion: '4.9.1.0', LastUserId: 'u-marc', LastUserName: 'Marc', DateLastActivity: ago(30), IpAddress: '192.0.2.10' },
  { Name: 'Bedroom · PC', Id: '14', ReportedDeviceId: 'dev-theater', AppName: 'Emby Theater', AppVersion: '3.0.20', LastUserId: 'u-kids', LastUserName: 'Enfants', DateLastActivity: ago(60 * 3), IpAddress: '192.0.2.40' },
  { Name: 'iPad de Léa', Id: '15', ReportedDeviceId: 'dev-ipad', AppName: 'Emby for iOS', AppVersion: '2.2.30', LastUserId: 'u-lea', LastUserName: 'Léa', DateLastActivity: ago(60 * 24 * 6), IpAddress: '192.0.2.52' },
];
const options = new Map([['11', { CustomName: 'Shield du salon' }]]);

function authInfo(req, q, tokens) {
  const header = String(req.headers['x-emby-authorization'] ?? req.headers.authorization ?? '');
  const token = req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(header)?.[1];
  const field = (k) => new RegExp(`${k}="([^"]*)"`).exec(header)?.[1];
  return { ok: Boolean(token && tokens.has(token)), deviceId: field('DeviceId'), client: field('Client'), version: field('Version'), device: field('Device') };
}

// The calling client shows up in the device list, like on a real server.
function touchDevice(a, USER) {
  if (!a.ok || !a.deviceId) return;
  let d = devices.find((x) => x.ReportedDeviceId === a.deviceId);
  if (!d) devices.push((d = { Name: a.device ?? 'Wicaby', Id: String(++devSeq), ReportedDeviceId: a.deviceId, IpAddress: '127.0.0.1' }));
  Object.assign(d, { AppName: a.client ?? d.AppName, AppVersion: a.version ?? d.AppVersion, LastUserId: USER.Id, LastUserName: USER.Name, DateLastActivity: new Date().toISOString() });
}

function avatarSvg(name, tag) {
  const hue = [...(tag ?? name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},18%,46%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},14%,24%)"/></linearGradient></defs><rect width="192" height="192" fill="url(#g)"/><circle cx="96" cy="78" r="34" fill="#fff" fill-opacity="0.82"/><path d="M28 192c6-44 34-64 68-64s62 20 68 64z" fill="#fff" fill-opacity="0.82"/></svg>`;
}

// Reference lists the user policy editor needs (parental ratings, channels).
const RATINGS = [
  ['FR-U', 1], ['FR-10', 10], ['FR-12', 12], ['FR-16', 16], ['FR-18', 18],
  ['G', 1], ['PG', 5], ['PG-13', 7], ['R', 9], ['NC-17', 10],
  ['TV-Y', 1], ['TV-PG', 5], ['TV-14', 7], ['TV-MA', 9],
].map(([Name, Value]) => ({ Name, Value }));

const CHANNELS = [
  { Id: 'chan-trailers', Name: 'Bandes-annonces', Type: 'Channel' },
  { Id: 'chan-podcasts', Name: 'Podcasts', Type: 'Channel' },
];

const strip = (u) => ({ ...u, Policy: { ...u.Policy }, ServerId: undefined });

export async function route({ req, res, p, parts, q, send, body, tokens, USER, SERVER_ID }) {
  const list = store(USER);
  const a = authInfo(req, q, tokens);
  touchDevice(a, USER);
  const reply = (status, b, type) => (send(res, status, b, type), true);
  const M = req.method;
  const isUsers = parts[0] === 'Users';
  const isDevices = parts[0] === 'Devices';
  const isLib = p === '/Library/SelectableMediaFolders';

  // Avatars are served without auth (img tags carry no header in the real server either).
  if (isUsers && parts[2] === 'Images' && parts[3] === 'Primary' && M === 'GET') {
    const u = list.find((x) => x.Id === parts[1]);
    if (!u?.PrimaryImageTag) return reply(404, '', 'text/plain');
    return reply(200, avatarSvg(u.Name, u.PrimaryImageTag), 'image/svg+xml');
  }

  if (M === 'GET' && p === '/Localization/ParentalRatings') return reply(200, RATINGS);
  if (M === 'GET' && p === '/Channels') return reply(200, { Items: CHANNELS, TotalRecordCount: CHANNELS.length });

  // Only the admin routes below; everything else falls through to mock-emby.
  // Per-user routes only for ids in the store: /Users/AuthenticateByName, /Users/Public, /Users/Me…
  // and Wika's own GET /Users/{id} stay with mock-emby.
  const known = isUsers && list.some((x) => x.Id === parts[1]);
  const userAdmin =
    isUsers &&
    ((parts.length === 1 && M === 'GET') ||
      (p === '/Users/Query' && M === 'GET') ||
      (p === '/Users/New' && M === 'POST') ||
      (known &&
        ((parts.length === 2 && (M === 'DELETE' || M === 'POST' || (M === 'GET' && parts[1] !== USER.Id))) ||
          (parts.length === 3 && ['Policy', 'Configuration', 'Password', 'Delete'].includes(parts[2])) ||
          (parts[2] === 'Connect' && parts[3] === 'Link') ||
          (parts[2] === 'Images' && M !== 'GET'))));
  if (!userAdmin && !isDevices && !isLib) return false;
  if (!a.ok) return reply(401, 'Unauthorized', 'text/plain');
  if (!USER.Policy?.IsAdministrator && !(M === 'GET' && parts.length === 2)) return reply(403, 'Forbidden', 'text/plain');

  if (isLib) return reply(200, FOLDERS.map((f) => ({ ...f, SubFolders: [], IsUserAccessConfigurable: true })));

  // ---- Users ----
  if (isUsers) {
    if (parts.length === 1) return reply(200, list.map(strip));
    if (p === '/Users/Query') return reply(200, { Items: list.map(strip), TotalRecordCount: list.length });
    if (p === '/Users/New' && M === 'POST') {
      const b = await body(req);
      const name = String(b.Name ?? '').trim();
      if (!name) return reply(400, 'Name is required', 'text/plain');
      if (list.some((u) => u.Name.toLowerCase() === name.toLowerCase())) return reply(400, `A user with the name '${name}' already exists.`, 'text/plain');
      const src = list.find((u) => u.Id === b.CopyFromUserId);
      const opts = b.UserCopyOptions ?? [];
      const u = {
        Id: `u-${randomUUID().slice(0, 8)}`,
        Name: name,
        HasPassword: false,
        HasConfiguredPassword: false,
        Configuration: src && opts.includes('UserConfiguration') ? structuredClone(src.Configuration) : { PlayDefaultAudioTrack: true, SubtitleMode: 'Default' },
        Policy: src && opts.includes('UserPolicy') ? structuredClone(src.Policy) : policy(),
      };
      list.push(u);
      return reply(200, strip(u));
    }
    const u = list.find((x) => x.Id === parts[1]);
    if (!u) return reply(404, 'User not found', 'text/plain');
    const rest = parts.slice(2);
    if (rest.length === 0 && M === 'GET') return reply(200, strip(u));
    if ((rest.length === 0 && M === 'DELETE') || (rest[0] === 'Delete' && M === 'POST')) {
      if (u.Id === USER.Id) return reply(400, 'You cannot delete your own account.', 'text/plain');
      if (u.Policy.IsAdministrator && list.filter((x) => x.Policy.IsAdministrator && !x.Policy.IsDisabled && x.Id !== u.Id).length === 0) return reply(400, 'At least one administrator is required.', 'text/plain');
      list.splice(list.indexOf(u), 1);
      return reply(204);
    }
    if (rest.length === 0 && M === 'POST') {
      const b = await body(req);
      const name = String(b.Name ?? '').trim();
      if (!name) return reply(400, 'Name is required', 'text/plain');
      if (list.some((x) => x.Id !== u.Id && x.Name.toLowerCase() === name.toLowerCase())) return reply(400, `A user with the name '${name}' already exists.`, 'text/plain');
      u.Name = name;
      for (const d of devices) if (d.LastUserId === u.Id) d.LastUserName = name;
      return reply(204);
    }
    if (rest[0] === 'Policy' && M === 'POST') {
      const b = await body(req);
      const admins = list.filter((x) => x.Id !== u.Id && x.Policy.IsAdministrator && !x.Policy.IsDisabled);
      if (u.Policy.IsAdministrator && (!b.IsAdministrator || b.IsDisabled) && admins.length === 0) return reply(400, 'At least one enabled administrator is required.', 'text/plain');
      u.Policy = { ...u.Policy, ...b };
      return reply(204);
    }
    if (rest[0] === 'Configuration' && M === 'POST') {
      u.Configuration = { ...u.Configuration, ...(await body(req)) };
      return reply(204);
    }
    if (rest[0] === 'Password' && M === 'POST') {
      const b = await body(req);
      if (b.ResetPassword) {
        u.HasPassword = u.HasConfiguredPassword = false;
        return reply(204);
      }
      if (u.Id === USER.Id && u.HasPassword && b.CurrentPw !== 'wicaby') return reply(400, 'Invalid user or password entered.', 'text/plain');
      u.HasPassword = u.HasConfiguredPassword = Boolean(b.NewPw);
      return reply(204);
    }
    if (rest[0] === 'Connect' && rest[1] === 'Link') {
      if (M === 'POST' && !rest[2]) {
        const name = q.get('ConnectUsername') ?? '';
        if (!name) return reply(400, 'ConnectUsername is required', 'text/plain');
        u.ConnectUserName = name;
        u.ConnectLinkType = 'LinkedUser';
        return reply(200, { IsPending: name.includes('@'), IsNewUserInvitation: false, GuestDisplayName: name });
      }
      if (M === 'DELETE' || rest[2] === 'Delete') {
        delete u.ConnectUserName;
        delete u.ConnectLinkType;
        return reply(204);
      }
    }
    if (rest[0] === 'Images' && rest[1] === 'Primary') {
      if (M === 'DELETE' || rest[2] === 'Delete') {
        delete u.PrimaryImageTag;
        return reply(204);
      }
      if (M === 'POST') {
        u.PrimaryImageTag = randomUUID().slice(0, 6);
        return reply(204);
      }
    }
    return reply(404, 'Not found', 'text/plain');
  }

  // ---- Devices ----
  if (isDevices) {
    const id = q.get('Id') ?? q.get('id');
    if (parts.length === 1 && M === 'GET') {
      const items = devices.map((d) => ({ ...d, Name: options.get(d.Id)?.CustomName || d.Name }));
      return reply(200, { Items: items, TotalRecordCount: items.length });
    }
    const d = devices.find((x) => x.Id === id);
    if (!d) return reply(404, 'Device not found', 'text/plain');
    if (parts[1] === 'Info' && M === 'GET') return reply(200, { ...d, Name: options.get(d.Id)?.CustomName || d.Name });
    if (parts[1] === 'Options') {
      if (M === 'GET') return reply(200, { CustomName: options.get(d.Id)?.CustomName ?? '' });
      if (M === 'POST') {
        const b = await body(req);
        options.set(d.Id, { CustomName: String(b.CustomName ?? '') });
        return reply(204);
      }
    }
    if ((parts.length === 1 && M === 'DELETE') || (parts[1] === 'Delete' && M === 'POST')) {
      devices.splice(devices.indexOf(d), 1);
      options.delete(d.Id);
      return reply(204);
    }
    return reply(404, 'Not found', 'text/plain');
  }
  return false;
}
