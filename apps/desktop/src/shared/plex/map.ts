// PMS JSON → Emby-shaped DTOs (plex-spec §4): the Plex dialect answers the renderer and the playback service
// with the BaseItem / ItemsResult / MediaSource shapes they already read, so no Plex shape crosses IPC.
// Pure and erasable TypeScript (no Node, no Electron): tools/checks/plex-map-check.mjs runs it against
// tools/checks/fixtures/plex/vectors.json, which the Android twin (PX-13) will replay.
import type { SubtitleMode } from '../contract';
import type { BaseItem, ChapterInfo, ItemsResult, MediaSource, MediaStream, UserData } from '../models';
import { providerIds } from './guid';
import { imageTag } from './images';
import type { PlexContainer, PlexHub, PlexMedia, PlexMeta, PlexPart, PlexSection, PlexStream, PlexTag } from './types';

// Plex times are milliseconds, Emby ticks 100 ns.
export const TICKS_PER_MS = 10_000;
export const msToTicks = (ms: number | undefined): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms * TICKS_PER_MS) : undefined);
export const ticksToMs = (ticks: number | string | undefined): number => {
  const n = Number(ticks);
  return Number.isFinite(n) && n > 0 ? Math.round(n / TICKS_PER_MS) : 0;
};
export const epochToIso = (s: number | undefined): string | undefined => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : undefined);

// Ids. A ratingKey is decimal; sections and people get a prefix so they never collide with one, and every
// id still passes validId ([A-Za-z0-9-]{1,64}).
export const sectionId = (key: string | number): string => `section-${key}`;
export const personId = (id: string | number): string => `person-${id}`;
export function parseId(id: string): { kind: 'item' | 'section' | 'person'; key: string } | null {
  const m = /^(?:(section|person)-)?(\d{1,20})$/.exec(id);
  return m ? { kind: (m[1] ?? 'item') as 'item' | 'section' | 'person', key: m[2] } : null;
}

const TYPES: Readonly<Record<string, string>> = {
  movie: 'Movie',
  show: 'Series',
  season: 'Season',
  episode: 'Episode',
  artist: 'MusicArtist',
  album: 'MusicAlbum',
  track: 'Audio',
  collection: 'BoxSet',
  playlist: 'Playlist',
  clip: 'Video',
  // D-7: photos reuse the photo feature's shapes.
  photo: 'Photo',
  photoalbum: 'PhotoAlbum',
};
const FOLDERS = new Set(['show', 'season', 'artist', 'album', 'collection', 'playlist', 'photoalbum']);
const COLLECTION_TYPES: Readonly<Record<string, string>> = { movie: 'movies', show: 'tvshows', artist: 'music', photo: 'homevideos' };

// Emby type of a PMS item, or null for one the dialect does not map (it is left out of lists).
export function itemType(meta: Pick<PlexMeta, 'type' | 'extraType'>): string | null {
  if (meta.type === 'clip' && Number(meta.extraType) === 1) return 'Trailer';
  return TYPES[meta.type] ?? null;
}

export function collectionType(sectionType: string): string | undefined {
  return COLLECTION_TYPES[sectionType];
}

export function toView(s: PlexSection): BaseItem {
  const out: BaseItem = { Id: sectionId(s.key), Name: s.title, Type: 'CollectionFolder', IsFolder: true };
  const ct = collectionType(s.type);
  if (ct) out.CollectionType = ct;
  const tag = imageTag(s.thumb);
  if (tag) out.ImageTags = { Primary: tag };
  return out;
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1';

export function toUserData(meta: PlexMeta): UserData {
  const folder = FOLDERS.has(meta.type);
  const views = Number(meta.viewCount) || 0;
  const ud: UserData = { IsFavorite: false, PlayCount: views, PlaybackPositionTicks: msToTicks(meta.viewOffset) ?? 0 };
  if (folder && typeof meta.leafCount === 'number') {
    const unplayed = Math.max(0, meta.leafCount - (Number(meta.viewedLeafCount) || 0));
    ud.UnplayedItemCount = unplayed;
    ud.Played = meta.leafCount > 0 && unplayed === 0;
  } else ud.Played = views > 0;
  if (!folder && meta.viewOffset && meta.duration) ud.PlayedPercentage = Math.round((meta.viewOffset / meta.duration) * 10_000) / 100;
  const last = epochToIso(meta.lastViewedAt);
  if (last) ud.LastPlayedDate = last;
  return ud;
}

// Plex codec names → the Emby ones the players and chips read.
const SUB_CODECS: Readonly<Record<string, string>> = { srt: 'subrip', pgs: 'pgssub', vobsub: 'dvdsub', smi: 'sami' };
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'sami', 'text']);
const STREAM_TYPES: Readonly<Record<number, string>> = { 1: 'Video', 2: 'Audio', 3: 'Subtitle' };

function videoRange(s: PlexStream): Partial<MediaStream> {
  const trc = (s.colorTrc ?? '').toLowerCase();
  const out: Partial<MediaStream> = {};
  if (trc) out.ColorTransfer = trc;
  if (s.DOVIPresent || s.DOVIProfile) {
    out.VideoRange = 'HDR';
    out.VideoRangeType = 'DOVI';
    if (s.DOVIProfile) out.DvProfile = s.DOVIProfile;
    if (s.DOVIBLCompatID !== undefined) out.DvBlSignalCompatibilityId = s.DOVIBLCompatID;
  } else if (trc === 'smpte2084') {
    out.VideoRange = 'HDR';
    out.VideoRangeType = 'HDR10';
  } else if (trc === 'arib-std-b67') {
    out.VideoRange = 'HDR';
    out.VideoRangeType = 'HLG';
  } else {
    out.VideoRange = 'SDR';
    out.VideoRangeType = 'SDR';
  }
  return out;
}

// Index = the PMS stream id (unique, what Plex selects by), never the ordinal: AudioStreamIndex and
// SubtitleStreamIndex carry ids through the existing code (plex-spec §4, risk R-2).
export function toStream(s: PlexStream): MediaStream | null {
  const type = STREAM_TYPES[s.streamType];
  if (!type || typeof s.id !== 'number') return null;
  const codec = s.codec ? (SUB_CODECS[s.codec.toLowerCase()] ?? s.codec.toLowerCase()) : undefined;
  const out: MediaStream = { Index: s.id, Type: type };
  if (codec) out.Codec = codec;
  const lang = s.languageCode ?? s.languageTag;
  if (lang) out.Language = lang;
  if (s.title) out.Title = s.title;
  const display = s.extendedDisplayTitle ?? s.displayTitle;
  if (display) out.DisplayTitle = display;
  if (s.default) out.IsDefault = true;
  if (s.forced) out.IsForced = true;
  if (s.hearingImpaired) out.IsHearingImpaired = true;
  if (s.visualImpaired) out.IsVisualImpaired = true;
  if (type === 'Video') {
    if (s.width) out.Width = s.width;
    if (s.height) out.Height = s.height;
    if (s.frameRate) out.RealFrameRate = s.frameRate;
    Object.assign(out, videoRange(s));
  }
  if (type === 'Audio') {
    if (s.channels) out.Channels = s.channels;
    if (s.audioChannelLayout) out.ChannelLayout = s.audioChannelLayout;
  }
  if (s.bitrate) out.BitRate = s.bitrate * 1000;
  if (type === 'Subtitle') {
    out.IsTextSubtitleStream = codec ? TEXT_SUBS.has(codec) : false;
    if (s.key) {
      out.IsExternal = true;
      out.DeliveryMethod = 'External';
      out.DeliveryUrl = s.key;
    }
  }
  return out;
}

// A part PMS cannot read (exists=false or accessible=false, sent with checkFiles=1).
const partMissing = (p: PlexPart): boolean => p.exists === false || p.accessible === false;

function resolutionLabel(m: PlexMedia): string | undefined {
  const r = (m.videoResolution ?? '').toLowerCase();
  if (r === '4k') return '4K';
  if (/^\d+$/.test(r)) return `${r}p`;
  return r ? r.toUpperCase() : undefined;
}

// One MediaSource per playable Media (versions; an edition's title names it). Multi-part media is one source
// whose streams are the first part's: the parts play as one queue (D-4). Server file paths are never sent.
export function toMediaSources(meta: PlexMeta): MediaSource[] {
  const out: MediaSource[] = [];
  for (const m of meta.Media ?? []) {
    const parts = m.Part ?? [];
    if (!parts.length || parts.every(partMissing)) continue;
    const first = parts.find((p) => !partMissing(p)) ?? parts[0];
    const streams = (first.Stream ?? []).map(toStream).filter((s): s is MediaStream => s !== null);
    const selected = (type: number) => first.Stream?.find((s) => s.streamType === type && s.selected) ?? first.Stream?.find((s) => s.streamType === type && s.default);
    const src: MediaSource = {
      Id: String(m.id),
      Protocol: 'File',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: true,
      MediaStreams: streams,
    };
    const name = m.editionTitle ?? meta.editionTitle ?? m.title ?? resolutionLabel(m);
    if (name) src.Name = name;
    const container = m.container ?? first.container;
    if (container) src.Container = container;
    if (m.bitrate) src.Bitrate = m.bitrate * 1000;
    const size = parts.reduce((n, p) => n + (p.size ?? 0), 0);
    if (size) src.Size = size;
    const ticks = msToTicks(m.duration ?? meta.duration);
    if (ticks) src.RunTimeTicks = ticks;
    const audio = selected(2);
    if (audio) src.DefaultAudioStreamIndex = audio.id;
    const sub = first.Stream?.find((s) => s.streamType === 3 && s.selected);
    if (sub) src.DefaultSubtitleStreamIndex = sub.id;
    out.push(src);
  }
  return out;
}

function people(meta: PlexMeta): BaseItem['People'] {
  const one = (p: PlexTag, type: string) => {
    if (p.id === undefined || !p.tag) return null;
    const out: NonNullable<BaseItem['People']>[number] = { Id: personId(p.id), Name: p.tag, Type: type };
    if (p.role) out.Role = p.role;
    const tag = imageTag(p.thumb);
    if (tag) out.PrimaryImageTag = tag;
    return out;
  };
  const all = [
    ...(meta.Director ?? []).map((p) => one(p, 'Director')),
    ...(meta.Writer ?? []).map((p) => one(p, 'Writer')),
    ...(meta.Role ?? []).map((p) => one(p, 'Actor')),
  ].filter((p) => p !== null);
  return all.length ? all : undefined;
}

// Rating[] image 'imdb://image.rating' → source 'imdb'.
function providerRatings(meta: PlexMeta): BaseItem['ProviderRatings'] {
  const list = (meta.Rating ?? [])
    .filter((r) => typeof r.value === 'number' && r.image)
    .map((r) => ({ Source: (r.image ?? '').split('://')[0], Type: r.type ?? 'audience', Value: r.value as number }));
  return list.length ? list : undefined;
}

export function toChapters(meta: PlexMeta): ChapterInfo[] | undefined {
  const list = (meta.Chapter ?? [])
    .filter((c) => typeof c.startTimeOffset === 'number')
    .map((c) => {
      const out: ChapterInfo = { StartPositionTicks: (c.startTimeOffset as number) * TICKS_PER_MS };
      if (c.tag) out.Name = c.tag;
      return out;
    });
  return list.length ? list : undefined;
}

export function toItem(meta: PlexMeta): BaseItem | null {
  const type = itemType(meta);
  if (!type || !meta.ratingKey) return null;
  const out: BaseItem = { Id: String(meta.ratingKey), Name: meta.title ?? '', Type: type };
  const folder = FOLDERS.has(meta.type);
  out.IsFolder = folder;
  if (meta.type === 'track') out.MediaType = 'Audio';
  else if (meta.type === 'photo') out.MediaType = 'Photo';
  else if (meta.type === 'playlist') out.MediaType = meta.playlistType === 'audio' ? 'Audio' : meta.playlistType === 'photo' ? 'Photo' : 'Video';
  else if (!folder) out.MediaType = 'Video';
  if (meta.summary) out.Overview = meta.summary;
  if (meta.tagline) out.Taglines = [meta.tagline];
  if (meta.year) out.ProductionYear = meta.year;
  if (meta.originallyAvailableAt) out.PremiereDate = `${meta.originallyAvailableAt}T00:00:00.0000000Z`;
  if (meta.contentRating) out.OfficialRating = meta.contentRating;
  const rt = (meta.ratingImage ?? '').startsWith('rottentomatoes://');
  if (typeof meta.audienceRating === 'number') out.CommunityRating = meta.audienceRating;
  else if (typeof meta.rating === 'number' && !rt) out.CommunityRating = meta.rating;
  if (typeof meta.rating === 'number' && rt) out.CriticRating = Math.round(meta.rating * 10);
  const ratings = providerRatings(meta);
  if (ratings) out.ProviderRatings = ratings;
  const ticks = msToTicks(meta.duration);
  if (ticks) out.RunTimeTicks = ticks;
  if (typeof meta.index === 'number') out.IndexNumber = meta.index;
  if (typeof meta.parentIndex === 'number') out.ParentIndexNumber = meta.parentIndex;
  if (meta.type === 'episode') {
    if (meta.grandparentRatingKey) out.SeriesId = String(meta.grandparentRatingKey);
    if (meta.grandparentTitle) out.SeriesName = meta.grandparentTitle;
    if (meta.parentRatingKey) out.SeasonId = String(meta.parentRatingKey);
    if (meta.parentTitle) out.SeasonName = meta.parentTitle;
    if (meta.parentRatingKey) out.ParentId = String(meta.parentRatingKey);
  }
  if (meta.type === 'season') {
    if (meta.parentRatingKey) {
      out.SeriesId = String(meta.parentRatingKey);
      out.ParentId = String(meta.parentRatingKey);
    }
    if (meta.parentTitle) out.SeriesName = meta.parentTitle;
  }
  if (meta.type === 'album') {
    if (meta.parentTitle) out.AlbumArtist = meta.parentTitle;
    if (meta.parentRatingKey && meta.parentTitle) out.AlbumArtists = [{ Name: meta.parentTitle, Id: String(meta.parentRatingKey) }];
  }
  if (meta.type === 'track') {
    if (meta.parentTitle) out.Album = meta.parentTitle;
    if (meta.parentRatingKey) out.AlbumId = String(meta.parentRatingKey);
    if (meta.grandparentTitle) out.AlbumArtist = meta.grandparentTitle;
    if (meta.grandparentRatingKey && meta.grandparentTitle) out.AlbumArtists = [{ Name: meta.grandparentTitle, Id: String(meta.grandparentRatingKey) }];
    // A track artist other than the album's (originalTitle) has no item of its own in PMS: a name only.
    const artist = meta.originalTitle ?? meta.grandparentTitle;
    if (artist) out.Artists = [artist];
    if (!meta.originalTitle && meta.grandparentTitle && meta.grandparentRatingKey) out.ArtistItems = [{ Name: meta.grandparentTitle, Id: String(meta.grandparentRatingKey) }];
    const albumTag = imageTag(meta.parentThumb);
    if (albumTag) out.AlbumPrimaryImageTag = albumTag;
  }
  if (meta.librarySectionID !== undefined && (meta.type === 'movie' || meta.type === 'show' || meta.type === 'artist')) out.ParentId = sectionId(meta.librarySectionID);
  if (typeof meta.childCount === 'number') out.ChildCount = meta.childCount;
  if (typeof meta.leafCount === 'number') out.RecursiveItemCount = meta.leafCount;
  const ids = providerIds(meta);
  if (Object.keys(ids).length) out.ProviderIds = ids;
  const genres = (meta.Genre ?? []).map((g) => g.tag).filter((g): g is string => !!g);
  if (genres.length) out.Genres = genres;
  if (meta.studio) out.Studios = [{ Name: meta.studio }];
  const labels = (meta.Label ?? []).map((l) => l.tag).filter((l): l is string => !!l);
  if (labels.length) out.Tags = labels;
  const ppl = people(meta);
  if (ppl) out.People = ppl;
  // Images: the tag is the PMS path's timestamp; images.ts imagePaths() keeps the paths for the adapter.
  const tags: Record<string, string> = {};
  const primary = imageTag(meta.Image?.find((i) => i.type === 'coverPoster' || i.type === 'snapshot')?.url ?? meta.thumb);
  if (primary) tags.Primary = primary;
  const logo = imageTag(meta.Image?.find((i) => i.type === 'clearLogo')?.url);
  if (logo) tags.Logo = logo;
  if (Object.keys(tags).length) out.ImageTags = tags;
  const backdrop = imageTag(meta.Image?.find((i) => i.type === 'background')?.url ?? meta.art);
  if (backdrop) out.BackdropImageTags = [backdrop];
  if (meta.grandparentRatingKey && (meta.type === 'episode' || meta.type === 'season')) {
    const sp = imageTag(meta.grandparentThumb);
    if (sp) out.SeriesPrimaryImageTag = sp;
    const gart = imageTag(meta.grandparentArt);
    if (gart) {
      out.ParentBackdropItemId = String(meta.grandparentRatingKey);
      out.ParentBackdropImageTags = [gart];
    }
  }
  // A playlist entry: what PlaylistItems.svelte removes and moves (the same item may appear twice).
  if (meta.playlistItemID !== undefined) out.PlaylistItemId = String(meta.playlistItemID);
  if (meta.addedAt) out.DateCreated = epochToIso(meta.addedAt);
  if (meta.updatedAt) out.Etag = String(meta.updatedAt);
  // A photo is an image, not a stream: its size only.
  const media = meta.type === 'photo' ? [] : toMediaSources(meta);
  if (meta.type === 'photo' && meta.Media?.[0]) {
    if (meta.Media[0].width) out.Width = meta.Media[0].width;
    if (meta.Media[0].height) out.Height = meta.Media[0].height;
  }
  if (media.length) {
    out.MediaSources = media;
    out.MediaStreams = media[0].MediaStreams;
    const v = media[0].MediaStreams?.find((s) => s.Type === 'Video');
    if (v?.Width) out.Width = v.Width;
    if (v?.Height) out.Height = v.Height;
    if (out.MediaType === 'Video') out.Container = media[0].Container;
  }
  const chapters = toChapters(meta);
  if (chapters) out.Chapters = chapters;
  const extras = meta.Extras?.Metadata;
  if (extras) out.LocalTrailerCount = extras.filter((x) => x.type === 'clip' && Number(x.extraType) === 1).length;
  if (meta.type !== 'collection' && meta.type !== 'playlist') out.UserData = toUserData(meta);
  else out.UserData = { IsFavorite: false, Played: false, PlayCount: 0, PlaybackPositionTicks: 0 };
  return out;
}

// A container's items (unmapped types left out) with Emby paging: TotalRecordCount is PMS's totalSize when
// it sent one (X-Plex-Container-Size was set), else the page's size.
export function toItemsResult(c: PlexContainer | undefined, startIndex = 0): ItemsResult {
  const items = (c?.Metadata ?? []).map(toItem).filter((x): x is BaseItem => x !== null);
  const total = typeof c?.totalSize === 'number' ? c.totalSize : (c?.Metadata?.length ?? 0) + (Number(c?.offset) || startIndex);
  return { Items: items, TotalRecordCount: total, StartIndex: Number(c?.offset) || startIndex };
}

// Extras split the Emby way: /LocalTrailers gets the trailers, /SpecialFeatures the rest.
export function toExtras(meta: PlexMeta, trailers: boolean): BaseItem[] {
  return (meta.Extras?.Metadata ?? [])
    .filter((x) => x.type === 'clip' && (Number(x.extraType) === 1) === trailers)
    .map(toItem)
    .filter((x): x is BaseItem => x !== null);
}

// Marker[] → the Jellyfin MediaSegments answer the skip feature already reads (shared/markers.ts). Intro markers on
// a movie are dropped (Plezy #2235); credits come only from a marker, so a show with credits detection off gets
// no Outro and Up Next waits for the end (#2137).
const SEGMENTS: Readonly<Record<string, string>> = { intro: 'Intro', credits: 'Outro', commercial: 'Commercial' };
export function toSegments(meta: PlexMeta): { Items: { Type: string; StartTicks: number; EndTicks: number }[] } {
  const items = (meta.Marker ?? [])
    .filter((m) => SEGMENTS[m.type] && !(m.type === 'intro' && meta.type === 'movie'))
    .filter((m) => typeof m.startTimeOffset === 'number' && typeof m.endTimeOffset === 'number' && m.endTimeOffset > m.startTimeOffset)
    .map((m) => ({ Type: SEGMENTS[m.type], StartTicks: m.startTimeOffset * TICKS_PER_MS, EndTicks: m.endTimeOffset * TICKS_PER_MS }))
    .sort((a, b) => a.StartTicks - b.StartTicks);
  return { Items: items };
}

// Server hubs (caps.serverHubs) → [{Name, Key, Items}], the one new Emby-shaped answer (plex-spec §8).
export function toHubs(c: PlexContainer | undefined): { Name: string; Key: string; Items: BaseItem[] }[] {
  return (c?.Hub ?? [])
    .map((h: PlexHub) => ({ Name: h.title ?? '', Key: h.hubIdentifier ?? h.key ?? '', Items: (h.Metadata ?? []).map(toItem).filter((x): x is BaseItem => x !== null) }))
    .filter((h) => h.Items.length > 0);
}

// The part a stream, BIF or direct play request reads: the first readable part of the chosen Media.
export function playablePart(meta: PlexMeta, mediaSourceId?: string): PlexPart | null {
  const media = (meta.Media ?? []).filter((m) => (m.Part ?? []).some((p) => !partMissing(p)));
  const m = (mediaSourceId && media.find((x) => String(x.id) === mediaSourceId)) || media[0];
  return m?.Part?.find((p) => !partMissing(p)) ?? null;
}

// Every readable part of a Media, in order: a multi-part film plays them as one queue (D-4).
export function partQueue(meta: PlexMeta, mediaSourceId?: string): PlexPart[] {
  const media = (meta.Media ?? []).filter((m) => (m.Part ?? []).some((p) => !partMissing(p)));
  const m = (mediaSourceId && media.find((x) => String(x.id) === mediaSourceId)) || media[0];
  return (m?.Part ?? []).filter((p) => !partMissing(p));
}

// Seasons hidden by the show (flattenSeasons=1, Plezy #1008): the Series page lists every episode instead.
export const seasonsFlattened = (show: PlexMeta): boolean => truthy(show.flattenSeasons);

// plex.tv's account profile → the subtitle default of a Plex play (plex-spec §6.4, #1182): autoSelectSubtitle
// 0/1/2 = manual/foreign/always onto SubtitleMode, and its subtitle language.
export function accountSubtitles(profile?: { autoSelectSubtitle?: number; defaultSubtitleLanguage?: string }): { mode?: SubtitleMode; language: string } {
  const mode = (['manual', 'foreign', 'always'] as const)[Number(profile?.autoSelectSubtitle)];
  const language = typeof profile?.defaultSubtitleLanguage === 'string' ? profile.defaultSubtitleLanguage : '';
  return mode ? { mode, language } : { language };
}
