# Mock servers

The Emby, Jellyfin and qBittorrent mocks are described in [CONTRIBUTING.md](../../CONTRIBUTING.md#mock-servers).
This page covers the cast renderers (cast spec CA-06): a DLNA/UPnP TV and a
Chromecast, so the DLNA and Cast senders can be tested with no real device.

Both listen on `127.0.0.1` only, start in well under a second, and fetch only loopback URLs unless you set their
`MOCK_*_HOST` by hand. Every call is logged; protocol slips are tagged (`FAULT`, `UNQUOTED-SOAPACTION`,
`TOKEN-HEADER`, `REFUSED`, `NO-CONNECT`, `CONNECTSDK-INVALID`, `HEARTBEAT-LOST`, `UNMAPPED`…), so a run's log reads as
a bug list. `node tools/checks/cast-mock-check.mjs` exercises both (it is part of `npm run checks`).

| Command | Default port | What it is |
|---|---|---|
| `node tools/mock-server/mock-dlna.mjs [port]` | 8970 | A UPnP MediaRenderer: `GET /desc.xml`, SOAP on `/ctl/avt`, `/ctl/rc`, `/ctl/cm`. |
| `node tools/mock-server/mock-cast.mjs` | 18009 (TLS), 18010 (state) | A Chromecast speaking CASTV2 (Default Media Receiver and the Jellyfin receiver). |

## mock-plex (Plex backend, plex-spec §10)

`node tools/mock-server/mock-plex.mjs` starts a fake Plex Media Server ("Maison", `127.0.0.1:32400`), a fake plex.tv
(`32401`) and a "relay" (`32402`, the same PMS behind 400 ms). Nothing in it talks to plex.tv or a real server;
`import { startMockPlex } from './mock-plex.mjs'` starts it on free ports for the checks (`plex-mock-check.mjs`).

- **Dataset:** sections Films (the 12 demo films with their artwork: two editions, a missing second version, 4K HDR10,
  Dolby Vision 8.1, PGS plus forced and sidecar subtitles, a two-part film), Séries (Caminandes with intro and credits
  markers, a BIF index and per-show audio memory; a show with `flattenSeasons=1`; a show whose s02e17-e18 share one
  file) and Musique (2 artists, 3 albums, 12 tracks). A pinned collection, a playlist, `/hubs/promoted`, On Deck, search
  (with a single item shared outside the libraries). Shows B and C, the music and the people are invented.
- **plex.tv:** `POST /api/v2/pins`, `GET /api/v2/pins/{id}` (link with `POST /Mock/Pin/Link?code=`), `/api/v2/user`,
  `/api/v2/resources` (local, plex.direct with `MOCK_PLEX_TLS=1`, a Docker decoy, an unroutable remote, the relay; a
  server shared by "Léa"), `/api/v2/home/users` and `…/switch?pin=` (Wika owner, Ado protected PIN 1234, Invité).
  The account token is `mock-account-token`; each server gets per-user tokens. The watchlist (Favorites, D-6) as
  discover.provider.plex.tv serves it: `GET /library/sections/watchlist/all`, `PUT /actions/addToWatchlist?ratingKey=`
  and `removeFromWatchlist` (per Home user, `state.watchlist`); the PMS filters a section by `guid=`.
  `tools/checks/plex-link-check.mjs` and `plex-browse-check.mjs` drive it through the ConnectionManager,
  `tools/checks/plex-cdp.mjs` with the built app.
- **Switches:** `MOCK_PLEX_HTTPS_REQUIRED`, `MOCK_PIN_TTL_S`, `MOCK_REMOTE_CAP_KBPS`, `MOCK_REMOTE_PASS=0`,
  `MOCK_PLEX_FLAKY`, `MOCK_PLEX_PASS=0`, `MOCK_PLEX_LIVETV`, `MOCK_PLEX_SECOND`, `MOCK_PLEX_TLS`, `MOCK_PLEX_VIDEO=<file>`
  (the header of `mock-plex.mjs` lists what each does).
- **Tags:** `UNMAPPED`, `TOKEN-IN-URL`, `NO-CLIENT-ID`, `NO-TOKEN`, `ACCOUNT-TOKEN-ON-PMS`, `HTTP-REFUSED`, `DUP-STOPPED`,
  `AFTER-STOPPED` (a timeline after the session's stopped one), `DUP-SCROBBLE`, `SEEK-AFTER-OFFSET`, `FLAKY`. `GET /Mock/State` lists them with the calls, timelines, scrobbles,
  part PUTs, decisions and the tokens each side saw (`tokens.pms`, `tokens.plextv`).
- **Mock routes:** `/Mock/State`, `/Mock/Reset`, `/Mock/Pin/Link`, `/Mock/Home/SetPin?user=&pin=` (invalidates that
  user's tokens), `/Mock/Terminate?session=&reason=` (a `playing` stopped notification for that session's client
  and item at once, the reason on its next timeline), `/Mock/Broadcast` (a notification to every
  `/:/websockets/notifications` socket). `DUP-SCROBBLE` is any `/:/scrobble` within 5 s of a stopped timeline of the
  item (PMS already applied its threshold).
- **Playback (PX-08, PX-09):** the decision direct plays when one `add-direct-play-profile(...)` of
  `X-Plex-Client-Profile-Extra` names the container and the video codec; `/` says `myPlexSubscription` (false with
  `MOCK_PLEX_PASS=0`); `/:/prefs` gives the owner's `WanPerStreamMaxUploadRate` (`MOCK_REMOTE_CAP_KBPS`).
  The decision honours `partIndex` (a multi-part film). `tools/checks/plex-playback-check.mjs` drives it with mpv,
  `tools/checks/plex-cast-check.mjs` with the DLNA and Cast senders, `tools/checks/plex-play-cdp.mjs` with the built app.
- Live TV and DVR (PX-11) with `MOCK_PLEX_LIVETV=1`: `/livetv/dvrs` lists one DVR with 2 tuners and a ChannelMapping
  (8 of 9 lineup channels enabled; 403 without Plex Pass, empty without the switch), `/livetv/epg/channels?lineup=`,
  the grid `/tv.plex.providers.epg.mock:1/grid` (48 h of airings around now; `endsAt>>` and `beginsAt<<` required, else
  `GRID-NO-WINDOW`), `POST /livetv/dvrs/1/channels/{id}/tune` (a `/livetv/sessions/…` key, logged in `state.tunes`),
  `/media/subscriptions` CRUD with `/template?guid=` and `/scheduled` (`BAD-SUBSCRIPTION` for a malformed create),
  `POST /Mock/LiveTv/Record?ratingKey=` (a finished recording: one more `mpegts` Media on that item; `DELETE
  /library/metadata/{key}/media/{id}` removes it, every library DELETE lands in `state.deletes`), and every transcode
  stop in `state.stops`. These shapes are the client's guesses from the public docs, tagged
  `PLEX-LIVETV-UNVERIFIED` in `apps/desktop/src/shared/plex/livetv-map.ts`: replace them with captures from a real PMS
  with a tuner when one is available. `tools/checks/plex-livetv-check.mjs` drives it on the desktop, `PlexMockTest` on
  Android.

## Music library (`music-fixture.mjs`)

`MOCK_MUSIC=1` (or `MOCK_DATASET=demo`) adds a music library to the Emby and Jellyfin mocks (music spec MU-00): album
artists and track artists, a 2-disc album, an EP, a single, a compilation, an album of FLAC files with ReplayGain tags,
three genres, an audio playlist, favourites and play counts. Every name is invented. `node tools/checks/music-mock-check.mjs`
covers it (part of `npm run checks`).

- **Never audible:** every track is generated silence (8 kHz mono 16-bit WAV, or FLAC whose frames are a constant 0), with
  `Range` support. `/Audio/{id}/stream[.ext]` and `/universal` (Emby's wants a `PlaySessionId`) log the container asked for.
- **Each server's shape:** `NormalizationGain` and `HasLyrics` on Jellyfin only; Jellyfin lyrics at `/Audio/{id}/Lyrics`;
  Emby lyrics as an external `lrc` subtitle stream of the audio item, served at `/Videos/{id}/{msid}/Subtitles/{i}/Stream.lrc|txt`
  (unverified on a real Emby, music spec §3.5). Genres: Emby `/MusicGenres`, Jellyfin `/Genres?IncludeItemTypes=MusicAlbum`
  (its `/MusicGenres` answers, tagged `DEPRECATED`). Instant mix on `/Items/{id}/InstantMix` and the per-type routes each
  server has (`/Artists/InstantMix` is a 404 on the Jellyfin 12.2 mock).
- **Missing art, as on a real Emby:** "Brume" has no Primary but its tracks have their own (embedded) art, the owner's
  field bug; "Trois vents" has no image anywhere; three album artists have no image. `/Items` honours `ImageTypes=`.
  `node tools/checks/music-art-check.mjs` checks the cover fallbacks against it (music-feishin-navidrome spec §4.A).
- **Test knobs:** `MOCK_MUSIC_SCALE=big` adds 1,000 metadata-only songs (scroll checks); `MOCK_LYRICS_FAIL=<track id>` makes
  that track's Jellyfin lyrics answer 500 (the desktop's "no lyrics, no toast" check, `tools/checks/music-ui-cdp.mjs`).
- **`GET /Mock/State`** gains `music: { streams, instantMix, reports }` (the reports of tracks, in arrival order).
- For listening by hand, use your own CC0 files; nothing in the checks ever plays real audio.

## mock-dlna

- **Profiles** (`MOCK_DLNA_PROFILE`): the description and the `GetProtocolInfo` Sink come from
  `tools/checks/fixtures/cast/dlna-{desc,protocolinfo}-<profile>.xml`.
  - `generic` (default): `URLBase` set, accepts everything.
  - `sony`: no `URLBase`; `SetAVTransportURI` answers 701 while PLAYING (send `Stop` first) and 714 when
    `CurrentURIMetaData` is empty.
  - `samsung`: 716 when the first `<res>` has no `DLNA.ORG_` flags, 714 when the DIDL has subtitles without
    `sec:CaptionInfoEx` right after the first `</res>` (both unverified on a real Samsung, cast spec §7).
- **Play** fetches the first 64 KB of the URI and records `fetched: {status, type, tokenInUrl}`. A failed fetch
  leaves the renderer STOPPED with `ERROR_OCCURRED`.
- **RelTime** advances in real time while PLAYING; the media ends (STOPPED) at `MOCK_DURATION_S`.
- **Mock-only routes:** `GET /Mock/State` (`calls[]`, `uri`, `meta`, `fetched`, `state`, `relTime`, `volume`,
  `tokenHeaders`…), `POST /Mock/End` (end of media).
- **SSDP:** `MOCK_SSDP=1` also answers `M-SEARCH` on 239.255.255.250:1900. It is best effort: the Windows SSDP
  service holds port 1900. Point the app at the mock with the dev seed instead (`WICABY_DLNA_SEED=http://127.0.0.1:8970/desc.xml`
  on desktop, cast spec CA-07).

## mock-cast

- **TLS** with the TEST ONLY self-signed pair in `fixtures/cast-tls/`. Framing is
  `apps/desktop/src/main/cast/castv2-codec.ts` itself, checked against `tools/checks/fixtures/cast/castv2-vectors.json`.
- **Namespaces:** `tp.connection` (CONNECT, CLOSE), `tp.heartbeat` (PING/PONG; no PING for 15 s closes the
  connection), `receiver` (LAUNCH, GET_STATUS, STOP, SET_VOLUME; unknown app ids get `LAUNCH_ERROR`), `media` (LOAD,
  PLAY, PAUSE, SEEK, STOP, GET_STATUS, EDIT_TRACKS_INFO, SET_VOLUME), and `urn:x-cast:com.connectsdk` while the
  Jellyfin receiver (`F007D354`, `6F511C87`) runs.
- **LOAD** fetches `contentId` and every `trackContentId` with `Origin: https://mock-cast` and records whether
  `Access-Control-Allow-Origin` came back. Emby's `Stream.vtt` is modelled **without** CORS until a real Emby is
  checked (cast spec CA-06 AC6), so the relay's `*` is what gets tested.
- **Mock-only routes** (state port): `GET /Mock/State` (`app`, `media`, `volume`, `calls[]`, `fetched[]`,
  `connectsdk[]`), `POST /Mock/End` (IDLE / FINISHED).
- The app finds the mock through the dev seed (`WICABY_CAST_SEED=127.0.0.1:18009`, cast spec CA-09); mDNS is not mocked.
- mock-emby and mock-jellyfin honour the desktop Chromecast profile (`DeviceProfile.Name` "Wicaby Cast…"): an MKV
  source is answered with an HLS remux (`/Videos/{id}/master.m3u8`, playlists only), as a real server would.
  Every other profile keeps the bitrate-only rule.

## Photos (mock-emby and mock-jellyfin)

`photos-fixture.mjs` adds two generated photo libraries to both mocks (photos spec PH-00): "Photos de famille"
(`lib-photos`, `homevideos`, six `PhotoAlbum` folders) and "Anciennes photos" (`lib-photos-legacy`, the legacy
`photos` type, 40 assets). Nothing is a real photo: items, EXIF and positions come from a seeded PRNG, and each image
is a PNG drawn on request (a horizon, a sun, and a 1-px magenta marker on the picture's true top edge).

- **Assets:** `Photo` and `Video` items (4 %, 5–60 s) dated 2014 to today, about 10 on today's day 1, 3 and 7 years
  ago, 3:2 to 4:1 shapes, 8 % lying on their side (`ImageOrientation` RightTop/LeftBottom, unrotated `Width`/`Height`),
  5 % without `PremiereDate`, 10 % favourites, three HEIC + MOV pairs with one basename.
- **EXIF** as both servers name it: camera "Wicaby Test", `ExposureTime`, `FocalLength`, `IsoSpeedRating`, `Aperture`
  and `ShutterSpeed` in APEX units; 60 % carry `Latitude`/`Longitude`/`Altitude` around public landmarks (Eiffel Tower,
  Fourvière, Belém, Hallgrímskirkja, Kiyomizu-dera, Mont Blanc). Jellyfin sends `PremiereDate` without a zone and an
  `ImageBlurHashes`; Emby sends a `Z` and no hash.
- **Routes:** `/Items` sorts by `DateCreated` and `PremiereDate` and filters `MinPremiereDate`/`MaxPremiereDate`
  (wall-clock); `/Years`; `/Items/{id}/Images/Primary` (`maxWidth`/`maxHeight`, at most 2048 px, 300-entry cache;
  Emby honours `AutoOrient=true`); `/Items/{id}/Download` (the original PNG).
- `node tools/checks/photos-mock-check.mjs` checks all of it on both mocks, plus a 100,000-asset start.

| Variable | Effect |
|---|---|
| `MOCK_PHOTOS` | Assets in "Photos de famille" (default 600; `0` leaves both photo libraries out). |
| `MOCK_PHOTOS_SEED` | PRNG seed (default 1). |
| `MOCK_TODAY=YYYY-MM-DD` | The day the "on this day" assets fall on (default: the mock's start date). |
| `MOCK_APERTURE=fnumber` | `Aperture`/`ShutterSpeed` as an f-number and seconds instead of APEX. |
| `MOCK_PHOTO_ROTATE=server` | Images come back upright (server-rotated) on both mocks. |
| `MOCK_NO_DOWNLOAD=1` | `/Items/{id}/Download` answers 403. |
| `MOCK_DEMO_LANG=en` | English library and album names. |

## mock-immich (photos spec PH-11)

`node tools/mock-server/mock-immich.mjs [port]` (default `127.0.0.1:2283`) is a fake Immich server written by hand from
the published API reference: no file or code from the Immich repository. It serves the same generated photos as the
Emby mock (above), with place names derived from the landmark each position clusters around, six albums (the first one
shared with the user), four invented people (Alex, Camille, Sam, Noa) with drawn face thumbnails, and about 3 %
archived assets that never reach the timeline or the map.

- **Auth:** the `x-api-key` header only; the key is `mock-immich-key` (a test value). No key or a wrong one is 401; a
  permission the key lacks is 403 naming it.
- **Routes:** `/api/server/version`, `timeline/buckets` and `timeline/bucket` (columnar), `assets/{id}`
  (`thumbnail?size=thumbnail|preview|fullsize`, `original`, `video/playback`), `PUT assets` (favourites), `albums`
  (`?shared=true`), `people` and `people/{id}/thumbnail`, `map/markers`, `memories?for=`, `search/metadata` (page and
  `nextPage`), `search/smart` (fake keyword match; the filters must sit in the `filter` object, flat fields get 400),
  `partners`. Mock routes: `GET /Mock/State`, `POST /Mock/Reset`.
- **Tags:** `KEY-IN-URL`, `NO-KEY`, `BAD-KEY`, `SCOPE`, `FLAT-FIELDS`, `UNMAPPED`.
- `tools/checks/immich-mock-check.mjs` checks the shapes against `tools/checks/fixtures/photos/immich-contract.json`
  (field names and the Immich version they were written from); `immich-check.mjs` drives the desktop client.

| Variable | Effect |
|---|---|
| `MOCK_IMMICH_KEY` | The valid key (default `mock-immich-key`). |
| `MOCK_IMMICH_SCOPES` | Comma list of the key's permissions (default all: `asset.read,asset.view,asset.download,asset.update,album.read,person.read,map.read,memory.read,partner.read`). |
| `MOCK_IMMICH_VERSION` | The reported version (default `3.3.0`; `1.x` tests the refusal; below 3, albums say `shared`). |
| `MOCK_IMMICH_TIMELINE=broken` | `timeline/bucket` answers rows instead of columns (the clients fall back to `search/metadata`). |
| `MOCK_IMMICH_VIDEO=<file>` | The bytes every `video/playback` serves, with Range; without it, 404. |

## Environment variables

| Variable | Mock | Effect |
|---|---|---|
| `MOCK_DLNA_PORT`, `MOCK_DLNA_HOST` | DLNA | Port (default 8970) and address. Setting the host also allows fetching non-loopback URLs and answering non-loopback M-SEARCH. |
| `MOCK_DLNA_PROFILE` | DLNA | `generic`, `sony` or `samsung`. |
| `MOCK_SSDP=1` | DLNA | Answer SSDP `M-SEARCH` (best effort). |
| `MOCK_CAST_PORT`, `MOCK_CAST_STATE_PORT`, `MOCK_CAST_HOST` | Cast | TLS port (18009), state port (18010) and address. Setting the host also allows fetching non-loopback URLs. |
| `MOCK_CAST_HEARTBEAT_S` | Cast | Seconds without a PING before the connection is closed (default 15). |
| `MOCK_DURATION_S` | both | Media length in seconds (default 600). |

Never point a sender at a real TV or Chromecast from an automated test: the checks only use these mocks on
127.0.0.1.

## mock-webdav (file sources)

`node tools/mock-server/mock-webdav.mjs` serves a folder tree as WebDAV on `127.0.0.1:8975` under `/media`, with Basic
auth `demo`/`demo` (file-sources-spec FS-02). Without `MOCK_DAV_ROOT` it builds a fresh tree with `files-fixture.mjs`:
a film folder with a poster, `movie.nfo` and two sidecar subtitles, a show with `tvshow.nfo` and seasons 1, 2 and 10
(Season 1 holds E01 to E10), and NAS clutter that must stay hidden (`@eaDir`, `#recycle`, dot-files). The one playable
video is a 10 s test pattern encoded once by the bundled mpv (video only, title tag "Example Tag Title"); without mpv
every video is a stub and the fixture says `unplayable`.

- **Requests:** `PROPFIND` Depth 0 and 1 (`infinity` is refused with 403), `GET`/`HEAD` with `Range`, `OPTIONS`
  (`DAV: 1`).
- **Mock-only routes:** `GET /Mock/State` (`calls[]` with method, path, depth, range, whether Authorization came, status;
  `authSeen`; `ranges[]`; `tags[]`), `POST /Mock/Reset`, `POST /Mock/RotateCert` (TLS only). The credentials themselves
  never appear in the state.
- **Tags:** `NO-AUTH`, `AUTH-IN-URL`, `DEPTH-INFINITY`, `HREF-ESCAPE`.
- `node tools/checks/files-mock-check.mjs` checks the mock; `files-store-check`, `files-routes-check` and
  `files-playback-check` drive the app's file source code against it (all part of `npm run checks`).
  `node tools/checks/files-cdp.mjs [--play] [--shots=<dir>]` runs the built app against it and mock-emby.

| Variable | Effect |
|---|---|
| `PORT` | Listener port (default 8975). |
| `MOCK_DAV_ROOT` | The folder to serve instead of a fresh fixture tree. |
| `MOCK_DAV_TLS=1` | https with the TEST ONLY pair in `fixtures/webdav-tls/` (`/Mock/RotateCert` switches to the second). |
| `MOCK_DAV_DIGEST=1` | Answers `WWW-Authenticate: Digest` only. |
| `MOCK_DAV_EVIL=1` | The root listing adds hrefs to another origin, `../`, an encoded slash, a base-escaping path and a deeper one. |
| `MOCK_DAV_SLOW=ms` | Delays every answer. |
| `MOCK_DAV_ENTRIES=n` | A folder `Many` with n entries. |
