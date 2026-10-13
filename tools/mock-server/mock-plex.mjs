// Mock Plex (plex-spec §10, PX-01): a fake Plex Media Server plus a fake plex.tv, loopback only, for the Plex
// dialect's checks. No real Plex server or plex.tv is ever contacted. The dataset reuses the demo catalogue
// (demo/demo-dataset.mjs: the Blender open movies and their CC BY artwork); shows B and C, the music and the
// people are invented.
//
// Ports (env, or startMockPlex({ port, tvPort, … }); 0 picks a free one):
//   PORT 32400              the PMS ("Maison", owned)
//   MOCK_PLEXTV_PORT 32401  plex.tv: PIN link, user, resources, Home users. The app points at it through
//                           WICABY_PLEXTV_BASE=http://127.0.0.1:32401 (dev builds only).
//   MOCK_PLEX_RELAY_PORT 32402  the "relay": a proxy to the PMS that adds 400 ms.
//   MOCK_PLEX_SECOND=1      a second PMS, "Chez Léa" (shared), on MOCK_PLEX_SECOND_PORT (32410).
//   MOCK_PLEX_TLS=1         the PMS again over TLS on MOCK_PLEX_TLS_PORT (32443) with the TEST ONLY pair in
//                           fixtures/cast-tls/, listed as a plex.direct name (MOCK_PLEX_DIRECT_HOST).
// Switches (the Plezy cases of plex-spec §10):
//   MOCK_PLEX_HTTPS_REQUIRED=1  plain-http PMS calls get 403 (tag HTTP-REFUSED); resources say httpsRequired.
//   MOCK_PIN_TTL_S=n            PINs expire after n s (default 900).
//   MOCK_REMOTE_CAP_KBPS=n      a remote decision above n kbps (or with no cap) answers 500 "Cannot make a decision".
//   MOCK_REMOTE_PASS=0          a remote decision answers 403 (remote playback needs a pass).
//   MOCK_PLEX_FLAKY=1           the first PMS request of each minute answers 500.
//   MOCK_PLEX_PASS=0            no Plex Pass on the owner: /livetv/dvrs answers 403.
//   MOCK_PLEX_LIVETV=1          /livetv/dvrs lists one DVR (its channels and grid are PX-11, after real captures).
//   MOCK_PLEX_VIDEO=<file>      the file every Part.key serves (with Range); without it a part answers 404.
// Tags (a run's log reads as a bug list): UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID, NO-TOKEN, ACCOUNT-TOKEN-ON-PMS,
// HTTP-REFUSED, DUP-STOPPED, AFTER-STOPPED, DUP-SCROBBLE, SEEK-AFTER-OFFSET, FLAKY.
// Mock routes (no auth, on the PMS and plex.tv ports): GET /Mock/State, POST /Mock/Reset, POST /Mock/Pin/Link?code=,
// POST /Mock/Home/SetPin?user=&pin=, POST /Mock/Terminate?session=&reason= (a 'playing' stopped notification now, the
// reason on the session's next timeline), POST /Mock/Broadcast (JSON body: one notification pushed to every
// notifications socket).
// Usage: node tools/mock-server/mock-plex.mjs   or   import { startMockPlex } from './mock-plex.mjs'
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { bif, png } from './cbz-fixture.mjs';
import { MOVIES, SERIES } from './demo/demo-dataset.mjs';
import { frame } from './ws.mjs';

const DEMO = path.join(import.meta.dirname, 'demo');
const ART = {};
for (const img of JSON.parse(fs.readFileSync(path.join(DEMO, 'ATTRIBUTION.json'), 'utf8')).images) (ART[img.film] ??= {})[img.role] = path.join(DEMO, img.file);

export const ACCOUNT_TOKEN = 'mock-account-token';
export const MACHINE_ID = 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0';
export const SECOND_ID = 'e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1';
const LIBRARY = 'com.plexapp.plugins.library';
const USERS = [
  { id: 1, uuid: 'a1b2c3d4e5f60718', title: 'Wika', admin: true, protected: false, pin: '' },
  { id: 2, uuid: 'b2c3d4e5f6071829', title: 'Ado', admin: false, protected: true, pin: '1234' },
  { id: 3, uuid: 'c3d4e5f60718293a', title: 'Invité', admin: false, protected: false, pin: '' },
];
const OWNER = USERS[0];
const TS = (rk) => 1_700_000_000 + Number(rk);
const ms = (ticks) => Math.round(ticks / 10_000);

// ---- Dataset ----

const items = new Map(); // ratingKey -> metadata (PMS JSON shape, full detail)
const art = new Map(); // ratingKey -> { thumb: file, art: file }
const add = (m) => (items.set(String(m.ratingKey), m), m);
let personSeq = 900;
const persons = new Map();
const personOf = (name) => (persons.has(name) ? persons.get(name) : (persons.set(name, ++personSeq), personSeq));

function meta(rk, type, title, extra = {}) {
  const t = TS(rk);
  return { ratingKey: String(rk), key: `/library/metadata/${rk}`, type, title, titleSort: title.replace(/^(The|Le|La|Les) /, ''), guid: `plex://${type}/mock${rk}`, addedAt: t - 86_400 * (Number(rk) % 50), updatedAt: t, thumb: `/library/metadata/${rk}/thumb/${t}`, art: `/library/metadata/${rk}/art/${t}`, ...extra };
}

let streamSeq = 48_200;
function stream(type, extra) {
  return { id: ++streamSeq, streamType: type, ...extra };
}
const videoH264 = () => stream(1, { codec: 'h264', index: 0, default: true, width: 1920, height: 1080, frameRate: 24, displayTitle: '1080p (H.264)' });
const audioStd = () => [
  stream(2, { codec: 'eac3', index: 1, default: true, selected: true, channels: 6, language: 'English', languageCode: 'eng', displayTitle: 'English (EAC3 5.1)' }),
  stream(2, { codec: 'aac', index: 2, channels: 2, language: 'Français', languageCode: 'fre', displayTitle: 'Français (AAC Stereo)' }),
];
const subsStd = () => [stream(3, { codec: 'srt', index: 3, language: 'English', languageCode: 'eng', displayTitle: 'English (SRT)' })];

let partSeq = 50_000;
function media(id, { container = 'mkv', video = videoH264(), audio = audioStd(), subs = subsStd(), parts = 1, duration, extra = {}, partExtra = {} } = {}) {
  const Part = [];
  for (let i = 0; i < parts; i++) {
    const pid = ++partSeq;
    const ext = i === 0 ? [{ ...video }, ...audio.map((a) => ({ ...a })), ...subs.map((s) => ({ ...s }))] : [{ ...video, id: ++streamSeq }, ...audio.map((a) => ({ ...a, id: ++streamSeq }))];
    // A sidecar subtitle is served at /library/streams/{id}.
    for (const s of ext) if (s.streamType === 3 && s.sidecar) (s.key = `/library/streams/${s.id}`), delete s.sidecar;
    Part.push({ id: pid, key: `/library/parts/${pid}/${TS(pid)}/file.${container}`, duration: Math.round(duration / parts), file: `/data/media/${id}-${i}.${container}`, size: 1_500_000_000, container, indexes: 'sd', Stream: ext, ...partExtra });
  }
  const v = video;
  return { id, duration, bitrate: 8000, width: v.width, height: v.height, videoResolution: v.height >= 2000 ? '4k' : String(v.height), container, videoCodec: v.codec, audioCodec: audio[0]?.codec, Part, ...extra };
}

// Films (section 1): the 12 demo films, with the Plezy shapes on the first six.
const SECTION_FILMS = 1;
const SECTION_SHOWS = 2;
const SECTION_MUSIC = 3;
MOVIES.forEach((mv, i) => {
  const rk = 1000 + i;
  const duration = ms(mv.runtime);
  const people = mv.people ?? [];
  const m = meta(rk, 'movie', mv.name, {
    librarySectionID: SECTION_FILMS,
    year: mv.year,
    summary: mv.overview,
    tagline: mv.tagline,
    contentRating: mv.rating,
    audienceRating: mv.score,
    audienceRatingImage: 'imdb://image.rating',
    duration,
    originallyAvailableAt: `${mv.year}-06-01`,
    studio: 'Blender Studio',
    Guid: [{ id: `tmdb://${100_000 + i}` }],
    Genre: (mv.genres ?? []).map((g, j) => ({ id: 100 + ((i + j) % 9), tag: g })),
    Director: people.filter((p) => p.Type === 'Director').map((p) => ({ id: personOf(p.Name), tag: p.Name })),
    Role: people.filter((p) => p.Type === 'Actor').map((p) => ({ id: personOf(p.Name), tag: p.Name, role: p.Role })),
    Rating: [{ image: 'imdb://image.rating', value: mv.score, type: 'audience' }],
    allowSync: true,
  });
  art.set(String(rk), { thumb: ART[mv.slug]?.poster, art: ART[mv.slug]?.backdrop });
  if (i === 0) {
    // Two editions (versions), a trailer and a featurette, markers (an intro on a film is ignored by clients).
    m.guid = 'com.plexapp.agents.imdb://tt1254207?lang=en';
    delete m.Guid;
    m.Media = [media(10_001, { duration, extra: { editionTitle: 'Theatrical' } }), media(10_002, { duration, video: stream(1, { codec: 'hevc', index: 0, default: true, width: 3840, height: 2160, frameRate: 24 }), extra: { editionTitle: "Director's Cut" } })];
    m.Marker = [{ type: 'intro', startTimeOffset: 5_000, endTimeOffset: 25_000 }, { type: 'credits', startTimeOffset: duration - 60_000, endTimeOffset: duration, final: true }];
    m.Extras = { size: 2, Metadata: [meta(7000, 'clip', `${mv.name}: Trailer`, { extraType: 1, duration: 33_000, Media: [media(17_000, { duration: 33_000, subs: [] })] }), meta(7001, 'clip', `${mv.name}: Making of`, { extraType: 5, duration: 300_000, Media: [media(17_001, { duration: 300_000, subs: [] })] })] };
  } else if (i === 1) {
    // The second version's file is gone (Plezy #919, #1201): clients hide it.
    m.Media = [media(10_011, { duration }), media(10_012, { duration, partExtra: { exists: false, accessible: false } })];
  } else if (i === 2) {
    m.Media = [media(10_021, { duration, video: stream(1, { codec: 'hevc', index: 0, default: true, width: 3840, height: 2160, frameRate: 24, colorTrc: 'smpte2084', colorPrimaries: 'bt2020', displayTitle: '4K HDR10 (HEVC Main 10)' }) })];
    m.viewOffset = 300_000;
    m.lastViewedAt = TS(rk) - 3600;
    m.Chapter = [{ index: 1, tag: 'Opening', startTimeOffset: 0, endTimeOffset: 120_000 }, { index: 2, tag: 'The dragon', startTimeOffset: 120_000, endTimeOffset: 600_000 }, { index: 3, tag: 'Ending', startTimeOffset: 600_000, endTimeOffset: duration }];
  } else if (i === 3) {
    m.Media = [media(10_031, { duration, video: stream(1, { codec: 'hevc', index: 0, default: true, width: 3840, height: 2160, frameRate: 24, colorTrc: 'smpte2084', colorPrimaries: 'bt2020', DOVIPresent: true, DOVIProfile: 8, DOVILevel: 6, DOVIBLCompatID: 1, displayTitle: '4K DoVi/HDR10 (HEVC Main 10)' }) })];
  } else if (i === 4) {
    // PGS plus forced and regular English text subtitles (one sidecar).
    m.Media = [media(10_041, { duration, subs: [stream(3, { codec: 'pgs', index: 3, language: 'English', languageCode: 'eng', displayTitle: 'English (PGS)' }), stream(3, { codec: 'srt', index: 4, forced: true, language: 'English', languageCode: 'eng', displayTitle: 'English Forced (SRT)' }), stream(3, { codec: 'srt', index: 5, language: 'English', languageCode: 'eng', sidecar: true, displayTitle: 'English (SRT External)' })] })];
  } else if (i === 5) {
    // A film in two parts (D-4: one queue).
    m.Media = [media(10_051, { duration, parts: 2 })];
  } else {
    m.Media = [media(10_000 + i * 10 + 1, { duration })];
    if (i === 7) (m.viewCount = 1), (m.lastViewedAt = TS(rk) - 86_400);
  }
  add(m);
});
// A single item shared with this account outside any library listing (Plezy #702): search finds it.
add(meta(1100, 'movie', 'Agent 327: Operation Barbershop', { librarySectionID: 99, year: 2017, duration: 230_000, summary: 'A single film shared with you.', Media: [media(11_001, { duration: 230_000 })] }));

// Shows (section 2). A: markers, BIF, per-show audio memory. B: flattenSeasons. C: a two-episode file.
function show(rk, title, extra, seasons) {
  const s = add(meta(rk, 'show', title, { librarySectionID: SECTION_SHOWS, ...extra }));
  let leaves = 0;
  let viewed = 0;
  seasons.forEach(([srk, index, eps]) => {
    add(meta(srk, 'season', index === 0 ? 'Specials' : `Season ${index}`, { index, parentRatingKey: String(rk), parentTitle: title, parentThumb: s.thumb, librarySectionID: SECTION_SHOWS, leafCount: eps.length, viewedLeafCount: eps.filter((e) => e.viewCount).length }));
    for (const e of eps) {
      leaves++;
      if (e.viewCount) viewed++;
      add({ ...meta(e.rk, 'episode', e.title, { librarySectionID: SECTION_SHOWS }), index: e.index, parentIndex: index, parentRatingKey: String(srk), parentTitle: index === 0 ? 'Specials' : `Season ${index}`, grandparentRatingKey: String(rk), grandparentTitle: title, grandparentThumb: s.thumb, grandparentArt: s.art, ...e.extra });
    }
  });
  Object.assign(s, { childCount: seasons.length, leafCount: leaves, viewedLeafCount: viewed });
}
const camEps = SERIES.episodes.map((e, i) => {
  const duration = ms(e.runtime);
  return {
    rk: 2002 + i,
    index: e.index,
    title: e.name,
    extra: {
      summary: e.overview,
      year: e.year,
      duration,
      Media: [media(20_000 + i, { duration, audio: [stream(2, { codec: 'aac', index: 1, default: true, channels: 2, languageCode: 'eng', displayTitle: 'English (AAC Stereo)' }), stream(2, { codec: 'aac', index: 2, selected: true, channels: 2, languageCode: 'fre', displayTitle: 'Français (AAC Stereo)' })] })],
      Marker: [{ type: 'intro', startTimeOffset: 3_000, endTimeOffset: 15_000 }, { type: 'credits', startTimeOffset: duration - 20_000, endTimeOffset: duration, final: true }],
      ...(i === 0 ? { viewCount: 1 } : {}),
      ...(i === 1 ? { viewOffset: 40_000, lastViewedAt: TS(2003) - 600 } : {}),
    },
  };
});
show(2000, SERIES.name, { summary: SERIES.overview, year: SERIES.year, contentRating: SERIES.rating, audienceRating: SERIES.score, Guid: [{ id: 'tvdb://270000' }] }, [[2001, 1, camEps]]);
SERIES.episodes.forEach((e, i) => art.set(String(2002 + i), { thumb: ART[SERIES.slug]?.[e.role] }));
art.set('2000', { thumb: ART[SERIES.slug]?.poster, art: ART[SERIES.slug]?.backdrop });
art.set('2001', { thumb: ART[SERIES.slug]?.poster });
const plainEp = (rk, index, title) => ({ rk, index, title, extra: { duration: 600_000, Media: [media(rk * 10, { duration: 600_000 })] } });
show(2100, 'Studio Diaries', { flattenSeasons: 1, year: 2021, summary: 'Short weekly notes from an animation studio (seasons hidden by the server).' }, [[2101, 1, [plainEp(2102, 1, 'Pitch'), plainEp(2103, 2, 'Storyboard'), plainEp(2104, 3, 'Layout'), plainEp(2105, 4, 'Lighting')]]]);
const shared = media(22_100, { duration: 2_640_000 });
const twoInOne = (rk, index, title) => ({ rk, index, title, extra: { duration: 1_320_000, Media: [shared] } });
show(2200, 'Open Movie Nights', { year: 2019, summary: 'An anthology; the season 2 finale is one file holding two episodes.' }, [[2201, 1, [plainEp(2202, 1, 'Opening Night')]], [2203, 2, [plainEp(2204, 16, 'Rehearsal'), twoInOne(2210, 17, 'Finale, Part 1'), twoInOne(2211, 18, 'Finale, Part 2')]]]);

// Music (section 3): 2 artists, 3 albums, 12 tracks (no audio files: parts answer like any other).
[
  [3000, 'Les Lamas Sonores', [[3001, 'Altiplano', 2019], [3002, 'Patagonia Nights', 2021]]],
  [3100, 'Orchestre du Studio', [[3101, 'Open Scores', 2020]]],
].forEach(([rk, name, albums]) => {
  add(meta(rk, 'artist', name, { librarySectionID: SECTION_MUSIC, childCount: albums.length, summary: 'An invented band.' }));
  albums.forEach(([ark, title, year]) => {
    add(meta(ark, 'album', title, { librarySectionID: SECTION_MUSIC, parentRatingKey: String(rk), parentTitle: name, year, leafCount: 4, viewedLeafCount: 0 }));
    for (let t = 1; t <= 4; t++) {
      const trk = ark * 10 + t;
      const duration = 180_000 + t * 7_000;
      add({ ...meta(trk, 'track', `${title} ${t}`, { librarySectionID: SECTION_MUSIC }), index: t, parentIndex: 1, parentRatingKey: String(ark), parentTitle: title, parentThumb: `/library/metadata/${ark}/thumb/${TS(ark)}`, grandparentRatingKey: String(rk), grandparentTitle: name, duration, Media: [media(trk * 10, { container: 'flac', duration, video: { codec: undefined }, audio: [stream(2, { codec: 'flac', index: 0, default: true, selected: true, channels: 2 })], subs: [] })] });
      // Audio media has no video stream.
      const mm = items.get(String(trk)).Media[0];
      mm.Part[0].Stream = mm.Part[0].Stream.filter((s) => s.streamType === 2);
      Object.assign(mm, { width: undefined, height: undefined, videoResolution: undefined, videoCodec: undefined });
    }
  });
});

// A pinned collection with "Hide items in collection" (honoured in lists with includeCollections=1), a playlist.
add(meta(5000, 'collection', 'Sagas', { librarySectionID: SECTION_FILMS, subtype: 'movie', childCount: 3, collectionMode: 2, summary: 'Pinned to Home.' }));
const collections = new Map([['5000', ['1000', '1001', '1002']]]);
add(meta(6000, 'playlist', 'Sci-fi night', { playlistType: 'video', smart: false, leafCount: 3, duration: 0 }));
let playlistItemSeq = 0;
const playlists = new Map([['6000', ['1003', '1002', '2003'].map((rk) => ({ rk, pid: ++playlistItemSeq }))]]);

const SECTIONS = [
  { key: String(SECTION_FILMS), type: 'movie', title: 'Films', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', uuid: 'f1' },
  { key: String(SECTION_SHOWS), type: 'show', title: 'Séries', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series', uuid: 'f2' },
  { key: String(SECTION_MUSIC), type: 'artist', title: 'Musique', agent: 'tv.plex.agents.music', scanner: 'Plex Music', uuid: 'f3' },
];
const TYPE_NUM = { 1: 'movie', 2: 'show', 3: 'season', 4: 'episode', 8: 'artist', 9: 'album', 10: 'track', 18: 'collection' };
const TOP = { movie: 'movie', show: 'show', artist: 'artist' };

// ---- Server ----

export async function startMockPlex(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const on = (k) => env[k] === '1';
  const pinTtl = Number(env.MOCK_PIN_TTL_S ?? 900) * 1000;
  const remoteCap = Number(env.MOCK_REMOTE_CAP_KBPS ?? 0);
  const video = env.MOCK_PLEX_VIDEO ? path.resolve(env.MOCK_PLEX_VIDEO) : null;
  const httpsRequired = on('MOCK_PLEX_HTTPS_REQUIRED');
  const directHost = env.MOCK_PLEX_DIRECT_HOST ?? `127-0-0-1.${MACHINE_ID.slice(0, 32)}.plex.direct`;

  const fresh = () => ({ calls: [], tags: [], timelines: [], scrobbles: [], partPuts: [], refreshes: [], hidden: [], pins: [], switches: [], decisions: [], segments: [], tokens: { pms: [], plextv: [] }, terminations: [], watchlist: {} });
  const state = fresh();
  const tag = (t, detail = '') => {
    state.tags.push(t);
    console.log(`[mock-plex] ${t} ${detail}`);
  };
  const seenToken = (side, tok) => tok && !state.tokens[side].includes(tok) && state.tokens[side].push(tok);
  const gen = new Map(USERS.map((u) => [u.uuid, 0]));
  const pins = new Map(); // id -> { id, code, at, authToken }
  const stoppedSessions = new Set();
  const lastStopped = new Map(); // ratingKey -> { at, past90 }
  const terminate = new Map(); // session -> reason
  const sockets = new Set();
  let flakyMinute = -1;

  const userToken = (u) => (u.uuid === OWNER.uuid ? ACCOUNT_TOKEN : `mock-user-${u.uuid}-g${gen.get(u.uuid)}`);
  const serverToken = (server, u) => `mock-pms-${server}-${u.uuid}-g${gen.get(u.uuid)}`;
  const userOfAccountToken = (tok) => USERS.find((u) => userToken(u) === tok);
  const userOfServerToken = (server, tok) => USERS.find((u) => serverToken(server, u) === tok);

  const json = (res, status, body, headers = {}) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers });
    res.end(data);
  };
  const container = (extra) => ({ MediaContainer: { size: 0, ...extra } });
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const broadcast = (n) => {
    for (const s of sockets) if (!s.destroyed) s.write(frame(n));
  };

  // ---- Mock routes (both ports) ----
  async function mockRoute(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;
    if (p === '/Mock/State') return json(res, 200, state);
    if (p === '/Mock/Reset' && req.method === 'POST') {
      Object.assign(state, fresh());
      stoppedSessions.clear();
      lastStopped.clear();
      return json(res, 200, {});
    }
    if (p === '/Mock/Pin/Link' && req.method === 'POST') {
      const pin = [...pins.values()].find((x) => x.code === (q.get('code') ?? '').toUpperCase());
      if (!pin || Date.now() - pin.at > pinTtl) return json(res, 404, { error: 'no such PIN' });
      pin.authToken = ACCOUNT_TOKEN;
      return json(res, 200, { linked: pin.id });
    }
    if (p === '/Mock/Home/SetPin' && req.method === 'POST') {
      const u = USERS.find((x) => x.uuid === q.get('user') || x.title === q.get('user'));
      if (!u) return json(res, 404, {});
      u.pin = q.get('pin') ?? '';
      u.protected = !!u.pin;
      // A PIN added or removed upstream invalidates that user's tokens (Plezy #553): the next call answers 401.
      gen.set(u.uuid, gen.get(u.uuid) + 1);
      return json(res, 200, { user: u.uuid, protected: u.protected });
    }
    if (p === '/Mock/Terminate' && req.method === 'POST') {
      const session = q.get('session') ?? '';
      terminate.set(session, q.get('reason') ?? 'Stopped by the server owner');
      // As PMS: its own sessionKey, the player's client id and the item; the reason only rides on the next timeline.
      const tl = state.timelines.findLast((x) => x.session === session);
      if (tl) broadcast({ NotificationContainer: { type: 'playing', size: 1, PlaySessionStateNotification: [{ sessionKey: String(state.timelines.indexOf(tl) + 1), clientIdentifier: tl.client, ratingKey: tl.key, key: `/library/metadata/${tl.key}`, viewOffset: tl.time, state: 'stopped' }] } });
      return json(res, 200, {});
    }
    if (p === '/Mock/Broadcast' && req.method === 'POST') {
      broadcast(JSON.parse((await readBody(req)) || '{}'));
      return json(res, 200, { sockets: sockets.size });
    }
    return json(res, 404, { error: 'unknown mock route' });
  }

  // ---- plex.tv ----
  function connectionsFor(server) {
    const local = { protocol: 'http', address: '127.0.0.1', port: server.port, uri: `http://127.0.0.1:${server.port}`, local: true, relay: false, IPv6: false };
    const list = [local];
    if (server.tlsPort) list.push({ protocol: 'https', address: '127.0.0.1', port: server.tlsPort, uri: `https://${directHost}:${server.tlsPort}`, local: true, relay: false, IPv6: false });
    // A Docker bridge address no client can reach (Plezy #811), an unroutable remote (TEST-NET-3), the relay last.
    list.push({ protocol: 'http', address: '172.17.0.2', port: 32400, uri: 'http://172.17.0.2:32400', local: true, relay: false, IPv6: false });
    list.push({ protocol: 'http', address: '203.0.113.5', port: 32400, uri: 'http://203.0.113.5:32400', local: false, relay: false, IPv6: false });
    if (server.relayPort) list.push({ protocol: 'http', address: '127.0.0.1', port: server.relayPort, uri: `http://127.0.0.1:${server.relayPort}`, local: false, relay: true, IPv6: false });
    return list;
  }

  async function plextv(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;
    const tok = req.headers['x-plex-token'] ?? q.get('X-Plex-Token');
    if (q.get('X-Plex-Token')) tag('TOKEN-IN-URL', `plex.tv ${p}`);
    if (!req.headers['x-plex-client-identifier'] && !q.get('X-Plex-Client-Identifier')) tag('NO-CLIENT-ID', `plex.tv ${p}`);
    seenToken('plextv', tok);
    let m;
    if (p === '/api/v2/pins' && req.method === 'POST') {
      const id = 10_000 + pins.size + 1;
      const code = crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase().replace(/0/g, 'K').replace(/1/g, 'M');
      const pin = { id, code, at: Date.now(), authToken: null };
      pins.set(id, pin);
      state.pins.push({ id, code });
      return json(res, 201, { id, code, product: 'Wicaby', trusted: false, clientIdentifier: req.headers['x-plex-client-identifier'] ?? '', expiresIn: Math.round(pinTtl / 1000), createdAt: new Date(pin.at).toISOString(), expiresAt: new Date(pin.at + pinTtl).toISOString(), authToken: null });
    }
    if ((m = /^\/api\/v2\/pins\/(\d+)$/.exec(p))) {
      const pin = pins.get(Number(m[1]));
      if (!pin || Date.now() - pin.at > pinTtl) return json(res, 404, { errors: [{ code: 1020, message: 'Code not found or expired', status: 404 }] });
      return json(res, 200, { id: pin.id, code: pin.code, expiresIn: Math.max(0, Math.round((pin.at + pinTtl - Date.now()) / 1000)), authToken: pin.authToken });
    }
    const user = userOfAccountToken(tok);
    if (!user) return json(res, 401, { errors: [{ code: 1001, message: 'User could not be authenticated', status: 401 }] });
    if (p === '/api/v2/user') {
      return json(res, 200, { id: user.id, uuid: user.uuid, username: user.title.toLowerCase(), title: user.title, thumb: `https://plex.tv/users/${user.uuid}/avatar`, home: true, protected: user.protected, subscription: { active: env.MOCK_PLEX_PASS !== '0' && user.admin, plan: 'lifetime' }, profile: { defaultAudioLanguage: 'fr', defaultSubtitleLanguage: 'fr', autoSelectSubtitle: 1, defaultSubtitleAccessibility: 0, defaultSubtitleForced: 1 } });
    }
    if (p === '/api/v2/resources') {
      const out = [{ name: 'Maison', product: 'Plex Media Server', productVersion: '1.41.0.0000-mock', platform: 'Linux', clientIdentifier: MACHINE_ID, provides: 'server', owned: user.admin, home: true, sourceTitle: user.admin ? null : OWNER.title, accessToken: serverToken(MACHINE_ID, user), publicAddress: '203.0.113.5', httpsRequired, publicAddressMatches: true, presence: true, connections: connectionsFor(servers[0]) }];
      out.push({ name: 'Chez Léa', product: 'Plex Media Server', productVersion: '1.40.5.0000-mock', platform: 'Windows', clientIdentifier: SECOND_ID, provides: 'server', owned: false, home: false, sourceTitle: 'Léa', accessToken: serverToken(SECOND_ID, user), publicAddress: '198.51.100.7', httpsRequired: false, publicAddressMatches: false, presence: !!servers[1], connections: [{ protocol: 'http', address: '127.0.0.1', port: servers[1]?.port ?? 32410, uri: `http://127.0.0.1:${servers[1]?.port ?? 32410}`, local: true, relay: false, IPv6: false }] });
      // A player resource (not a server): clients keep only provides ∋ server.
      out.push({ name: 'TV player', product: 'Plex for Android (TV)', clientIdentifier: 'f00dfeed00000001', provides: 'player', owned: true, connections: [] });
      return json(res, 200, out);
    }
    // The watchlist (discover.provider.plex.tv; D-6: Favorites), per Home user: discover's ratingKey is the id at
    // the end of a plex:// guid.
    if (p === '/library/sections/watchlist/all') {
      const list = state.watchlist[user.uuid] ?? [];
      return json(res, 200, { MediaContainer: { size: list.length, Metadata: list.map((g) => ({ guid: g, ratingKey: g.split('/').pop(), type: g.split('/')[2], title: [...items.values()].find((x) => x.guid === g)?.title ?? g })) } });
    }
    if ((m = /^\/actions\/(addToWatchlist|removeFromWatchlist)$/.exec(p)) && req.method === 'PUT') {
      const it = [...items.values()].find((x) => x.guid?.startsWith('plex://') && x.guid.split('/').pop() === q.get('ratingKey'));
      if (!it) return json(res, 404, { errors: [{ code: 404, message: 'Not found', status: 404 }] });
      const list = (state.watchlist[user.uuid] ??= []);
      if (m[1] === 'addToWatchlist' && !list.includes(it.guid)) list.push(it.guid);
      if (m[1] === 'removeFromWatchlist' && list.includes(it.guid)) list.splice(list.indexOf(it.guid), 1);
      return json(res, 200, {});
    }
    if (p === '/api/v2/home/users') {
      return json(res, 200, { id: 1, name: 'Wika Home', users: USERS.map((u) => ({ id: u.id, uuid: u.uuid, title: u.title, username: u.admin ? 'wika' : '', thumb: `https://plex.tv/users/${u.uuid}/avatar`, admin: u.admin, guest: false, restricted: !u.admin, protected: u.protected, home: true })) });
    }
    if ((m = /^\/api\/v2\/home\/users\/([0-9a-f]+)\/switch$/.exec(p)) && req.method === 'POST') {
      const target = USERS.find((u) => u.uuid === m[1]);
      if (!target) return json(res, 404, { errors: [{ code: 1002, message: 'User not found', status: 404 }] });
      const ok = !target.protected || q.get('pin') === target.pin;
      state.switches.push({ user: target.uuid, ok });
      if (!ok) return json(res, 401, { errors: [{ code: 1041, message: 'Invalid PIN', status: 401 }] });
      return json(res, 201, { id: target.id, uuid: target.uuid, title: target.title, authToken: userToken(target) });
    }
    tag('UNMAPPED', `plex.tv ${req.method} ${p}`);
    return json(res, 404, { errors: [{ code: 404, message: 'Not found', status: 404 }] });
  }

  // ---- PMS ----
  // Watched counts of a folder, from its leaves now.
  const counted = (m) => (m.leafCount !== undefined && ['show', 'season', 'album'].includes(m.type) ? { ...m, viewedLeafCount: (m.type === 'show' ? leafOf(m.ratingKey) : childrenOf(m.ratingKey)).filter((x) => x.viewCount).length } : m);
  const slim = (m, extra = {}) => {
    // Lists carry no streams, markers or extras (as PMS without includeX).
    const { Marker: _m, Chapter: _c, Extras: _e, ...rest } = counted(m);
    return { ...rest, Media: m.Media?.map((x) => ({ ...x, Part: x.Part.map(({ Stream: _s, ...pp }) => pp) })), ...extra };
  };
  const leafOf = (rk) => [...items.values()].filter((x) => x.grandparentRatingKey === rk || (x.parentRatingKey === rk && (x.type === 'episode' || x.type === 'track')));
  const childrenOf = (rk) => {
    if (collections.has(rk)) return collections.get(rk).map((k) => items.get(k));
    return [...items.values()].filter((x) => x.parentRatingKey === rk).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  };
  function page(list, req, url) {
    const start = Number(req.headers['x-plex-container-start'] ?? url.searchParams.get('X-Plex-Container-Start') ?? 0);
    const sizeH = req.headers['x-plex-container-size'] ?? url.searchParams.get('X-Plex-Container-Size');
    const slice = sizeH !== undefined && sizeH !== null ? list.slice(start, start + Number(sizeH)) : list.slice(start);
    return { size: slice.length, totalSize: list.length, offset: start, Metadata: slice };
  }
  function sortList(list, sort) {
    if (!sort) return list;
    const [key, dir] = sort.split(',')[0].split(':');
    if (key === 'random') return [...list].sort(() => Math.random() - 0.5);
    const val = (x) => (key === 'titleSort' ? (x.titleSort ?? x.title).toLowerCase() : (x[key] ?? 0));
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  function filterList(list, q) {
    let out = list;
    if (q.get('unwatched') === '1') out = out.filter((x) => (x.leafCount !== undefined ? x.viewedLeafCount < x.leafCount : !x.viewCount));
    if (q.get('inProgress') === '1') out = out.filter((x) => x.viewOffset > 0);
    if (q.has('viewCount>>')) out = out.filter((x) => (x.viewCount ?? 0) > Number(q.get('viewCount>>')));
    if (q.get('genre')) out = out.filter((x) => (x.Genre ?? []).some((g) => q.get('genre').split(',').includes(String(g.id))));
    if (q.get('year')) out = out.filter((x) => q.get('year').split(',').includes(String(x.year)));
    if (q.get('guid')) out = out.filter((x) => q.get('guid').split(',').includes(x.guid));
    if (q.get('actor')) out = out.filter((x) => [...(x.Role ?? []), ...(x.Director ?? [])].some((r) => q.get('actor').split(',').includes(String(r.id))));
    return out;
  }
  const sectionItems = (key, type) => [...items.values()].filter((x) => String(x.librarySectionID) === key && x.type === type);
  const continueWatching = () => [...items.values()].filter((x) => x.viewOffset > 0 && !state.hidden.includes(x.ratingKey)).sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0));
  const onDeck = () => {
    const out = continueWatching().filter((x) => x.type === 'episode' || x.type === 'movie');
    // The next unwatched episode of each show with something watched.
    for (const s of [...items.values()].filter((x) => x.type === 'show')) {
      const eps = leafOf(s.ratingKey).sort((a, b) => a.parentIndex - b.parentIndex || a.index - b.index);
      const lastSeen = eps.findLastIndex((e) => e.viewCount);
      const next = eps[lastSeen + 1];
      if (lastSeen >= 0 && next && !out.includes(next)) out.push(next);
    }
    return out;
  };
  const imageFile = (rk, kind) => art.get(String(rk))?.[kind];
  function sendImage(res, rk, kind) {
    const file = imageFile(rk, kind);
    if (file && fs.existsSync(file)) {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length });
      return res.end(data);
    }
    const label = (items.get(String(rk))?.title ?? String(rk)).replace(/[<&>]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="100%" height="100%" fill="#2a2d3a"/><text x="50%" y="50%" fill="#ddd" font-size="40" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(svg);
  }
  const partById = (id) => {
    for (const m of items.values()) for (const md of m.Media ?? []) for (const pt of md.Part ?? []) if (String(pt.id) === String(id)) return { item: m, media: md, part: pt };
    for (const m of items.values()) for (const x of m.Extras?.Metadata ?? []) for (const md of x.Media ?? []) for (const pt of md.Part ?? []) if (String(pt.id) === String(id)) return { item: x, media: md, part: pt };
    return null;
  };
  // Every add-direct-play-profile(...) of the header: one that names the container (or none) and the codec plays.
  const directPlayable = (header, cont, vcodec) => {
    const profiles = [...(header ?? '').matchAll(/add-direct-play-profile\(([^)]*)\)/g)].map((m) => new URLSearchParams(m[1]));
    if (!profiles.length) return allowedCodecs(header).includes(vcodec);
    return profiles.some((pr) => (!pr.get('container') || pr.get('container').split(',').includes(cont)) && (pr.get('videoCodec') ?? 'h264').split(',').includes(vcodec));
  };
  const allowedCodecs = (header) => {
    const m = /add-direct-play-profile\(([^)]*)\)/.exec(header ?? '');
    const codecs = m && /videoCodec=([^&)]*)/.exec(m[1]);
    return codecs ? codecs[1].split(',') : ['h264'];
  };

  async function pms(server, req, res, url, secure) {
    const p = url.pathname;
    const q = url.searchParams;
    const call = { server: server.name, method: req.method, path: p, query: Object.fromEntries(q), secure, status: 0 };
    state.calls.push(call);
    const end = (status, body, headers) => ((call.status = status), json(res, status, body, headers));
    if (p === '/identity') return end(200, container({ machineIdentifier: server.id, version: server.version, claimed: true }));
    if (httpsRequired && !secure && server === servers[0]) {
      tag('HTTP-REFUSED', p);
      return end(403, { errors: [{ code: 1020, message: 'Secure connections are required', status: 403 }] });
    }
    const minute = Math.floor(Date.now() / 60_000);
    if (on('MOCK_PLEX_FLAKY') && minute !== flakyMinute) {
      flakyMinute = minute;
      tag('FLAKY', p);
      return end(500, { errors: [{ code: 500, message: 'Internal error (flaky mock)', status: 500 }] });
    }
    const qTok = q.get('X-Plex-Token');
    if (qTok) tag('TOKEN-IN-URL', p);
    const tok = req.headers['x-plex-token'] ?? qTok;
    if (!tok) {
      tag('NO-TOKEN', p);
      return end(401, { errors: [{ code: 1001, message: 'Unauthorized', status: 401 }] });
    }
    seenToken('pms', tok);
    if (userOfAccountToken(tok)) {
      tag('ACCOUNT-TOKEN-ON-PMS', p);
      return end(401, { errors: [{ code: 1001, message: 'Unauthorized', status: 401 }] });
    }
    const user = userOfServerToken(server.id, tok);
    if (!user) return end(401, { errors: [{ code: 1001, message: 'Unauthorized', status: 401 }] });
    if (!req.headers['x-plex-client-identifier'] && !q.get('X-Plex-Client-Identifier')) {
      tag('NO-CLIENT-ID', p);
      return end(400, { errors: [{ code: 1000, message: 'X-Plex-Client-Identifier is required', status: 400 }] });
    }
    const remote = !!req.headers['x-forwarded-for'] || q.get('remote') === '1';
    let m;
    const C = (extra) => end(200, container(extra));

    if (p === '/') return C({ friendlyName: server.name, machineIdentifier: server.id, version: server.version, myPlex: true, transcoderVideo: true, myPlexSubscription: env.MOCK_PLEX_PASS !== '0' });
    // The owner's prefs: the remote stream cap a refused decision is retried at (plex-spec §6.1.3).
    if (p === '/:/prefs') return user.admin ? C({ Setting: [{ id: 'WanPerStreamMaxUploadRate', type: 'int', value: remoteCap }] }) : end(403, container());
    if (p === '/library/sections') return C({ size: SECTIONS.length, Directory: SECTIONS });
    if ((m = /^\/library\/sections\/(\d+)\/(all|firstCharacter\/(.+))$/.exec(p))) {
      const sec = SECTIONS.find((s) => s.key === m[1]);
      if (!sec) return end(404, container());
      const type = TYPE_NUM[q.get('type')] ?? TOP[sec.type];
      let list = sectionItems(m[1], type);
      if (m[3]) list = list.filter((x) => (x.titleSort ?? x.title).toUpperCase().startsWith(decodeURIComponent(m[3])));
      if (q.get('includeCollections') === '1' && type === 'movie') {
        const hidden = new Set([...collections.values()].flat());
        list = [...list.filter((x) => !hidden.has(x.ratingKey)), ...[...collections.keys()].map((k) => items.get(k))];
      }
      list = sortList(filterList(list, q), q.get('sort') ?? 'titleSort');
      return C({ librarySectionID: Number(m[1]), ...page(list.map((x) => slim(x)), req, url) });
    }
    if ((m = /^\/library\/sections\/(\d+)\/(genre|year)$/.exec(p))) {
      const all = [...items.values()].filter((x) => String(x.librarySectionID) === m[1]);
      const dir = new Map();
      for (const x of all) {
        if (m[2] === 'genre') for (const g of x.Genre ?? []) dir.set(String(g.id), g.tag);
        else if (x.year) dir.set(String(x.year), String(x.year));
      }
      return C({ size: dir.size, Directory: [...dir].map(([key, title]) => ({ key, id: Number(key), title, fastKey: `/library/sections/${m[1]}/all?${m[2]}=${key}` })) });
    }
    if ((m = /^\/library\/sections\/(\d+)\/recentlyAdded$/.exec(p)) || p === '/library/recentlyAdded') {
      const list = [...items.values()].filter((x) => ['movie', 'episode', 'album'].includes(x.type) && (!m || String(x.librarySectionID) === m[1])).sort((a, b) => b.addedAt - a.addedAt);
      return C(page(list.map((x) => slim(x)), req, url));
    }
    if ((m = /^\/library\/sections\/(\d+)\/collections$/.exec(p))) return C(page([...collections.keys()].map((k) => items.get(k)).filter((c) => String(c.librarySectionID) === m[1]), req, url));
    if (p === '/library/sections/all/refresh') return (state.refreshes.push('all'), C({}));
    if ((m = /^\/library\/metadata\/(\d+)\/refresh$/.exec(p)) && req.method === 'PUT') {
      if (!user.admin) return end(403, container());
      state.refreshes.push(m[1]);
      return C({});
    }
    if ((m = /^\/library\/metadata\/([\d,]+)$/.exec(p))) {
      const list = m[1].split(',').map((k) => items.get(k)).filter(Boolean);
      if (!list.length) return end(404, container());
      const full = list.map((x) => {
        const out = structuredClone(counted(x));
        if (q.get('includeMarkers') !== '1') delete out.Marker;
        if (q.get('includeChapters') !== '1') delete out.Chapter;
        if (q.get('includeExtras') !== '1') delete out.Extras;
        // A show's next episode, as PMS sends it with includeOnDeck=1.
        const deck = q.get('includeOnDeck') === '1' && x.type === 'show' && onDeck().find((e) => e.type === 'episode' && e.grandparentRatingKey === x.ratingKey);
        if (deck) out.OnDeck = { Metadata: [slim(deck)] };
        // exists/accessible are sent only with checkFiles=1.
        if (q.get('checkFiles') !== '1') for (const md of out.Media ?? []) for (const pt of md.Part) delete pt.exists, delete pt.accessible;
        return out;
      });
      return C({ size: full.length, Metadata: full });
    }
    if ((m = /^\/library\/metadata\/(\d+)\/(children|allLeaves|similar)$/.exec(p))) {
      const it = items.get(m[1]);
      if (!it) return end(404, container());
      const list = m[2] === 'children' ? childrenOf(m[1]) : m[2] === 'allLeaves' ? leafOf(m[1]).sort((a, b) => a.parentIndex - b.parentIndex || a.index - b.index) : sectionItems(String(it.librarySectionID), it.type).filter((x) => x !== it).slice(0, 4);
      return C({ key: m[1], ...page(list.map((x) => slim(x)), req, url) });
    }
    if ((m = /^\/library\/collections\/(\d+)\/children$/.exec(p))) return C(page((collections.get(m[1]) ?? []).map((k) => slim(items.get(k))), req, url));
    if (p === '/library/collections' && req.method === 'POST') {
      const rk = String(5000 + collections.size);
      const ids = (/library\/metadata\/([\d,]+)/.exec(q.get('uri') ?? '')?.[1] ?? '').split(',').filter(Boolean);
      add(meta(rk, 'collection', q.get('title') ?? 'Collection', { librarySectionID: Number(q.get('sectionId') ?? 1), childCount: ids.length }));
      collections.set(rk, ids);
      return C({ size: 1, Metadata: [items.get(rk)] });
    }
    if ((m = /^\/library\/collections\/(\d+)\/items(?:\/(\d+))?$/.exec(p))) {
      const list = collections.get(m[1]);
      if (!list) return end(404, container());
      if (req.method === 'PUT') for (const k of (/library\/metadata\/([\d,]+)/.exec(q.get('uri') ?? '')?.[1] ?? '').split(',').filter(Boolean)) if (!list.includes(k)) list.push(k);
      if (req.method === 'DELETE' && m[2] && list.includes(m[2])) list.splice(list.indexOf(m[2]), 1);
      items.get(m[1]).childCount = list.length;
      return C({ size: list.length });
    }
    if ((m = /^\/library\/parts\/(\d+)\/indexes\/sd$/.exec(p))) {
      const hit = partById(m[1]);
      if (!hit?.part.indexes) return end(404, container());
      const frames = Array.from({ length: Math.max(1, Math.ceil((hit.part.duration ?? 60_000) / 10_000)) }, (_, i) => png(32, 18, () => [i * 7 % 255, 90, 140]));
      const data = bif(frames, 10_000);
      call.status = 200;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      return res.end(data);
    }
    if ((m = /^\/library\/parts\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      const hit = partById(m[1]);
      if (!hit) return end(404, container());
      const put = { part: m[1], audioStreamID: q.get('audioStreamID'), subtitleStreamID: q.get('subtitleStreamID'), allParts: q.get('allParts') };
      state.partPuts.push(put);
      for (const s of hit.part.Stream ?? []) {
        if (s.streamType === 2 && put.audioStreamID) s.selected = String(s.id) === put.audioStreamID;
        if (s.streamType === 3 && put.subtitleStreamID !== null) s.selected = String(s.id) === put.subtitleStreamID;
      }
      return C({});
    }
    if ((m = /^\/library\/parts\/(\d+)\/\d+\/file\.\w+$/.exec(p))) {
      const hit = partById(m[1]);
      if (!hit || hit.part.exists === false) return end(404, container());
      if (q.get('download') === '1' && !hit.item.allowSync) return end(403, container());
      if (!video || !fs.existsSync(video)) return end(404, { errors: [{ code: 404, message: 'no MOCK_PLEX_VIDEO', status: 404 }] });
      const size = fs.statSync(video).size;
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      const a = r && r[1] ? Number(r[1]) : 0;
      const b = r && r[2] ? Number(r[2]) : size - 1;
      call.status = r ? 206 : 200;
      res.writeHead(call.status, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, ...(r ? { 'Content-Range': `bytes ${a}-${b}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(video, { start: a, end: b }).pipe(res);
    }
    if ((m = /^\/library\/streams\/(\d+)$/.exec(p))) {
      call.status = 200;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('1\n00:00:01,000 --> 00:00:04,000\nMock subtitle\n');
    }
    if ((m = /^\/library\/metadata\/(\d+)\/(thumb|art)\/\d+$/.exec(p))) return (call.status = 200), sendImage(res, m[1], m[2]);
    if (p === '/photo/:/transcode') {
      const inner = /^\/library\/metadata\/(\d+)\/(thumb|art)\//.exec(q.get('url') ?? '');
      if (!inner || !q.get('width') || !q.get('height')) return end(400, container());
      call.status = 200;
      return sendImage(res, inner[1], inner[2]);
    }

    // Home and search.
    if (p === '/hubs/promoted' || p === '/hubs') {
      const hubs = [
        { hubIdentifier: 'home.continue', title: 'Continue Watching', type: 'mixed', promoted: true, Metadata: continueWatching().map((x) => slim(x)) },
        { hubIdentifier: 'home.television.recent', title: 'Recently Added TV', type: 'show', promoted: true, Metadata: [...items.values()].filter((x) => x.type === 'show').map((x) => slim(x)) },
        { hubIdentifier: 'custom.collection.5000', title: 'Sagas', type: 'movie', promoted: true, Metadata: collections.get('5000').map((k) => slim(items.get(k))) },
      ];
      return C({ size: hubs.length, Hub: hubs.map((h) => ({ ...h, size: h.Metadata.length, key: `/hubs/${h.hubIdentifier}` })) });
    }
    if ((m = /^\/hubs\/sections\/(\d+)$/.exec(p))) {
      const sec = SECTIONS.find((s) => s.key === m[1]);
      if (!sec) return end(404, container());
      const list = sectionItems(m[1], TOP[sec.type]).sort((a, b) => b.addedAt - a.addedAt);
      return C({ size: 1, Hub: [{ hubIdentifier: `${sec.type}.recentlyadded.${m[1]}`, title: `Recently Added in ${sec.title}`, type: sec.type, size: list.length, Metadata: list.slice(0, 10).map((x) => slim(x)) }] });
    }
    if (p === '/hubs/continueWatching/items') return C(page(continueWatching().map((x) => slim(x)), req, url));
    if (p === '/library/onDeck' || p === '/hubs/home/onDeck') return C(page(onDeck().map((x) => slim(x)), req, url));
    if (p === '/hubs/home/recentlyAdded') {
      const t = TYPE_NUM[q.get('type')] ?? 'movie';
      return C(page([...items.values()].filter((x) => x.type === t).sort((a, b) => b.addedAt - a.addedAt).map((x) => slim(x)), req, url));
    }
    if (p === '/hubs/search') {
      const term = (q.get('query') ?? '').toLowerCase();
      const limit = Number(q.get('limit') ?? 10);
      const section = q.get('sectionId');
      const hits = [...items.values()].filter((x) => x.type !== 'clip' && (x.title ?? '').toLowerCase().includes(term) && (!section || String(x.librarySectionID) === section));
      const byType = new Map();
      for (const h of hits) (byType.get(h.type) ?? byType.set(h.type, []).get(h.type)).push(slim(h));
      return C({ size: byType.size, Hub: [...byType].map(([type, list]) => ({ hubIdentifier: type, title: type, type, size: Math.min(limit, list.length), Metadata: list.slice(0, limit) })) });
    }
    if (p === '/actions/removeFromContinueWatching' && req.method === 'PUT') {
      const rk = q.get('ratingKey') ?? '';
      if (!items.has(rk)) return end(404, container());
      state.hidden.push(rk);
      return C({});
    }

    // Watched state.
    if (p === '/:/scrobble' || p === '/:/unscrobble') {
      const it = items.get(q.get('key') ?? '');
      if (!it || q.get('identifier') !== LIBRARY) return end(400, container());
      const last = lastStopped.get(it.ratingKey);
      // A scrobble right after a stopped timeline is a second history entry: PMS already applied its threshold (§6.5).
      if (p === '/:/scrobble' && last && Date.now() - last.at < 5000) tag('DUP-SCROBBLE', it.ratingKey);
      state.scrobbles.push({ key: it.ratingKey, played: p === '/:/scrobble', at: Date.now() });
      const targets = it.type === 'show' ? leafOf(it.ratingKey) : it.type === 'season' || it.type === 'album' ? childrenOf(it.ratingKey) : [it];
      for (const x of targets) {
        x.viewCount = p === '/:/scrobble' ? (x.viewCount ?? 0) + 1 : 0;
        x.viewOffset = 0;
        if (p === '/:/scrobble') x.lastViewedAt = Math.floor(Date.now() / 1000);
      }
      broadcast({ NotificationContainer: { type: 'timeline', size: 1, TimelineEntry: [{ itemID: Number(it.ratingKey), state: 5, type: 1, identifier: LIBRARY }] } });
      return C({});
    }
    if (p === '/:/progress') {
      const it = items.get(q.get('key') ?? '');
      if (!it) return end(400, container());
      it.viewOffset = Number(q.get('time') ?? 0);
      return C({});
    }
    if (p === '/:/rate') {
      const it = items.get(q.get('key') ?? '');
      if (!it) return end(400, container());
      it.userRating = Number(q.get('rating'));
      return C({});
    }
    if (p === '/:/timeline') {
      const it = items.get(q.get('ratingKey') ?? '');
      const session = req.headers['x-plex-session-identifier'] ?? q.get('session') ?? req.headers['x-plex-client-identifier'];
      const st = q.get('state');
      if (!it || !['playing', 'paused', 'stopped', 'buffering'].includes(st)) return end(400, container());
      const time = Number(q.get('time') ?? 0);
      const duration = Number(q.get('duration') ?? it.duration ?? 0);
      state.timelines.push({ session, client: req.headers['x-plex-client-identifier'], key: it.ratingKey, state: st, time, at: Date.now() });
      if (stoppedSessions.has(`${session}|${it.ratingKey}`)) tag(st === 'stopped' ? 'DUP-STOPPED' : 'AFTER-STOPPED', `${session} ${it.ratingKey} ${st}`);
      if (st === 'stopped') {
        stoppedSessions.add(`${session}|${it.ratingKey}`);
        const past90 = duration > 0 && time / duration >= 0.9;
        lastStopped.set(it.ratingKey, { at: Date.now(), past90 });
        if (past90) Object.assign(it, { viewCount: (it.viewCount ?? 0) + 1, viewOffset: 0, lastViewedAt: Math.floor(Date.now() / 1000) });
        else it.viewOffset = time;
      } else {
        stoppedSessions.delete(`${session}|${it.ratingKey}`);
        it.viewOffset = time;
      }
      if (terminate.has(session)) {
        const reason = terminate.get(session);
        terminate.delete(session);
        state.terminations.push({ session, reason });
        return C({ terminationCode: 2006, terminationText: reason });
      }
      return C({});
    }

    // Playback decision and transcoder.
    if (p === '/video/:/transcode/universal/decision') {
      const key = /^\/library\/metadata\/(\d+)$/.exec(q.get('path') ?? '')?.[1];
      const it = key && items.get(key);
      if (!it) return end(400, container({ generalDecisionCode: 4000, generalDecisionText: 'Invalid path' }));
      const record = { key, session: q.get('session'), partIndex: Number(q.get('partIndex') ?? 0), offset: Number(q.get('offset') ?? 0), maxVideoBitrate: q.get('maxVideoBitrate'), subtitles: q.get('subtitles'), autoAdjustQuality: q.get('autoAdjustQuality'), remote, result: '' };
      state.decisions.push(record);
      if (remote && env.MOCK_REMOTE_PASS === '0') {
        record.result = '403';
        // shortcut: the body shape is assumed (no real capture); plex-spec R-4 says to parse it generically.
        return end(403, { errors: [{ code: 1998, message: 'Remote streaming of personal media requires Plex Pass or a Remote Watch Pass', status: 403 }] });
      }
      const kbps = Number(q.get('maxVideoBitrate') ?? 0);
      if (remote && remoteCap && (!kbps || kbps > remoteCap)) {
        record.result = '500';
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        call.status = 500;
        return res.end('Cannot make a decision');
      }
      const mediaIdx = Number(q.get('mediaIndex') ?? 0);
      const md = (it.Media ?? []).filter((x) => x.Part.some((pt) => pt.exists !== false))[mediaIdx];
      if (!md) return end(400, container({ generalDecisionCode: 2000, generalDecisionText: 'No playable media' }));
      const pt = md.Part[Number(q.get('partIndex') ?? 0)];
      if (!pt || pt.exists === false) return end(400, container({ generalDecisionCode: 2000, generalDecisionText: 'No such part' }));
      const vcodec = (pt.Stream ?? md.Part[0].Stream)?.find((s) => s.streamType === 1)?.codec;
      const direct = q.get('directPlay') !== '0' && (!vcodec || directPlayable(req.headers['x-plex-client-profile-extra'], md.container, vcodec)) && q.get('subtitles') !== 'burn' && (!kbps || kbps >= md.bitrate);
      record.result = direct ? 'directplay' : 'transcode';
      const part = { ...pt, decision: direct ? 'directplay' : 'transcode', selected: true };
      return C({ generalDecisionCode: 1000, generalDecisionText: 'Direct play OK.', directPlayDecisionCode: direct ? 1000 : 3000, directPlayDecisionText: direct ? 'Direct play OK.' : 'App cannot direct play this item. Direct play is disabled.', transcodeDecisionCode: direct ? undefined : 1001, transcodeDecisionText: direct ? undefined : 'Transcode', Metadata: [{ ...slim(it), Media: [{ ...md, selected: true, Part: [part] }] }] });
    }
    if (p === '/video/:/transcode/universal/start.m3u8') {
      const session = q.get('session') ?? '';
      const offset = Number(q.get('offset') ?? 0);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      call.status = 200;
      return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nsession/${encodeURIComponent(session)}/base/index.m3u8?offset=${offset}\n`);
    }
    if ((m = /^\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/index\.m3u8$/.exec(p))) {
      const first = Math.floor(Number(q.get('offset') ?? 0) / 6);
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let n = first; n < first + 10; n++) lines.push('#EXTINF:6.0,', `${n}.ts?offset=${q.get('offset') ?? 0}`);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      call.status = 200;
      return res.end(`${lines.join('\n')}\n`);
    }
    if ((m = /^\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/(\d+)\.ts$/.exec(p))) {
      // Playlists only: a segment before the offset means the player seeked to the absolute time (Plezy #1840).
      if (Number(m[2]) < Math.floor(Number(q.get('offset') ?? 0) / 6)) tag('SEEK-AFTER-OFFSET', `${m[1]} segment ${m[2]}`);
      return end(404, container());
    }
    if (p === '/video/:/transcode/universal/ping' || p === '/video/:/transcode/universal/stop') return C({});

    // Playlists.
    if (p === '/playlists' && req.method === 'GET') return C(page([...playlists.keys()].map((k) => ({ ...items.get(k), leafCount: playlists.get(k).length })), req, url));
    if (p === '/playlists' && req.method === 'POST') {
      const rk = String(6000 + playlists.size);
      const ids = (/library\/metadata\/([\d,]+)/.exec(q.get('uri') ?? '')?.[1] ?? '').split(',').filter(Boolean);
      add(meta(rk, 'playlist', q.get('title') ?? 'Playlist', { playlistType: q.get('type') ?? 'video', smart: false }));
      playlists.set(rk, ids.map((k) => ({ rk: k, pid: ++playlistItemSeq })));
      return C({ size: 1, Metadata: [{ ...items.get(rk), leafCount: ids.length }] });
    }
    if ((m = /^\/playlists\/(\d+)\/items(?:\/(\d+)(\/move)?)?$/.exec(p))) {
      const list = playlists.get(m[1]);
      if (!list) return end(404, container());
      if (req.method === 'GET' && !m[2]) return C({ ...page(list.map((e) => ({ ...slim(items.get(e.rk)), playlistItemID: e.pid })), req, url), ratingKey: m[1] });
      if (req.method === 'PUT' && !m[2]) for (const k of (/library\/metadata\/([\d,]+)/.exec(q.get('uri') ?? '')?.[1] ?? '').split(',').filter(Boolean)) list.push({ rk: k, pid: ++playlistItemSeq });
      if (req.method === 'DELETE' && m[2] && !m[3]) {
        const i = list.findIndex((e) => String(e.pid) === m[2]);
        if (i < 0) return end(404, container());
        list.splice(i, 1);
      }
      if (req.method === 'PUT' && m[3]) {
        const i = list.findIndex((e) => String(e.pid) === m[2]);
        if (i < 0) return end(404, container());
        const [e] = list.splice(i, 1);
        const after = q.get('after') ? list.findIndex((x) => String(x.pid) === q.get('after')) + 1 : 0;
        list.splice(after, 0, e);
      }
      return C({ size: list.length });
    }

    // Live TV (plex-spec §7): only the DVR list; channels and grid wait for real captures (PX-11).
    if (p === '/livetv/dvrs') {
      if (env.MOCK_PLEX_PASS === '0') return end(403, { errors: [{ code: 1999, message: 'Live TV requires Plex Pass', status: 403 }] });
      return C(on('MOCK_PLEX_LIVETV') ? { size: 1, Dvr: [{ key: '1', uuid: 'mock-dvr', lineup: 'mock-lineup', language: 'fr', Device: [{ key: '1', make: 'Mock', model: 'Tuner' }] }] } : { size: 0 });
    }

    tag('UNMAPPED', `${req.method} ${p}`);
    return end(404, { errors: [{ code: 404, message: `UNMAPPED ${req.method} ${p}`, status: 404 }] });
  }

  // ---- Listeners ----
  const listen = (srv, port) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  });
  const handlerFor = (fn, secure) => (req, res) => {
    const url = new URL(req.url, 'http://mock');
    Promise.resolve(url.pathname.startsWith('/Mock/') ? mockRoute(req, res, url) : fn(req, res, url, secure)).catch((err) => {
      console.error('[mock-plex]', err);
      if (!res.headersSent) json(res, 500, { error: String(err) });
    });
  };
  const upgradeFor = (server) => (req, sock) => {
    const url = new URL(req.url, 'http://mock');
    const tok = req.headers['x-plex-token'] ?? url.searchParams.get('X-Plex-Token');
    if (url.searchParams.get('X-Plex-Token')) tag('TOKEN-IN-URL', url.pathname);
    if (url.pathname !== '/:/websockets/notifications' || !userOfServerToken(server.id, tok)) return sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
  };

  const servers = [];
  const closers = [];
  async function startPms(id, name, version, port, tlsPort) {
    const server = { id, name, version, port: 0, tlsPort: 0, relayPort: 0 };
    const srv = http.createServer(handlerFor((req, res, url, secure) => pms(server, req, res, url, secure), false));
    srv.on('upgrade', upgradeFor(server));
    server.port = await listen(srv, port);
    closers.push(() => srv.close());
    if (tlsPort !== undefined) {
      const dir = path.join(import.meta.dirname, 'fixtures', 'cast-tls');
      const tls = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, handlerFor((req, res, url) => pms(server, req, res, url, true), true));
      tls.on('upgrade', upgradeFor(server));
      server.tlsPort = await listen(tls, tlsPort);
      closers.push(() => tls.close());
    }
    servers.push(server);
    return server;
  }
  const num = (v, d) => (v === undefined ? d : Number(v));
  const main = await startPms(MACHINE_ID, 'Maison', '1.41.0.0000-mock', num(opts.port ?? env.PORT, 32400), on('MOCK_PLEX_TLS') ? num(opts.tlsPort ?? env.MOCK_PLEX_TLS_PORT, 32443) : undefined);
  // The relay: the same PMS behind 400 ms (bandwidth-capped in real life; the UI shows a "Relay" badge).
  const relay = http.createServer((req, res) => {
    setTimeout(() => {
      const up = http.request({ host: '127.0.0.1', port: main.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': '203.0.113.9' } }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)));
      up.on('error', () => res.destroy());
      req.pipe(up);
    }, 400);
  });
  main.relayPort = await listen(relay, num(opts.relayPort ?? env.MOCK_PLEX_RELAY_PORT, 32402));
  closers.push(() => relay.close());
  if (on('MOCK_PLEX_SECOND')) await startPms(SECOND_ID, 'Chez Léa', '1.40.5.0000-mock', num(opts.secondPort ?? env.MOCK_PLEX_SECOND_PORT, 32410));
  const tv = http.createServer(handlerFor(plextv));
  const tvPort = await listen(tv, num(opts.tvPort ?? env.MOCK_PLEXTV_PORT, 32401));
  closers.push(() => tv.close());

  return {
    state,
    servers,
    pms: `http://127.0.0.1:${main.port}`,
    pmsTls: main.tlsPort ? `https://127.0.0.1:${main.tlsPort}` : null,
    relay: `http://127.0.0.1:${main.relayPort}`,
    plextv: `http://127.0.0.1:${tvPort}`,
    serverToken: (uuid = OWNER.uuid, server = MACHINE_ID) => serverToken(server, USERS.find((u) => u.uuid === uuid)),
    users: USERS.map(({ pin: _p, ...u }) => u),
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(closers.map((c) => new Promise((r) => (c(), r()))));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const m = await startMockPlex();
  console.log(`Mock Plex: PMS ${m.pms}${m.pmsTls ? ` (TLS ${m.pmsTls})` : ''}, relay ${m.relay}, plex.tv ${m.plextv}${m.servers[1] ? `, second PMS http://127.0.0.1:${m.servers[1].port}` : ''}. Link a PIN with POST ${m.plextv}/Mock/Pin/Link?code=XXXX`);
}
