// The PMS JSON fields the Plex dialect reads (developer.plex.tv PMS API, Accept: application/json). Only what
// the mappers use; PMS sends more, and any field may be missing (lenient parsing, Plezy #1589). Types only.

export interface PlexTag {
  id?: number | string;
  tag?: string;
  role?: string;
  thumb?: string;
}

export interface PlexStream {
  id: number;
  streamType: number; // 1 video, 2 audio, 3 subtitle, 4 lyrics
  index?: number;
  codec?: string;
  default?: boolean;
  selected?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  key?: string; // sidecar subtitle: /library/streams/{id}
  language?: string;
  languageCode?: string;
  languageTag?: string;
  title?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  channels?: number;
  audioChannelLayout?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  colorTrc?: string;
  colorPrimaries?: string;
  DOVIPresent?: boolean;
  DOVIProfile?: number;
  DOVIBLCompatID?: number;
}

export interface PlexPart {
  id: number;
  key?: string;
  duration?: number;
  file?: string;
  size?: number;
  container?: string;
  exists?: boolean;
  accessible?: boolean;
  indexes?: string;
  Stream?: PlexStream[];
}

export interface PlexMedia {
  id: number;
  duration?: number;
  bitrate?: number; // kbps
  width?: number;
  height?: number;
  videoResolution?: string;
  container?: string;
  editionTitle?: string;
  title?: string;
  Part?: PlexPart[];
}

export interface PlexMarker {
  type: string; // intro | credits | commercial
  startTimeOffset: number;
  endTimeOffset: number;
  final?: boolean;
}

export interface PlexMeta {
  ratingKey: string;
  key?: string;
  type: string;
  title?: string;
  titleSort?: string;
  originalTitle?: string;
  summary?: string;
  tagline?: string;
  year?: number;
  originallyAvailableAt?: string;
  contentRating?: string;
  audienceRating?: number;
  rating?: number;
  ratingImage?: string;
  audienceRatingImage?: string;
  duration?: number;
  index?: number;
  parentIndex?: number;
  parentRatingKey?: string;
  parentTitle?: string;
  parentThumb?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  librarySectionID?: number | string;
  childCount?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  viewCount?: number;
  viewOffset?: number;
  lastViewedAt?: number; // epoch seconds
  addedAt?: number; // epoch seconds
  updatedAt?: number;
  thumb?: string;
  art?: string;
  guid?: string;
  studio?: string;
  extraType?: number;
  editionTitle?: string;
  flattenSeasons?: number | string;
  playlistType?: string;
  smart?: boolean;
  allowSync?: boolean | number;
  playlistItemID?: number;
  subtype?: string;
  Guid?: { id?: string }[];
  Image?: { type?: string; url?: string }[];
  Rating?: { image?: string; value?: number; type?: string }[];
  Genre?: PlexTag[];
  Role?: PlexTag[];
  Director?: PlexTag[];
  Writer?: PlexTag[];
  Label?: PlexTag[];
  Media?: PlexMedia[];
  Marker?: PlexMarker[];
  Chapter?: { tag?: string; startTimeOffset?: number; endTimeOffset?: number; index?: number }[];
  Extras?: { size?: number; Metadata?: PlexMeta[] };
  // A show's next episode (includeOnDeck=1).
  OnDeck?: { Metadata?: PlexMeta[] };
}

export interface PlexSection {
  key: string;
  type: string; // movie | show | artist | photo
  title: string;
  thumb?: string;
  art?: string;
  hidden?: number | boolean;
}

export interface PlexHub {
  hubIdentifier?: string;
  key?: string;
  title?: string;
  type?: string;
  size?: number;
  more?: boolean | number;
  Metadata?: PlexMeta[];
}

export interface PlexContainer {
  size?: number;
  totalSize?: number;
  offset?: number;
  machineIdentifier?: string;
  Metadata?: PlexMeta[];
  Directory?: PlexSection[];
  Hub?: PlexHub[];
}
