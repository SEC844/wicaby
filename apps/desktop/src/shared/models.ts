// Subset of the Emby/Jellyfin BaseItemDto that Wicaby reads. Both servers share
// the MediaBrowser lineage, so field names match.

export interface UserData {
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  IsFavorite?: boolean;
  Played?: boolean;
  PlayedPercentage?: number;
  UnplayedItemCount?: number;
  LastPlayedDate?: string;
}

export interface MediaStream {
  Index: number;
  Type: 'Video' | 'Audio' | 'Subtitle' | 'EmbeddedImage' | 'Data' | string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  DeliveryMethod?: 'Encode' | 'Embed' | 'External' | 'Hls' | 'VideoSideData' | string;
  DeliveryUrl?: string;
  Width?: number;
  Height?: number;
  RealFrameRate?: number;
  AverageFrameRate?: number;
  BitRate?: number;
  VideoRange?: string;
  VideoRangeType?: string;
  ExtendedVideoType?: string;
  ExtendedVideoSubType?: string;
  ColorTransfer?: string;
  DvProfile?: number;
  DvBlSignalCompatibilityId?: number;
  Channels?: number;
  ChannelLayout?: string;
}

export interface MediaSource {
  Id: string;
  Name?: string;
  Path?: string;
  Protocol?: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  RunTimeTicks?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  TranscodingSubProtocol?: string;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  MediaStreams?: MediaStream[];
  // Live TV tuners: open with /LiveStreams/Open, then carry LiveStreamId everywhere.
  RequiresOpening?: boolean;
  OpenToken?: string;
  LiveStreamId?: string;
  Chapters?: ChapterInfo[];
}

export interface ChapterInfo {
  StartPositionTicks: number;
  Name?: string;
  ImageTag?: string;
  // Emby only: intro/credits markers are point entries mixed into Chapters.
  MarkerType?: 'Chapter' | 'IntroStart' | 'IntroEnd' | 'CreditsStart';
  ChapterIndex?: number;
}

// Jellyfin BaseItemDto.Trickplay entry.
export interface TrickplayInfo {
  Width: number;
  Height: number;
  TileWidth: number;
  TileHeight: number;
  ThumbnailCount: number;
  Interval: number;
}

export interface PersonInfo {
  Id: string;
  Name: string;
  Role?: string;
  Type?: string;
  PrimaryImageTag?: string;
}

export interface BaseItem {
  Id: string;
  Name: string;
  ServerId?: string;
  Type: string;
  // Imdb, Tmdb, Tvdb… (Fields=ProviderIds): the same title across servers.
  ProviderIds?: Record<string, string>;
  MediaType?: string;
  Path?: string;
  Container?: string;
  CollectionType?: string;
  IsFolder?: boolean;
  Overview?: string;
  Taglines?: string[];
  Genres?: string[];
  Studios?: { Name: string; Id?: string }[];
  ProductionYear?: number;
  PremiereDate?: string;
  // Virtual: a missing or not yet aired episode (nothing to play).
  LocationType?: string;
  EndDate?: string;
  OfficialRating?: string;
  CommunityRating?: number;
  CriticRating?: number;
  // Video frame size (Fields=Width,Height), for the card quality chip.
  Width?: number;
  Height?: number;
  RunTimeTicks?: number;
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  ParentId?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ChildCount?: number;
  RecursiveItemCount?: number;
  Status?: string;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ParentThumbItemId?: string;
  ParentThumbImageTag?: string;
  ParentLogoItemId?: string;
  ParentLogoImageTag?: string;
  SeriesPrimaryImageTag?: string;
  PrimaryImageAspectRatio?: number;
  UserData?: UserData;
  MediaSources?: MediaSource[];
  MediaStreams?: MediaStream[];
  Chapters?: ChapterInfo[];
  // Jellyfin: { mediaSourceId: { width: info } }.
  Trickplay?: Record<string, Record<string, TrickplayInfo>>;
  People?: PersonInfo[];
  // Trailers stored on the server next to the film, and links to online ones (YouTube).
  LocalTrailerCount?: number;
  RemoteTrailers?: { Url?: string; Name?: string }[];
  Album?: string;
  AlbumArtist?: string;
  Artists?: string[];
  // Fields=Etag,DateCreated (LIST_FIELDS): the version that keys generated comic covers.
  Etag?: string;
  DateCreated?: string;
  // Photo EXIF (photos spec §3.1), same names on both servers. Aperture and ShutterSpeed may be APEX values.
  CameraMake?: string;
  CameraModel?: string;
  Software?: string;
  ExposureTime?: number;
  FocalLength?: number;
  Aperture?: number;
  ShutterSpeed?: number;
  IsoSpeedRating?: number;
  Latitude?: number;
  Longitude?: number;
  Altitude?: number;
  ImageOrientation?: string;
  // Jellyfin only: { imageType: { tag: hash } }.
  ImageBlurHashes?: Record<string, Record<string, string>>;
}

export interface ItemsResult {
  Items: BaseItem[];
  TotalRecordCount: number;
  StartIndex?: number;
}

export interface PlaybackInfoResponse {
  MediaSources: MediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

export interface SystemInfoPublic {
  Id: string;
  ServerName: string;
  Version: string;
  ProductName?: string;
  LocalAddress?: string;
  WanAddress?: string;
  LocalAddresses?: string[];
  RemoteAddresses?: string[];
}

export interface AuthenticationResult {
  AccessToken: string;
  ServerId: string;
  User: {
    Id: string;
    Name: string;
    PrimaryImageTag?: string;
    Policy?: { IsAdministrator?: boolean };
  };
}

export interface UserDto {
  Id: string;
  Name: string;
  HasPassword?: boolean;
  HasConfiguredPassword?: boolean;
  PrimaryImageTag?: string;
  Policy?: { IsAdministrator?: boolean };
}
