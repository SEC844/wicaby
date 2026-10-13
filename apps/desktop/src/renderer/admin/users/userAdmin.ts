// User and device administration over the IPC API proxy, for one server.
// Emby and Jellyfin share most paths; where Jellyfin 10.9+ moved a route to
// userId-as-query (the /Users/{id}/… form is obsolete there), the kind picks it.
import type { Query, ServerKind } from '../../../shared/contract';
import { w } from '../../lib/bridge';
import { sessionFor } from '../../lib/stores.svelte';

// Policy fields are a superset of both servers; each one only sends what it knows,
// and the editor posts back the object it read, so unknown fields survive.
export interface UserPolicy {
  IsAdministrator: boolean;
  IsHidden: boolean;
  IsHiddenRemotely?: boolean;
  IsHiddenFromUnusedDevices?: boolean;
  IsDisabled: boolean;
  MaxParentalRating?: number | null;
  BlockedTags?: string[];
  AllowedTags?: string[];
  IsTagBlockingModeInclusive?: boolean;
  IncludeTags?: string[];
  // Sign-in windows (none = any time). DayOfWeek: Sunday…Saturday, Everyday, Weekday, Weekend;
  // hours 0–24 as decimals. Jellyfin adds Id and UserId and fills them itself.
  AccessSchedules?: AccessSchedule[];
  EnableUserPreferenceAccess?: boolean;
  EnableRemoteControlOfOtherUsers?: boolean;
  EnableSharedDeviceControl?: boolean;
  EnableRemoteAccess?: boolean;
  EnableLiveTvManagement?: boolean;
  EnableLiveTvAccess?: boolean;
  EnableMediaPlayback?: boolean;
  EnableAudioPlaybackTranscoding?: boolean;
  EnableVideoPlaybackTranscoding?: boolean;
  EnablePlaybackRemuxing?: boolean;
  ForceRemoteSourceTranscoding?: boolean;
  EnableContentDeletion?: boolean;
  EnableContentDeletionFromFolders?: string[];
  EnableContentDownloading?: boolean;
  EnableSubtitleDownloading?: boolean;
  EnableSubtitleManagement?: boolean;
  EnableLyricManagement?: boolean;
  EnableCollectionManagement?: boolean;
  EnableSyncTranscoding?: boolean;
  EnableMediaConversion?: boolean;
  EnablePublicSharing?: boolean;
  AllowCameraUpload?: boolean;
  AllowSharingPersonalItems?: boolean;
  EnabledChannels?: string[];
  EnableAllChannels?: boolean;
  EnabledFolders?: string[];
  EnableAllFolders?: boolean;
  EnabledDevices?: string[];
  EnableAllDevices?: boolean;
  InvalidLoginAttemptCount?: number;
  LoginAttemptsBeforeLockout?: number;
  MaxActiveSessions?: number;
  SimultaneousStreamLimit?: number;
  RemoteClientBitrateLimit?: number;
  SyncPlayAccess?: string;
  AuthenticationProviderId?: string;
  PasswordResetProviderId?: string;
  [key: string]: unknown;
}

export interface AccessSchedule {
  DayOfWeek: string;
  StartHour: number;
  EndHour: number;
}

export interface UserDto {
  Id: string;
  Name: string;
  ServerId?: string;
  HasPassword?: boolean;
  HasConfiguredPassword?: boolean;
  PrimaryImageTag?: string;
  LastLoginDate?: string;
  LastActivityDate?: string;
  ConnectUserName?: string;
  ConnectLinkType?: string;
  Policy: UserPolicy;
  Configuration?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeviceInfo {
  Id: string;
  Name: string;
  CustomName?: string;
  ReportedDeviceId?: string;
  AppName?: string;
  AppVersion?: string;
  LastUserName?: string;
  LastUserId?: string;
  DateLastActivity?: string;
  IpAddress?: string;
  IconUrl?: string;
  Capabilities?: { SupportsMediaControl?: boolean; SupportsPersistentIdentifier?: boolean; PlayableMediaTypes?: string[] };
}

// A library as a policy list stores it.
export interface Library {
  id: string;
  name: string;
}

export interface NamedId {
  Id: string;
  Name: string;
}

export interface ParentalRating {
  Name: string;
  Value: number;
}

export type AdminApi = ReturnType<typeof adminApi>;

export function adminApi(serverId: string) {
  const kind: ServerKind = sessionFor(serverId)?.server.kind ?? 'emby';
  const jf = kind === 'jellyfin';
  const get = <T>(path: string, query?: Query) => w.api.get<T>(path, query, serverId);
  const post = <T = void>(path: string, query?: Query, body?: unknown) => w.api.post<T>(path, query, body, serverId);
  const del = (path: string, query?: Query) => w.api.del<void>(path, query, serverId);

  return {
    kind,
    me: () => sessionFor(serverId)?.user?.id,

    // Emby 4.7.5+ only documents /Users/Query; Jellyfin only has /Users.
    users: async () => {
      let list: UserDto[];
      if (jf) list = await get<UserDto[]>('/Users');
      else list = await get<{ Items: UserDto[] }>('/Users/Query').then((r) => r.Items ?? [], () => get<UserDto[]>('/Users'));
      return list.sort((a, b) => a.Name.localeCompare(b.Name));
    },
    user: (id: string) => get<UserDto>(`/Users/${id}`),

    // Emby copies policy and configuration server-side; Jellyfin takes the password at
    // creation and gets the copy as a second call.
    async create(name: string, password: string, copyFrom: UserDto | null): Promise<UserDto> {
      if (jf) {
        const user = await post<UserDto>('/Users/New', undefined, { Name: name, Password: password || undefined });
        if (copyFrom) {
          const policy = { ...copyFrom.Policy, AuthenticationProviderId: user.Policy.AuthenticationProviderId, PasswordResetProviderId: user.Policy.PasswordResetProviderId };
          await post(`/Users/${user.Id}/Policy`, undefined, policy);
          if (copyFrom.Configuration) await post('/Users/Configuration', { userId: user.Id }, copyFrom.Configuration);
        }
        return user;
      }
      const user = await post<UserDto>('/Users/New', undefined, {
        Name: name,
        CopyFromUserId: copyFrom?.Id,
        UserCopyOptions: copyFrom ? ['UserPolicy', 'UserConfiguration'] : undefined,
      });
      if (password) await post(`/Users/${user.Id}/Password`, undefined, { Id: user.Id, CurrentPw: '', NewPw: password, ResetPassword: false });
      return user;
    },

    remove: (id: string) => del(`/Users/${id}`),

    // The whole DTO goes back; only Name changes.
    rename: (user: UserDto, name: string) => (jf ? post('/Users', { userId: user.Id }, { ...user, Name: name }) : post(`/Users/${user.Id}`, undefined, { ...user, Name: name })),

    // current: only when changing one's own password.
    setPassword: (id: string, next: string, current = '') =>
      jf
        ? post('/Users/Password', { userId: id }, { CurrentPw: current, NewPw: next, ResetPassword: false })
        : post(`/Users/${id}/Password`, undefined, { Id: id, CurrentPw: current, NewPw: next, ResetPassword: false }),
    resetPassword: (id: string) => (jf ? post('/Users/Password', { userId: id }, { ResetPassword: true }) : post(`/Users/${id}/Password`, undefined, { Id: id, ResetPassword: true })),

    savePolicy: (id: string, policy: UserPolicy) => post(`/Users/${id}/Policy`, undefined, policy),

    removeAvatar: (id: string) => (jf ? del('/UserImage', { userId: id }) : del(`/Users/${id}/Images/Primary`)),

    // Emby Connect (Emby only).
    linkConnect: (id: string, connectUser: string) => post<{ IsPending?: boolean; IsNewUserInvitation?: boolean; GuestDisplayName?: string }>(`/Users/${id}/Connect/Link`, { ConnectUsername: connectUser }),
    unlinkConnect: (id: string) => del(`/Users/${id}/Connect/Link`),

    // EnabledFolders holds the library Guid on Emby (its Id is a numeric database id since
    // 4.8) and the library item id on Jellyfin. Both lists are what the servers' own web UIs use.
    libraries: async (): Promise<Library[]> => {
      if (jf) {
        const r = await get<{ Items: NamedId[] }>('/Library/MediaFolders', { isHidden: false });
        return (r.Items ?? []).map((f) => ({ id: f.Id, name: f.Name }));
      }
      const r = await get<{ Name: string; Id: string; Guid?: string }[]>('/Library/SelectableMediaFolders');
      return (r ?? []).map((f) => ({ id: f.Guid ?? f.Id, name: f.Name }));
    },
    channels: async () => (await get<{ Items: NamedId[] }>('/Channels')).Items ?? [],
    ratings: () => get<ParentalRating[]>('/Localization/ParentalRatings'),

    devices: async () => (await get<{ Items: DeviceInfo[] }>('/Devices')).Items ?? [],
    // Emby's DeviceInfo has no CustomName: it lives in the options.
    deviceOptions: (id: string) => get<{ CustomName?: string }>('/Devices/Options', jf ? { id } : { Id: id }),
    // Emby (4.8+) keys options and deletion by the server's own Id, not ReportedDeviceId;
    // on Jellyfin Id is the device id the client reports.
    renameDevice: (id: string, customName: string) => post('/Devices/Options', jf ? { id } : { Id: id }, { CustomName: customName }),
    removeDevice: (id: string) => del('/Devices', jf ? { id } : { Id: id }),
  };
}

// Enabled admins that are not disabled; deleting or demoting the last one locks the server.
export function activeAdmins(users: UserDto[]): UserDto[] {
  return users.filter((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled);
}
