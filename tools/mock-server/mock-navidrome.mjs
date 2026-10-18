// Mock Navidrome (music-feishin-navidrome spec §4.B, MU-N0): a fake OpenSubsonic server, loopback only, for the
// Navidrome adapter's checks. No real server is ever contacted. The library is the mocks' invented music library
// (music-fixture.mjs: the same artists, albums, silent WAV/FLAC tracks, lyrics, favourites and play counts), turned
// into Subsonic shapes, plus a playlist owned by another user (error 50 on edit) and an LDAP user (error 41).
//
// Port: PORT (default 4533), or startMockNavidrome({ port }) (0 picks a free one).
// Users: wika / mock-pass (the library's owner), lea / mock-pass-lea, ldap (token auth refused: error 41).
// Switches: MOCK_ND_NO_EXT=1 plain Subsonic 1.16.1 (no OpenSubsonic, no extensions: lyrics through getLyrics).
// Auth: token + salt only (t = md5(password + s)). A reused salt answers error 40 (tag SALT-REUSE); p= answers error
// 40 (tag CLEARTEXT-PASSWORD), the app never sends a password.
// Tags (a run's log reads as a bug list): UNMAPPED (an endpoint the mock does not know), SALT-REUSE,
// CLEARTEXT-PASSWORD, DUP-SCROBBLE (a second submission for a track within its length), SIZE-ZERO (getCoverArt
// without size), NO-JSON (a call without f=json).
// Mock routes (no auth): GET /Mock/State, POST /Mock/Reset.
// Usage: node tools/mock-server/mock-navidrome.mjs   or   import { startMockNavidrome } from './mock-navidrome.mjs'
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { png } from './cbz-fixture.mjs';
import { addMusic, audioFile, GAIN, LYRICS } from './music-fixture.mjs';

export const USERS = { wika: 'mock-pass', lea: 'mock-pass-lea', ldap: null };
const TICKS_S = 10_000_000;
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// The Emby-shaped fixture, built once, read into Subsonic records.
function library() {
  const items = new Map();
  const lists = new Map();
  const ud = new Map();
  const udOf = (id) => (ud.has(id) ? ud.get(id) : (ud.set(id, {}), ud.get(id)));
  addMusic({ add: (x) => items.set(x.Id, x), makeList: (id, name, _type, ids) => lists.set(id, { name, ids }), ud: udOf });
  const all = [...items.values()];
  const artists = all.filter((x) => x.Type === 'MusicArtist');
  const albums = all.filter((x) => x.Type === 'MusicAlbum');
  const songs = all.filter((x) => x.Type === 'Audio');
  const starred = new Map();
  for (const [id, u] of ud) if (u.IsFavorite) starred.set(id, '2026-01-02T03:04:05Z');
  const plays = new Map([...ud].filter(([, u]) => u.PlayCount).map(([id, u]) => [id, u.PlayCount]));
  const cover = (x) => (x.Type === 'MusicArtist' ? (x.ImageTags?.Primary ? `ar-${x.Id}_0` : undefined) : x.Type === 'MusicAlbum' ? (x.ImageTags?.Primary ? `al-${x.Id}_0` : undefined) : undefined);
  return { items, lists, artists, albums, songs, starred, plays, cover };
}

export async function startMockNavidrome(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const ext = env.MOCK_ND_NO_EXT !== '1';
  let lib = library();
  const fresh = () => ({ calls: [], tags: [], scrobbles: [], streams: [], covers: [], stars: [], playlistEdits: [] });
  const state = fresh();
  const salts = new Set();
  const lastSubmit = new Map(); // track id -> ms
  // Playlists: id -> { name, owner, public, songs: [native song id] }.
  let playlists = new Map();
  const resetLists = () => {
    playlists = new Map([...lib.lists].map(([id, l]) => [id, { name: l.name, owner: 'wika', public: false, songs: [...l.ids], created: '2026-01-01T00:00:00Z' }]));
    playlists.set('playlist-lea', { name: 'Playlist de Léa', owner: 'lea', public: true, songs: [lib.songs[1].Id, lib.songs[3].Id], created: '2026-01-03T00:00:00Z' });
  };
  resetLists();
  let nextList = 1;
  const tag = (t, detail = '') => {
    state.tags.push(t);
    if (!opts.quiet) console.log(`[mock-navidrome] ${t} ${detail}`);
  };

  // ---- Subsonic records ----
  const star = (id) => (lib.starred.has(id) ? { starred: lib.starred.get(id) } : {});
  const plays = (id) => (lib.plays.has(id) ? { playCount: lib.plays.get(id) } : {});
  const albumOf = (s) => lib.items.get(s.AlbumId);
  const artistRec = (a) => ({ id: a.Id, name: a.Name, albumCount: lib.albums.filter((al) => al.AlbumArtists?.[0]?.Id === a.Id).length, ...(lib.cover(a) ? { coverArt: lib.cover(a) } : {}), ...star(a.Id) });
  const albumRec = (al) => {
    const songs = lib.songs.filter((s) => s.AlbumId === al.Id);
    return {
      id: al.Id, name: al.Name, artist: al.AlbumArtist, artistId: al.AlbumArtists?.[0]?.Id, songCount: songs.length,
      duration: Math.round(songs.reduce((n, s) => n + s.RunTimeTicks / TICKS_S, 0)), year: al.ProductionYear, genre: al.Genres?.[0], created: al.DateCreated,
      ...(lib.cover(al) ? { coverArt: lib.cover(al) } : {}), ...star(al.Id), ...plays(al.Id),
      ...(ext ? { genres: (al.Genres ?? []).map((name) => ({ name })), ...(GAIN.has(al.Id) ? { replayGain: { albumGain: GAIN.get(al.Id) } } : {}), discTitles: al.Name === 'Suites en deux temps' ? [{ disc: 1, title: 'Premier temps' }, { disc: 2, title: 'Second temps' }] : [] } : {}),
    };
  };
  const songRec = (s) => {
    const al = albumOf(s);
    const art = al && lib.cover(al) ? lib.cover(al) : s.ImageTags?.Primary ? `mf-${s.Id}_0` : undefined;
    return {
      id: s.Id, parent: s.AlbumId, isDir: false, title: s.Name, album: s.Album, artist: s.Artists?.[0], track: s.IndexNumber, discNumber: s.ParentIndexNumber, year: s.ProductionYear,
      genre: s.Genres?.[0], size: audioFile(s).length, contentType: s.Container === 'flac' ? 'audio/flac' : 'audio/wav', suffix: s.Container, duration: Math.round(s.RunTimeTicks / TICKS_S),
      bitRate: s.Container === 'flac' ? 90 : 128, albumId: s.AlbumId, artistId: s.ArtistItems?.[0]?.Id, type: 'music', ...(art ? { coverArt: art } : {}), ...star(s.Id), ...plays(s.Id),
      ...(ext ? { mediaType: 'song', samplingRate: 8000, channelCount: 1, bitDepth: 16, displayAlbumArtist: s.AlbumArtist, albumArtists: (s.AlbumArtists ?? []).map((a) => ({ id: a.Id, name: a.Name })), ...(GAIN.has(s.Id) ? { replayGain: { trackGain: GAIN.get(s.Id), albumGain: GAIN.get(s.AlbumId) } } : {}) } : {}),
    };
  };
  const playlistRec = (id, p) => ({ id, name: p.name, owner: p.owner, public: p.public, songCount: p.songs.length, duration: p.songs.reduce((n, sid) => n + Math.round((lib.items.get(sid)?.RunTimeTicks ?? 0) / TICKS_S), 0), created: p.created, changed: p.created, coverArt: `pl-${id}_0` });
  const sorted = (arr) => [...arr].sort((a, b) => a.Name.localeCompare(b.Name, 'fr'));
  const ok = (body = {}) => ({ status: 'ok', version: '1.16.1', ...(ext ? { type: 'navidrome', serverVersion: '0.53.0 (mock)', openSubsonic: true } : {}), ...body });
  const fail = (code, message) => ({ ...ok(), status: 'failed', error: { code, message } });

  // ---- The API ----
  function api(name, q, user) {
    const all = (k) => q.getAll(k);
    const one = (k) => q.get(k) ?? undefined;
    const int = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
    const notFound = () => fail(70, 'Requested data was not found');
    switch (name) {
      case 'ping':
        return ok();
      case 'getLicense':
        return ok({ license: { valid: true } });
      case 'getOpenSubsonicExtensions':
        return ext ? ok({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }, { name: 'formPost', versions: [1] }] }) : fail(70, 'Not found');
      case 'getMusicFolders':
        return ok({ musicFolders: { musicFolder: [{ id: 1, name: 'Musique' }] } });
      case 'getArtists': {
        const index = new Map();
        for (const a of sorted(lib.artists.filter((a) => artistRec(a).albumCount > 0))) {
          const letter = a.Name[0].toUpperCase();
          if (!index.has(letter)) index.set(letter, []);
          index.get(letter).push(artistRec(a));
        }
        return ok({ artists: { ignoredArticles: 'The Le Les', index: [...index].map(([n, artist]) => ({ name: n, artist })) } });
      }
      case 'getArtist': {
        const a = lib.items.get(one('id'));
        if (a?.Type !== 'MusicArtist') return notFound();
        return ok({ artist: { ...artistRec(a), album: lib.albums.filter((al) => al.AlbumArtists?.[0]?.Id === a.Id).map(albumRec) } });
      }
      case 'getArtistInfo2': {
        const a = lib.items.get(one('id'));
        if (a?.Type !== 'MusicArtist') return notFound();
        return ok({ artistInfo2: { biography: `<p>${a.Name}, un artiste <b>inventé</b> pour les tests.</p>`, similarArtist: [] } });
      }
      case 'getAlbum': {
        const al = lib.items.get(one('id'));
        if (al?.Type !== 'MusicAlbum') return notFound();
        return ok({ album: { ...albumRec(al), song: lib.songs.filter((s) => s.AlbumId === al.Id).map(songRec) } });
      }
      case 'getSong': {
        const s = lib.items.get(one('id'));
        return s?.Type === 'Audio' ? ok({ song: songRec(s) }) : notFound();
      }
      case 'getAlbumList2': {
        const type = one('type');
        let arr = lib.albums;
        if (type === 'alphabeticalByName') arr = sorted(arr);
        else if (type === 'alphabeticalByArtist') arr = [...arr].sort((a, b) => a.AlbumArtist.localeCompare(b.AlbumArtist, 'fr') || a.Name.localeCompare(b.Name, 'fr'));
        else if (type === 'newest') arr = [...arr].sort((a, b) => b.DateCreated.localeCompare(a.DateCreated));
        else if (type === 'frequent') arr = arr.filter((a) => lib.plays.has(a.Id) || lib.songs.some((s) => s.AlbumId === a.Id && lib.plays.has(s.Id)));
        else if (type === 'random' || type === 'recent') arr = [...arr];
        else if (type === 'starred') arr = arr.filter((a) => lib.starred.has(a.Id));
        else if (type === 'byGenre') arr = arr.filter((a) => a.Genres?.includes(one('genre')));
        else if (type === 'byYear') {
          const [from, to] = [int('fromYear', 0), int('toYear', 9999)];
          arr = arr.filter((a) => a.ProductionYear >= Math.min(from, to) && a.ProductionYear <= Math.max(from, to)).sort((a, b) => (from <= to ? a.ProductionYear - b.ProductionYear : b.ProductionYear - a.ProductionYear));
        } else return fail(10, 'Required parameter is missing: type');
        const offset = int('offset', 0);
        return ok({ albumList2: { album: arr.slice(offset, offset + Math.min(int('size', 10), 500)).map(albumRec) } });
      }
      case 'getGenres': {
        const names = [...new Set(lib.albums.flatMap((a) => a.Genres ?? []))];
        return ok({ genres: { genre: names.map((value) => ({ value, albumCount: lib.albums.filter((a) => a.Genres?.includes(value)).length, songCount: lib.songs.filter((s) => s.Genres?.includes(value)).length })) } });
      }
      case 'search3': {
        const term = (one('query') ?? '').replace(/^"|"$/g, '').toLowerCase();
        const hit = (x) => !term || x.Name.toLowerCase().includes(term) || (x.Album ?? '').toLowerCase().includes(term);
        const page = (arr, kind) => arr.slice(int(`${kind}Offset`, 0), int(`${kind}Offset`, 0) + int(`${kind}Count`, 20));
        return ok({ searchResult3: { artist: page(sorted(lib.artists).filter(hit), 'artist').map(artistRec), album: page(sorted(lib.albums).filter(hit), 'album').map(albumRec), song: page(lib.songs.filter(hit), 'song').map(songRec) } });
      }
      case 'getRandomSongs': {
        const g = one('genre');
        return ok({ randomSongs: { song: lib.songs.filter((s) => !g || s.Genres?.includes(g)).slice(0, int('size', 10)).map(songRec) } });
      }
      case 'getSimilarSongs':
      case 'getSimilarSongs2':
        // No external agent in the mock: Navidrome without Last.fm answers an empty list too.
        return ok({ [name === 'getSimilarSongs' ? 'similarSongs' : 'similarSongs2']: { song: [] } });
      case 'getSongsByGenre': {
        const offset = int('offset', 0);
        return ok({ songsByGenre: { song: lib.songs.filter((s) => s.Genres?.includes(one('genre'))).slice(offset, offset + int('count', 10)).map(songRec) } });
      }
      case 'getTopSongs': {
        const a = lib.artists.find((x) => x.Name === one('artist'));
        return ok({ topSongs: { song: a ? lib.songs.filter((s) => s.ArtistItems?.some((x) => x.Id === a.Id)).slice(0, int('count', 50)).map(songRec) : [] } });
      }
      case 'getStarred2': {
        const of = (arr) => arr.filter((x) => lib.starred.has(x.Id));
        return ok({ starred2: { artist: of(lib.artists).map(artistRec), album: of(lib.albums).map(albumRec), song: of(lib.songs).map(songRec) } });
      }
      case 'star':
      case 'unstar': {
        const ids = [...all('id'), ...all('albumId'), ...all('artistId')];
        if (!ids.length) return fail(10, 'Required parameter is missing: id');
        for (const id of ids) {
          if (!lib.items.has(id)) return notFound();
          if (name === 'star') lib.starred.set(id, new Date().toISOString());
          else lib.starred.delete(id);
          state.stars.push({ op: name, id, as: q.has('id') ? 'id' : q.has('albumId') ? 'albumId' : 'artistId' });
        }
        return ok();
      }
      case 'getPlaylists':
        return ok({ playlists: { playlist: [...playlists].filter(([, p]) => p.owner === user || p.public).map(([id, p]) => playlistRec(id, p)) } });
      case 'getPlaylist': {
        const p = playlists.get(one('id'));
        if (!p || (p.owner !== user && !p.public)) return notFound();
        return ok({ playlist: { ...playlistRec(one('id'), p), entry: p.songs.map((sid) => songRec(lib.items.get(sid))) } });
      }
      case 'createPlaylist': {
        const songs = all('songId');
        if (songs.some((s) => lib.items.get(s)?.Type !== 'Audio')) return notFound();
        let id = one('playlistId');
        if (id) {
          const p = playlists.get(id);
          if (!p) return notFound();
          if (p.owner !== user) return fail(50, 'User not authorized');
          p.songs = songs;
        } else {
          if (!one('name')) return fail(10, 'Required parameter is missing: name');
          id = `playlist-new-${nextList++}`;
          playlists.set(id, { name: one('name'), owner: user, public: false, songs, created: new Date().toISOString() });
        }
        state.playlistEdits.push({ op: 'create', id, songs });
        return ok({ playlist: { ...playlistRec(id, playlists.get(id)), entry: songs.map((sid) => songRec(lib.items.get(sid))) } });
      }
      case 'updatePlaylist': {
        const id = one('playlistId');
        const p = playlists.get(id);
        if (!p) return notFound();
        if (p.owner !== user) return fail(50, 'User not authorized');
        const add = all('songIdToAdd');
        if (add.some((s) => lib.items.get(s)?.Type !== 'Audio')) return notFound();
        const remove = all('songIndexToRemove').map(Number);
        p.songs = p.songs.filter((_, i) => !remove.includes(i)).concat(add);
        if (one('name')) p.name = one('name');
        state.playlistEdits.push({ op: 'update', id, add, remove });
        return ok();
      }
      case 'deletePlaylist': {
        const p = playlists.get(one('id'));
        if (!p) return notFound();
        if (p.owner !== user) return fail(50, 'User not authorized');
        playlists.delete(one('id'));
        return ok();
      }
      case 'scrobble': {
        const submission = one('submission') !== 'false';
        for (const id of all('id')) {
          const s = lib.items.get(id);
          if (s?.Type !== 'Audio') return notFound();
          state.scrobbles.push({ id, submission, time: one('time') });
          if (!submission) continue;
          const last = lastSubmit.get(id);
          if (last && Date.now() - last < (s.RunTimeTicks / TICKS_S) * 1000) tag('DUP-SCROBBLE', id);
          lastSubmit.set(id, Date.now());
          lib.plays.set(id, (lib.plays.get(id) ?? 0) + 1);
        }
        return ok();
      }
      case 'getLyricsBySongId': {
        if (!ext) return null;
        const s = lib.items.get(one('id'));
        if (s?.Type !== 'Audio') return notFound();
        const l = LYRICS.get(s.Id);
        if (!l) return ok({ lyricsList: { structuredLyrics: [] } });
        const offset = Number(/\[offset:([+-]?\d+)\]/.exec(l.text)?.[1] ?? 0);
        const line = l.text.split('\n').map((x) => (l.synced ? /^\[(\d+):(\d+)(?:\.(\d+))?\](.*)$/.exec(x) : null)).filter(Boolean);
        const lines = l.synced ? line.map((m) => ({ start: (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(`0.${m[3] ?? 0}`) * 1000, value: m[4] })) : l.text.trimEnd().split('\n').map((value) => ({ value }));
        return ok({ lyricsList: { structuredLyrics: [{ lang: 'fra', synced: l.synced, displayArtist: s.Artists?.[0], displayTitle: s.Name, offset, line: lines }] } });
      }
      case 'getLyrics': {
        const s = lib.songs.find((x) => x.Name === one('title') && x.Artists?.includes(one('artist')));
        const l = s && LYRICS.get(s.Id);
        return ok({ lyrics: l ? { artist: one('artist'), title: one('title'), value: l.text.replace(/^\[[^\]]*\]/gm, '') } : {} });
      }
      case 'getScanStatus':
        return ok({ scanStatus: { scanning: false, count: lib.songs.length } });
      default:
        return null;
    }
  }

  function media(name, q, req, res) {
    if (name === 'getCoverArt') {
      const id = q.get('id') ?? '';
      if (!q.get('size')) tag('SIZE-ZERO', id);
      state.covers.push({ id, size: q.get('size') });
      const size = Math.min(Number(q.get('size')) || 600, 1200);
      const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 255;
      const body = png(Math.max(8, Math.round(size / 8)), Math.max(8, Math.round(size / 8)), () => [hue, 255 - hue, 128]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'public, max-age=315360000' });
      return res.end(body);
    }
    const s = lib.items.get(q.get('id') ?? '');
    if (s?.Type !== 'Audio') return send(res, fail(70, 'Requested data was not found'));
    state.streams.push({ id: s.Id, op: name, format: q.get('format') ?? null, range: req.headers.range ?? null });
    const data = audioFile(s);
    const type = s.Container === 'flac' ? 'audio/flac' : 'audio/wav';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : data);
  }

  function send(res, body, status = 200) {
    const data = Buffer.from(JSON.stringify({ 'subsonic-response': body }));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
  }

  // The user a request authenticates as, or the error to answer.
  // A media URL (stream, download, cover) is handed to a player that re-sends it (HEAD, then ranges): its salt may
  // repeat. An API call's may not.
  function auth(q, media) {
    if (q.has('p')) return tag('CLEARTEXT-PASSWORD'), fail(40, 'Wrong username or password');
    const [u, t, s] = [q.get('u'), q.get('t'), q.get('s')];
    if (!u || !t || !s) return fail(10, 'Required parameter is missing');
    if (!(u in USERS)) return fail(40, 'Wrong username or password');
    if (USERS[u] === null) return fail(41, 'Token authentication not supported for LDAP users');
    if (!media && salts.has(s)) return tag('SALT-REUSE', s), fail(40, 'Wrong username or password');
    salts.add(s);
    return md5(USERS[u] + s) === t.toLowerCase() ? u : fail(40, 'Wrong username or password');
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://mock');
      const p = url.pathname;
      if (p === '/Mock/State') return send(res, state);
      if (p === '/Mock/Reset' && req.method === 'POST') {
        Object.assign(state, fresh());
        lib = library();
        resetLists();
        lastSubmit.clear();
        return send(res, {});
      }
      // What Wicaby's add-server probe asks first (Emby/Jellyfin, then Plex): not this server, as on a real Navidrome.
      if (/^(\/emby)?\/System\/Info\/Public$|^\/identity$/.test(p)) return res.writeHead(404).end('Not found');
      const m = /^\/rest\/([A-Za-z0-9]+?)(?:\.view)?$/.exec(p);
      if (!m) return tag('UNMAPPED', `${req.method} ${p}`), res.writeHead(404).end('Not found');
      // formPost: the same parameters in an urlencoded body.
      const q = new URLSearchParams(url.search);
      if (req.method === 'POST') for (const [k, v] of new URLSearchParams(await readBody(req))) q.append(k, v);
      state.calls.push(m[1]);
      const who = auth(q, ['stream', 'download', 'getCoverArt'].includes(m[1]));
      if (typeof who !== 'string') return send(res, who);
      if (['stream', 'download', 'getCoverArt'].includes(m[1])) return media(m[1], q, req, res);
      if (q.get('f') !== 'json') tag('NO-JSON', m[1]);
      const body = api(m[1], q, who);
      if (!body) return tag('UNMAPPED', m[1]), res.writeHead(404).end('Not found');
      return send(res, body);
    } catch (err) {
      console.error('[mock-navidrome]', err);
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });
  const port = await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(opts.port ?? Number(env.PORT ?? 4533), '127.0.0.1', () => resolve(srv.address().port));
  });
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    songs: () => lib.songs.map((s) => s.Id),
    playlists: () => playlists,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const m = await startMockNavidrome();
  console.log(`Mock Navidrome: ${m.url} (wika / mock-pass)`);
}
