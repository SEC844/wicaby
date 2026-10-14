// The mocks' music library (music-spec MU-00, §6.1), generated at start-up, deterministic, every name invented:
// album artists, a featured artist, a 2-disc album, an EP, a single, a compilation of four track artists, an album
// of FLAC files with ReplayGain tags, genres, an audio playlist, favourites and play counts. Every track streams as
// generated silence (8 kHz mono 16-bit WAV, or FLAC for the tagged album): nothing audible ever plays from a test.
// Lyrics: one album has a synced LRC per track, one track plain lyrics, in each server's shape (Jellyfin
// /Audio/{id}/Lyrics; Emby an external "lrc" subtitle stream on the audio item). Loudness: NormalizationGain on
// Jellyfin tracks and albums only. mock-emby.mjs adds it with MOCK_DATASET=demo or MOCK_MUSIC=1;
// MOCK_MUSIC_SCALE=big adds 1,000 metadata-only songs for scroll tests.
const TICKS_S = 10_000_000;

// seconds: track length (the first three artists keep their 0.4.1 stopgap lengths, 20 s + 5 s per track).
// Missing art, as on a real Emby (music-feishin-navidrome spec §4.A): noArt, an artist without an image (no MusicBrainz
// id); art 'tracks', an album without a Primary whose tracks carry their embedded cover (the owner's field bug: the cover
// only shows once a track plays); art 'none', an album with no image anywhere (the placeholder).
export const MUSIC = [
  { artist: 'Les Ondes Calmes', noArt: true, genre: 'Chanson', albums: [{ name: 'Marée basse', year: 2021, tracks: ['Écume', 'Phare', 'Sable mouillé'] }, { name: 'Brume', year: 2023, art: 'tracks', tracks: ['Aube grise', 'Côte'] }] },
  { artist: 'Night Arcade', noArt: true, genre: 'Électro', albums: [{ name: 'Neon Avenue', year: 2022, tracks: ['Insert Coin', 'High Score', 'Continue?', 'Game Over'] }] },
  { artist: 'Zéphyr Trio', noArt: true, genre: 'Classique', albums: [{ name: 'Trois vents', year: 2020, art: 'none', tracks: ['Mistral', 'Tramontane', 'Sirocco'] }] },
  {
    artist: 'Nora Vale',
    genre: 'Chanson',
    albums: [
      { name: 'Lignes claires', year: 2024, seconds: 12, lyrics: 'synced', tracks: ['Fil', 'Marelle', 'Encre'] },
      { name: 'Seule', year: 2025, seconds: 6, lyrics: 'plain', tracks: ['Seule'] },
    ],
  },
  {
    artist: 'Ensemble Quartz',
    genre: 'Classique',
    albums: [{ name: 'Suites en deux temps', year: 2019, seconds: 5, discs: 2, tracks: ['Prélude', 'Allemande', 'Courante', 'Sarabande', 'Menuet', 'Gigue', 'Ouverture', 'Air', 'Bourrée', 'Gavotte', 'Passepied', 'Chaconne'] }],
  },
  { artist: 'Les Graphites', genre: 'Électro', albums: [{ name: 'Gain', year: 2026, seconds: 4, flac: true, tracks: ['Niveau', 'Crête', 'Plancher'] }] },
  {
    artist: 'Divers artistes',
    genre: 'Électro',
    albums: [{ name: 'Compilation Graphite', year: 2022, seconds: 4, guests: ['Kaolin', 'Mira Sol', 'Nora Vale', 'Basse Fidèle'], tracks: ['Quai', 'Néon', 'Ardoise', 'Verre', 'Silex', 'Galet', 'Craie', 'Mica'] }],
  },
];

// Jellyfin loudness (dB), Emby never sends it (spec §3.6). Lyrics by track id. Album artists. Mock/State log.
export const GAIN = new Map();
export const LYRICS = new Map();
export const ALBUM_ARTISTS = new Set();
export const LOG = { streams: [], instantMix: [], reports: [], lrclib: [] };
const logPush = (list, row) => list.push(row) > 200 && list.shift();
// Playing / Progress / Stopped of a track, in arrival order (gapless checks read the order and the positions).
export function logReport(items, kind, b) {
  if (isMusic(items.get(b?.ItemId))) logPush(LOG.reports, { kind, at: Date.now(), ItemId: b.ItemId, PositionTicks: b.PositionTicks, PlaySessionId: b.PlaySessionId, MediaSourceId: b.MediaSourceId, EventName: b.EventName });
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const genreId = (name) => `genre-${slug(name)}`;

// "Ligne 1"… one second apart (≥ 10 timed lines for 12 s tracks); the second track carries an [offset:] tag.
function lrcFor(title, n, seconds) {
  const head = [`[ti:${title}]`, '[ar:Nora Vale]', ...(n === 1 ? ['[offset:+250]'] : [])];
  const lines = Array.from({ length: seconds - 1 }, (_, i) => `[00:${String(i).padStart(2, '0')}.${i % 2 ? '50' : '00'}]Ligne ${i + 1}`);
  return [...head, ...lines].join('\n') + '\n';
}

// Adds the library through mock-emby's own add() and makeList() (the playlist keeps its entry ids) and returns the
// track ids. ud: the user data store (favourites and play counts).
export function addMusic({ add, makeList, ud }) {
  add({ Id: 'lib-music', Name: 'Musique', Type: 'CollectionFolder', CollectionType: 'music', IsFolder: true, ImageTags: { Primary: 't' } });
  for (const g of ['Chanson', 'Classique', 'Électro']) add({ Id: genreId(g), Name: g, Type: 'MusicGenre', IsFolder: true, ImageTags: {} });
  const artistIds = new Map();
  const artist = (name) => {
    if (!artistIds.has(name)) {
      const id = `artist-${artistIds.size}`;
      artistIds.set(name, id);
      add({ Id: id, Name: name, Type: 'MusicArtist', IsFolder: true, ImageTags: MUSIC.some((a) => a.artist === name && a.noArt) ? {} : { Primary: 'p' } });
    }
    return { Id: artistIds.get(name), Name: name };
  };
  const all = [];
  MUSIC.forEach((a, ai) => {
    const albumArtist = artist(a.artist);
    ALBUM_ARTISTS.add(albumArtist.Id);
    const genre = { Name: a.genre, Id: genreId(a.genre) };
    a.albums.forEach((al, bi) => {
      const albumId = `album-${ai}-${bi}`;
      const perDisc = Math.ceil(al.tracks.length / (al.discs ?? 1));
      const trackArtists = al.tracks.map((_, ti) => (al.guests ? artist(al.guests[ti % al.guests.length]) : albumArtist));
      const credited = [...new Map(trackArtists.map((x) => [x.Id, x])).values()];
      const albumGain = -3.5 - ((ai + bi) % 7);
      GAIN.set(albumId, albumGain);
      add({
        Id: albumId, Name: al.name, Type: 'MusicAlbum', IsFolder: true, ParentId: 'lib-music', ProductionYear: al.year, Genres: [a.genre], GenreItems: [genre],
        AlbumArtist: a.artist, AlbumArtists: [albumArtist], ArtistItems: al.guests ? credited : [albumArtist], Artists: (al.guests ? credited : [albumArtist]).map((x) => x.Name),
        ImageTags: al.art ? {} : { Primary: 'p' }, ChildCount: al.tracks.length, DateCreated: new Date(Date.UTC(al.year, 0, 1 + ai)).toISOString(),
      });
      al.tracks.forEach((t, ti) => {
        const id = `track-${ai}-${bi}-${ti}`;
        const seconds = al.seconds ?? 20 + ti * 5;
        const by = trackArtists[ti];
        all.push(id);
        GAIN.set(id, albumGain - (ti % 3));
        if (al.lyrics === 'synced') LYRICS.set(id, { synced: true, text: lrcFor(t, ti, seconds) });
        if (al.lyrics === 'plain') LYRICS.set(id, { synced: false, text: 'Première ligne sans temps\nDeuxième ligne\n\nRefrain sans temps\n' });
        add({
          Id: id, Name: t, Type: 'Audio', MediaType: 'Audio', ParentId: albumId, IndexNumber: (ti % perDisc) + 1, ParentIndexNumber: Math.floor(ti / perDisc) + 1,
          Album: al.name, AlbumId: albumId, ...(al.art ? {} : { AlbumPrimaryImageTag: 'p' }), ...(al.art === 'tracks' ? { ImageTags: { Primary: 't' } } : {}), AlbumArtist: a.artist, AlbumArtists: [albumArtist], ArtistItems: [by], Artists: [by.Name],
          Genres: [a.genre], GenreItems: [genre], RunTimeTicks: seconds * TICKS_S, ProductionYear: al.year, Container: al.flac ? 'flac' : 'wav',
          ...(al.flac ? { _replayGain: { track: -4.5 - ti, album: -6.25 } } : {}),
          // Emby (unverified, spec §3.5): lyrics as an external subtitle stream of codec lrc on the audio item.
          ...(LYRICS.has(id) ? { _lyricStream: { Index: 1, Type: 'Subtitle', Codec: LYRICS.get(id).synced ? 'lrc' : 'text', IsExternal: true, DeliveryMethod: 'External', Language: 'fre', DisplayTitle: 'Paroles', IsTextSubtitleStream: true } } : {}),
        });
      });
    });
  });
  makeList('playlist-music', 'Mix du dimanche', 'Playlist', [all[0], all[5], all[9], all[2], all[13]]);
  for (const id of ['track-1-0-1', 'track-3-0-0', 'album-0-0']) ud(id).IsFavorite = true;
  ['track-1-0-0', 'track-1-0-1', 'track-3-0-2', 'track-0-0-0'].forEach((id, i) => (ud(id).PlayCount = 9 - i * 2));
  if (process.env.MOCK_MUSIC_SCALE === 'big') {
    const albumArtist = artist('Catalogue Géant');
    ALBUM_ARTISTS.add(albumArtist.Id);
    add({ Id: 'album-big', Name: 'Mille titres', Type: 'MusicAlbum', IsFolder: true, ParentId: 'lib-music', AlbumArtist: albumArtist.Name, AlbumArtists: [albumArtist], ArtistItems: [albumArtist], ImageTags: { Primary: 'p' }, ChildCount: 1000 });
    for (let i = 0; i < 1000; i++)
      add({ Id: `track-big-${i}`, Name: `Titre ${i + 1}`, Type: 'Audio', MediaType: 'Audio', ParentId: 'album-big', IndexNumber: i + 1, ParentIndexNumber: 1, Album: 'Mille titres', AlbumId: 'album-big', AlbumArtist: albumArtist.Name, AlbumArtists: [albumArtist], ArtistItems: [albumArtist], Artists: [albumArtist.Name], RunTimeTicks: 4 * TICKS_S, Container: 'wav' });
  }
  return all;
}

export const isMusic = (item) => item?.Type === 'Audio';

// What PlaybackInfo answers for a track: one direct-play source (WAV, or FLAC for the tagged album). Its id is not the
// item id, as on a real Emby (mediasource_<n>): a client that sends the item id as MediaSourceId gets the 400 Emby gives.
export function musicSource(item) {
  return {
    Id: `mediasource_${item.Id}`, Name: item.Name, Protocol: 'File', Container: item.Container, Path: `/music/${item.Id}.${item.Container}`,
    Size: item.Container === 'flac' ? audioFile(item).length : 44 + Math.round((item.RunTimeTicks / TICKS_S) * RATE) * 2,
    Bitrate: 128_000, RunTimeTicks: item.RunTimeTicks, SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true, DefaultAudioStreamIndex: 0,
    MediaStreams: [{ Type: 'Audio', Index: 0, Codec: item.Container === 'flac' ? 'flac' : 'pcm_s16le', Channels: 1, SampleRate: RATE, IsDefault: true, Language: 'und', DisplayTitle: 'Mono' }, ...(item._lyricStream ? [item._lyricStream] : [])],
  };
}

const RATE = 8000;
const fileCache = new Map();
// A track's bytes, cached per id.
export function audioFile(item) {
  if (!fileCache.has(item.Id)) {
    const seconds = item.RunTimeTicks / TICKS_S;
    fileCache.set(item.Id, item._replayGain ? silentFlac(seconds, { REPLAYGAIN_TRACK_GAIN: `${item._replayGain.track.toFixed(2)} dB`, REPLAYGAIN_ALBUM_GAIN: `${item._replayGain.album.toFixed(2)} dB`, TITLE: item.Name }) : silentWav(seconds));
  }
  return fileCache.get(item.Id);
}

// [seconds] of silence as a WAV file.
export function silentWav(seconds) {
  const data = Math.round(seconds * RATE) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b; // the samples stay zero: silence
}

// [seconds] of silence as FLAC (8 kHz mono 16-bit) with Vorbis comments [tags]: every frame is one CONSTANT subframe
// of value 0, so no codec library is needed and the samples are zero by construction.
const BLOCK = 4096;
export function silentFlac(seconds, tags) {
  const total = Math.round(seconds * RATE);
  const info = Buffer.alloc(34);
  info.writeUInt16BE(BLOCK, 0);
  info.writeUInt16BE(BLOCK, 2);
  // Frame sizes 0 (unknown); then sample rate (20 bits), channels-1 (3), bits-1 (5), total samples (36); MD5 0 (unknown).
  info.writeBigUInt64BE((BigInt(RATE) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(total), 10);
  const vendor = Buffer.from('Wicaby mock');
  const entries = Object.entries(tags).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const comment = Buffer.concat([u32le(vendor.length), vendor, u32le(entries.length), ...entries.flatMap((e) => [u32le(e.length), e])]);
  const frames = [];
  for (let n = 0, done = 0; done < total; n++, done += BLOCK) {
    if (n > 127) throw new Error('silentFlac: one-byte frame numbers only');
    const size = Math.min(BLOCK, total - done);
    const head = Buffer.from([0xff, 0xf8, 0x74, 0x08, n, (size - 1) >> 8, (size - 1) & 0xff]); // 16-bit block size, 8 kHz, mono, 16 bits
    const body = Buffer.concat([head, Buffer.from([crc8(head), 0x00, 0x00, 0x00])]); // CONSTANT subframe, value 0
    frames.push(body, u16be(crc16(body)));
  }
  return Buffer.concat([Buffer.from('fLaC'), block(0, info, false), block(4, comment, true), ...frames]);
}
function u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}
function u16be(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}
const block = (type, data, last) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, data.length >> 16, (data.length >> 8) & 0xff, data.length & 0xff]), data]);
function crc8(buf) {
  let c = 0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}
function crc16(buf) {
  let c = 0;
  for (const byte of buf) {
    c ^= byte << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

// Instant mix (spec §3.3): the seed's genres, every track of them, the seed's own tracks first; deterministic.
function instantMix(items, id, limit) {
  const seed = items.get(id);
  const genres = new Set(seed?.Type === 'MusicGenre' ? [seed.Name] : seed?.Type === 'MusicArtist' ? [...items.values()].filter((x) => x.ArtistItems?.some((a) => a.Id === id)).flatMap((x) => x.Genres ?? []) : (seed?.Genres ?? []));
  const tracks = [...items.values()].filter((x) => x.Type === 'Audio' && x.Genres?.some((g) => genres.has(g)));
  const own = (x) => x.Id === id || x.AlbumId === id || x.ArtistItems?.some((a) => a.Id === id);
  return [...tracks.filter(own), ...tracks.filter((x) => !own(x))].slice(0, limit);
}

const q1 = (q, name) => q.get(name) ?? q.get(name[0].toLowerCase() + name.slice(1));
const sortName = (x) => (x.SortName ?? x.Name ?? '').toLowerCase().replace(/^(the|a|an) /, '');

// The music routes of both mocks (Emby paths; the Jellyfin mock forwards here and marks the request with
// x-mock-flavour). Returns true when it answered.
export function musicRoute({ req, res, p, parts, q, items, list, send, log }) {
  const jellyfin = req.headers['x-mock-flavour'] === 'jellyfin';
  const item = items.get(parts[1]);
  // A track: its silence, whole or by range (Audio/{id}/stream[.ext] and universal, as both servers serve audio).
  if (['Audio', 'Videos', 'Items'].includes(parts[0]) && (parts[2] === 'stream' || parts[2]?.startsWith('stream.') || parts[2] === 'universal') && isMusic(item)) {
    // Emby's universal needs a PlaySessionId (spec §3.4); Jellyfin's does not.
    if (parts[2] === 'universal' && !jellyfin && !q1(q, 'PlaySessionId')) return send(res, 400, 'PlaySessionId is required', 'text/plain'), true;
    // Emby's static stream answers 400 without a DeviceId, and both servers to a MediaSourceId the item does not have
    // (Jellyfin also takes the item id itself; none: the default source).
    const sourceId = q1(q, 'MediaSourceId');
    if (parts[2] !== 'universal' && !jellyfin && !q1(q, 'DeviceId')) return log?.('REFUSED stream without DeviceId', p), send(res, 400, 'DeviceId is required', 'text/plain'), true;
    if (sourceId && sourceId !== musicSource(item).Id && !(jellyfin && sourceId === item.Id)) return log?.('REFUSED stream of an unknown MediaSourceId', sourceId), send(res, 400, 'Unknown MediaSourceId', 'text/plain'), true;
    const container = parts[2].startsWith('stream.') ? parts[2].slice(7) : (q1(q, 'Container') ?? item.Container);
    logPush(LOG.streams, { id: item.Id, route: parts[0] + '/' + parts[2], container, static: /^true$/i.test(q1(q, 'Static') ?? '') });
    const data = audioFile(item);
    const type = item.Container === 'flac' ? 'audio/flac' : 'audio/wav';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(data.subarray(start, end + 1)), true;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    return res.end(data), true;
  }
  // Lyrics. Jellyfin 10.9+: /Audio/{id}/Lyrics (Start in ticks). Emby: the lrc subtitle stream (unverified shape).
  if (parts[0] === 'Audio' && parts[2] === 'Lyrics' && req.method === 'GET') {
    // MOCK_LYRICS_FAIL=<track id>: that track's lyrics answer 500 (the desktop's "no lyrics, no toast" check).
    if (jellyfin && process.env.MOCK_LYRICS_FAIL === parts[1]) return send(res, 500, 'Mock failure', 'text/plain'), true;
    const l = jellyfin && LYRICS.get(parts[1]);
    if (!l) return send(res, 404, 'Not found', 'text/plain'), true;
    const offset = Number(/\[offset:([+-]?\d+)\]/.exec(l.text)?.[1] ?? 0);
    const lines = l.text.split('\n').map((s) => /^\[(\d+):(\d+)(?:\.(\d+))?\](.*)$/.exec(s)).filter(Boolean);
    const Lyrics = l.synced ? lines.map((m) => ({ Text: m[4], Start: Math.round((Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3] ?? 0}`)) * TICKS_S) })) : l.text.trimEnd().split('\n').map((Text) => ({ Text }));
    return send(res, 200, { Metadata: { Title: item?.Name, Artist: item?.Artists?.[0], IsSynced: l.synced, ...(offset ? { Offset: offset * 10_000 } : {}) }, Lyrics }), true;
  }
  if (parts[0] === 'Videos' && parts[3] === 'Subtitles' && /^Stream\.(lrc|txt)$/i.test(parts.at(-1)) && LYRICS.has(parts[1])) {
    const text = LYRICS.get(parts[1]).text;
    return send(res, 200, parts.at(-1).toLowerCase().endsWith('txt') ? text.replace(/^\[[^\]]*\]/gm, '') : text, 'text/plain; charset=utf-8'), true;
  }
  // Genres of the music library: Emby /MusicGenres, Jellyfin /Genres?IncludeItemTypes=MusicAlbum (its /MusicGenres is deprecated).
  const types = q1(q, 'IncludeItemTypes') ?? '';
  if ((p === '/MusicGenres' || (p === '/Genres' && /Music|Audio/.test(types))) && !parts[1]) {
    if (p === '/MusicGenres' && jellyfin) log('DEPRECATED /MusicGenres (Jellyfin: /Genres?includeItemTypes=MusicAlbum)');
    return send(res, 200, list([...items.values()].filter((x) => x.Type === 'MusicGenre'), q)), true;
  }
  // Instant mix: /Items/{id}/InstantMix everywhere; the per-type routes too, as each server has them (spec §3.3).
  const mix = parts.at(-1) === 'InstantMix' && (parts.length === 3 || (parts.length === 2 && parts[0] === 'Artists'));
  if (mix) {
    const kind = parts[0];
    const gone = jellyfin ? parts.length === 2 : kind === 'Artists' && parts.length === 3;
    if (gone || !['Items', 'Albums', 'Songs', 'Playlists', 'Artists', 'MusicGenres'].includes(kind)) return send(res, 404, 'Not found', 'text/plain'), true;
    const id = parts.length === 2 ? q1(q, 'Id') : kind === 'MusicGenres' ? [...items.values()].find((x) => x.Type === 'MusicGenre' && x.Name === decodeURIComponent(parts[1]))?.Id : parts[1];
    if (!items.has(id ?? '')) return send(res, 404, 'Not found', 'text/plain'), true;
    const limit = Number(q1(q, 'Limit') ?? 200);
    logPush(LOG.instantMix, { id, route: `/${parts.join('/')}`, limit });
    const out = instantMix(items, id, limit);
    return send(res, 200, { ...list(out, new URLSearchParams()), TotalRecordCount: out.length }), true;
  }
  // Artists (everyone credited on a track) and album artists, with the A-Z name bounds of the Android TV rail.
  if (p === '/Artists/AlbumArtists' || p === '/Artists') {
    let arr = [...items.values()].filter((x) => x.Type === 'MusicArtist' && (p === '/Artists' || ALBUM_ARTISTS.has(x.Id)));
    for (const [k, keep] of [['NameLessThan', (n, v) => n < v], ['NameStartsWithOrGreater', (n, v) => n >= v], ['NameStartsWith', (n, v) => n.startsWith(v)]]) {
      const v = q1(q, k)?.toLowerCase();
      if (v) arr = arr.filter((x) => keep(sortName(x), v));
    }
    arr.sort((a, b) => (sortName(a) < sortName(b) ? -1 : 1));
    return send(res, 200, list(arr, q)), true;
  }
  return false;
}

// The /Items filters the music views use (both servers' names), on top of mock-emby's own.
export function musicFilters(arr, q, ud) {
  const ids = (k) => q1(q, k)?.split(',');
  const has = (refs, want) => refs?.some((r) => want.includes(r.Id));
  const albumArtists = ids('AlbumArtistIds');
  if (albumArtists) arr = arr.filter((x) => has(x.AlbumArtists, albumArtists));
  const contributing = ids('ContributingArtistIds');
  if (contributing) arr = arr.filter((x) => has(x.ArtistItems, contributing) && !has(x.AlbumArtists, contributing));
  const genres = ids('GenreIds');
  if (genres) arr = arr.filter((x) => has(x.GenreItems, genres));
  const albums = ids('AlbumIds');
  if (albums) arr = arr.filter((x) => albums.includes(x.AlbumId));
  // ImageTypes: only the items that have each of these images (both servers).
  const images = ids('ImageTypes');
  if (images) arr = arr.filter((x) => images.every((t) => (t === 'Backdrop' ? x.BackdropImageTags?.length : x.ImageTags?.[t])));
  const sort = q1(q, 'SortBy') ?? '';
  if (sort.startsWith('PlayCount')) arr.sort((a, b) => (ud(a.Id).PlayCount ?? 0) - (ud(b.Id).PlayCount ?? 0));
  // Random: a fixed shuffle (by a hash of the id), so a check can count on it.
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  if (sort.startsWith('Random')) arr.sort((a, b) => hash(a.Id) - hash(b.Id));
  return arr;
}

// A stand-in for lrclib.net's GET /api/get (music-spec MU-13), served at /mock/lrclib/api/get: the app's LRCLIB_BASE
// points here, so no check ever reaches the real service. A track of the library (title and artist match) answers
// invented synced lyrics; anything else 404 TrackNotFound, as LRCLIB does. Each request lands in LOG.lrclib.
export function lrclibRoute({ req, res, q, items, send }) {
  const row = { artist: q.get('artist_name'), title: q.get('track_name'), album: q.get('album_name'), duration: q.get('duration'), ua: req.headers['user-agent'] ?? '' };
  logPush(LOG.lrclib, row);
  const low = (s) => (s ?? '').toLowerCase();
  const track = [...items.values()].find((x) => isMusic(x) && low(x.Name) === low(row.title) && (x.Artists ?? []).some((a) => low(a) === low(row.artist)));
  if (!track) return send(res, 404, { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' });
  const seconds = Math.round((track.RunTimeTicks ?? 0) / TICKS_S);
  const synced = Array.from({ length: Math.max(2, seconds - 1) }, (_, i) => `[00:${String(i).padStart(2, '0')}.00]En ligne ${i + 1}`).join('\n');
  return send(res, 200, { id: 1, trackName: track.Name, artistName: row.artist, albumName: track.Album, duration: seconds, instrumental: false, plainLyrics: synced.replace(/^\[[^\]]*\]/gm, ''), syncedLyrics: synced });
}
