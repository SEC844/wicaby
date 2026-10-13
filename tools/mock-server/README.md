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
