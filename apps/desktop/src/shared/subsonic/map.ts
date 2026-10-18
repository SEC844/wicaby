// The Navidrome (OpenSubsonic) dialect, pure part (music-feishin-navidrome spec §4.B): ids, the Subsonic records
// mapped onto Wicaby's Emby-shaped music model, the album list a library query asks for, the scrobble threshold and
// lyrics. No Node or Electron import: main's SubsonicClient and the checks use it; Android's core/subsonic/SubsonicMap.kt
// is the twin, both on tools/checks/fixtures/subsonic/vectors.json.
import type { BaseItem } from '../models';

type Rec = Record<string, unknown>;
const TICKS_S = 10_000_000;

// ---- Ids ----
// A Subsonic call is typed (getArtist, getAlbum, getSong…), so every id carries its kind: ar_ artist, al_ album,
// tr_ track, pl_ playlist, mf_ music folder, ge_ genre (its name), pe_ playlist entry (its index). A raw id outside
// [A-Za-z0-9-] goes as base64url after a second '_', so every id fits the cast relay's /[A-Za-z0-9_-]{1,64}/.
export type IdKind = 'ar' | 'al' | 'tr' | 'pl' | 'mf' | 'ge' | 'pe';
const KINDS = new Set<string>(['ar', 'al', 'tr', 'pl', 'mf', 'ge', 'pe']);
const PLAIN = /^[A-Za-z0-9-]+$/;

const b64url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string): string => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export function encodeId(kind: IdKind, raw: string | number): string {
  const s = String(raw);
  return PLAIN.test(s) ? `${kind}_${s}` : `${kind}__${b64url(s)}`;
}

export function decodeId(id: string): { kind: IdKind; raw: string } | null {
  const m = /^([a-z]{2})_(_?)(.+)$/.exec(id);
  if (!m || !KINDS.has(m[1])) return null;
  try {
    const raw = m[2] ? unb64url(m[3]) : m[3];
    return m[2] || PLAIN.test(raw) ? { kind: m[1] as IdKind, raw } : null;
  } catch {
    return null;
  }
}

// ---- Records → items ----
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const ticks = (seconds: unknown): number | undefined => (num(seconds) !== undefined ? Math.round((seconds as number) * TICKS_S) : undefined);
const userData = (r: Rec) => ({ IsFavorite: Boolean(r.starred), PlayCount: num(r.playCount) ?? 0, Played: (num(r.playCount) ?? 0) > 0, Key: str(r.id) ?? '' });
const art = (r: Rec) => (str(r.coverArt) ? { Primary: str(r.coverArt)! } : {});
const genres = (r: Rec): string[] => {
  const list = Array.isArray(r.genres) ? (r.genres as Rec[]).map((g) => str(g.name)).filter((g): g is string => Boolean(g)) : [];
  return list.length ? list : str(r.genre) ? [str(r.genre)!] : [];
};
const genreItems = (names: string[]) => names.map((Name) => ({ Name, Id: encodeId('ge', Name) }));

export function artistItem(r: Rec): BaseItem {
  return { Id: encodeId('ar', str(r.id) ?? ''), Name: str(r.name) ?? '', Type: 'MusicArtist', IsFolder: true, ChildCount: num(r.albumCount), ImageTags: art(r), UserData: userData(r) } as BaseItem;
}

export function albumItem(r: Rec): BaseItem {
  const artist = str(r.artist) ?? str(r.displayArtist) ?? '';
  const ref = str(r.artistId) ? [{ Id: encodeId('ar', str(r.artistId)!), Name: artist }] : [];
  const g = genres(r);
  const gain = num((r.replayGain as Rec | undefined)?.albumGain);
  return {
    Id: encodeId('al', str(r.id) ?? ''), Name: str(r.name) ?? str(r.title) ?? '', Type: 'MusicAlbum', IsFolder: true, MediaType: undefined,
    AlbumArtist: artist, AlbumArtists: ref, ArtistItems: ref, Artists: artist ? [artist] : [], ProductionYear: num(r.year), Genres: g, GenreItems: genreItems(g),
    ChildCount: num(r.songCount), RunTimeTicks: ticks(r.duration), DateCreated: str(r.created), ImageTags: art(r), UserData: userData(r),
    ...(gain !== undefined ? { NormalizationGain: gain } : {}),
  } as BaseItem;
}

export function songItem(r: Rec, entryIndex?: number): BaseItem {
  const artist = str(r.artist) ?? '';
  const albumArtist = str(r.displayAlbumArtist) ?? str((r.albumArtists as Rec[] | undefined)?.[0]?.name) ?? artist;
  const albumArtistId = str((r.albumArtists as Rec[] | undefined)?.[0]?.id);
  const id = encodeId('tr', str(r.id) ?? '');
  const g = genres(r);
  const codec = str(r.suffix)?.toLowerCase();
  const gain = num((r.replayGain as Rec | undefined)?.trackGain);
  return {
    Id: id, Name: str(r.title) ?? '', Type: 'Audio', MediaType: 'Audio', IsFolder: false,
    Album: str(r.album), AlbumId: str(r.albumId) ? encodeId('al', str(r.albumId)!) : undefined, AlbumArtist: albumArtist,
    AlbumArtists: albumArtistId ? [{ Id: encodeId('ar', albumArtistId), Name: albumArtist }] : [],
    ArtistItems: str(r.artistId) ? [{ Id: encodeId('ar', str(r.artistId)!), Name: artist }] : [], Artists: artist ? [artist] : [],
    IndexNumber: num(r.track), ParentIndexNumber: num(r.discNumber) ?? 1, ProductionYear: num(r.year), Genres: g, GenreItems: genreItems(g),
    RunTimeTicks: ticks(r.duration), Container: codec, ImageTags: art(r), AlbumPrimaryImageTag: str(r.coverArt), UserData: userData(r),
    ...(gain !== undefined ? { NormalizationGain: gain } : {}),
    ...(entryIndex !== undefined ? { PlaylistItemId: encodeId('pe', entryIndex) } : {}),
    MediaSources: [
      {
        Id: id, Protocol: 'File', Container: codec, Size: num(r.size), Bitrate: num(r.bitRate) !== undefined ? (r.bitRate as number) * 1000 : undefined, RunTimeTicks: ticks(r.duration),
        SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
        MediaStreams: [{ Type: 'Audio', Index: 0, Codec: codec, Channels: num(r.channelCount), SampleRate: num(r.samplingRate), BitDepth: num(r.bitDepth), IsDefault: true }],
      },
    ],
  } as BaseItem;
}

export function playlistItem(r: Rec): BaseItem {
  return { Id: encodeId('pl', str(r.id) ?? ''), Name: str(r.name) ?? '', Type: 'Playlist', MediaType: 'Audio', IsFolder: true, ChildCount: num(r.songCount), RunTimeTicks: ticks(r.duration), ImageTags: art(r), DateCreated: str(r.created) } as BaseItem;
}

export function genreItem(r: Rec): BaseItem {
  const name = str(r.value) ?? str(r.name) ?? '';
  return { Id: encodeId('ge', name), Name: name, Type: 'MusicGenre', IsFolder: true, ChildCount: num(r.albumCount), ImageTags: {} } as BaseItem;
}

export function folderView(r: Rec): BaseItem {
  return { Id: encodeId('mf', str(r.id) ?? ''), Name: str(r.name) ?? 'Music', Type: 'CollectionFolder', CollectionType: 'music', IsFolder: true, ImageTags: {} } as BaseItem;
}

// ---- Library queries → getAlbumList2 ----
// The album list a /Items?IncludeItemTypes=MusicAlbum query asks for (Emby names, either case).
export function albumListArgs(q: Record<string, string>): Record<string, string> {
  const sort = (q.SortBy ?? '').split(',')[0];
  const desc = /^desc/i.test(q.SortOrder ?? '');
  const genre = q.Genres?.split('|')[0] ?? (q.GenreIds ? decodeId(q.GenreIds.split(',')[0])?.raw : undefined);
  const years = q.Years?.split(',').map(Number).filter(Number.isFinite) ?? [];
  if (/IsFavorite/.test(q.Filters ?? '') || q.IsFavorite === 'true') return { type: 'starred' };
  if (genre) return { type: 'byGenre', genre };
  if (years.length) return { type: 'byYear', fromYear: String(desc ? Math.max(...years) : Math.min(...years)), toYear: String(desc ? Math.min(...years) : Math.max(...years)) };
  if (sort === 'ProductionYear' || sort === 'PremiereDate') return { type: 'byYear', fromYear: desc ? '9999' : '0', toYear: desc ? '0' : '9999' };
  if (sort === 'DateCreated') return { type: 'newest' };
  if (sort === 'PlayCount') return { type: 'frequent' };
  if (sort === 'DatePlayed') return { type: 'recent' };
  if (sort === 'Random') return { type: 'random' };
  if (sort === 'AlbumArtist' || sort === 'Artist') return { type: 'alphabeticalByArtist' };
  return { type: 'alphabeticalByName' };
}

// ---- Scrobble ----
// A play counts (submission=true) once it reached half the track or 4 minutes (the Last.fm rule), once per play.
export function scrobbleDue(positionTicks: number | undefined, runTimeTicks: number | undefined): boolean {
  const pos = positionTicks ?? 0;
  const half = runTimeTicks ? runTimeTicks / 2 : Infinity;
  return pos > 0 && pos >= Math.min(half, 240 * TICKS_S);
}

// ---- Lyrics ----
// OpenSubsonic structuredLyrics (ms, offset: positive = sooner) or legacy getLyrics text → Jellyfin's lyrics JSON
// (Start in ticks), so shared/music.ts lyricsFromJellyfin reads it. Prefers synced lyrics. Null: none.
export function lyricsToJellyfin(structured: Rec[] | undefined, legacyText?: string): { Metadata: { IsSynced: boolean }; Lyrics: { Text: string; Start?: number }[] } | null {
  const list = structured ?? [];
  const pick = list.find((l) => l.synced && Array.isArray(l.line) && (l.line as unknown[]).length) ?? list.find((l) => Array.isArray(l.line) && (l.line as unknown[]).length);
  if (pick) {
    const synced = Boolean(pick.synced);
    const offset = num(pick.offset) ?? 0;
    return { Metadata: { IsSynced: synced }, Lyrics: (pick.line as Rec[]).map((l) => (synced ? { Text: str(l.value) ?? '', Start: Math.max(0, ((num(l.start) ?? 0) - offset) * 10_000) } : { Text: str(l.value) ?? '' })) };
  }
  const text = legacyText?.trim();
  return text ? { Metadata: { IsSynced: false }, Lyrics: text.split(/\r?\n/).map((Text) => ({ Text })) } : null;
}

// HTML of an artist biography → plain text (Last.fm biographies carry links).
export function plainText(html: string | undefined): string | undefined {
  const t = html?.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  return t || undefined;
}
