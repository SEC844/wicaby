# TV web app (Samsung Tizen, LG webOS)

`apps/tv-web` is Wicaby for the TVs that only run web apps: Samsung (Tizen) and LG (webOS). It is the Android TV app
rebuilt for those TVs, screen for screen and key for key, so a Samsung or LG owner gets the same app as a Google TV
owner. It replaces the earlier web TV app (`apps/webtv`, the desktop interface in a TV shell) and installs under
the same ids, so it updates an installed earlier build in place.

Why a separate app rather than the desktop renderer in a TV shell:

- **TVs from 2018 on.** The bundle targets Chromium 53 (webOS 4, Tizen 4), not 79: the 2018 to 2021 Samsung and LG
  sets, such as a Tizen 5.5 Samsung from 2020, run it. Capabilities are probed, never read from a model list.
- **The TV's own video pipeline.** On Tizen the player is AVPlay, the hardware pipeline with HDR10 and HDR10+; on
  webOS a `<video>` element, which the TV decodes in hardware. The device profile sent to the server is built from
  what this TV reports it decodes, so it direct plays what it can and the server converts the rest.
- **The remote first.** Every screen follows the Android TV app's D-pad model; the focus moves with Compose's own
  2D search, ported (`src/lib/focus.ts`), so the arrows land where they would on Android.

## What it does

Home (hero, continue watching, next up, upcoming, Live TV now, recently added per library, on this day, because
you watched), search, libraries with an A–Z rail, details pages with versions, tracks, seasons, extras and external
ratings, watch history, and settings in the categories every Wicaby app shares. The player: direct play or HLS with a
fallback to the server's conversion, audio and subtitle tracks (SDH and AD marked, remembered per series), its own
WebVTT renderer, quality presets, chapters, trickplay thumbnails, skip intro and credits (AniSkip for anime, TheIntroDB community timestamps; IntroDB sends no CORS header for TVs), up next,
speed, sleep timer, playback info and watch together (Jellyfin SyncPlay). Music (library rows, albums, artists, now
playing with synced lyrics and an editable queue, an ambient layout, ListenBrainz and Last.fm scrobbling), Live TV
(the guide, channel zapping, number entry, mini-guide, recordings and scheduled ones), photos (the timeline, albums,
a viewer with a slideshow and EXIF), a comic reader (CBZ, ZIP and image EPUB), the screensaver, several servers at
once with their local and remote addresses, "Who is watching?" with profile PINs, Quick Connect on Jellyfin, "Play on
Wicaby" and remote control from the Emby and Jellyfin apps, and Trakt scrobbling.

Code it shares rather than copies: the desktop's pure modules (`apps/desktop/src/shared` as `$shared`, the
renderer's `lib` as `$desktop`: Live TV logic, music queue, photo dates and EXIF, quality presets, merges), the
Graphite tokens (`packages/tokens`), and the Android TV app's strings and icons, read from `apps/android` at build
time (`scripts/android-strings.mjs`, `scripts/android-icons.mjs`). A string the app uses must exist in the Android
catalogues: `npm run check:tv` fails otherwise, and Android's translation checks cover both apps.

## Develop

```powershell
npm ci
node tools/mock-server/mock-emby.mjs 8096 path\to\silent-clip.webm   # or mock-jellyfin.mjs
npm run dev:tv                                                         # Vite on http://localhost:5299
```

In the app, use the address `127.0.0.1:8096`, user `Wika`, password `wicaby`. `MOCK_DURATION_S=60` fits the
mocks' intro and credits markers to a short clip, and `MOCK_MUSIC=1` adds their music library.

The engines the app must run on are real Chromium snapshots, so a change is tried on the oldest ones without a TV:

```powershell
npm run engines -w apps/tv-web      # once: Chromium 53, 56 and 69 into .dev/engines (pinned, checksummed)
npm run build:tv
node apps/tv-web/scripts/smoke.mjs --engine 53 --steps "text:127.0.0.1:8096,13,wait:4000,13,wait:800,text:wicaby,13"
```

To try the app on the computer against a real server (no TV at hand), open the build in a desktop browser that has
H.264 and AAC (Chrome, Edge or Brave; the Chromium snapshots have neither), for example
`brave --app=file:///…/apps/tv-web/dist/index.html --allow-file-access-from-files`: the arrows are the remote, Enter
is OK, Escape or Backspace is Back. Without HLS in the engine, the app asks the server for progressive MP4
conversions instead.

`smoke.mjs` loads the build from `file://` like a packaged app, sends remote keys (key codes, `text:`, `wait:`),
saves a screenshot after each step in `.dev/smoke/<engine>`, prints `--probe` (a JavaScript expression), and fails
on any error the page logs. Chromium 53 and 56 have no headless mode: their window opens during the run.

Checks: `npm run check:tv` (svelte-check and the strings) and `node tools/checks/tv-web-check.mjs` (part of
`npm run checks`: the app's inflate, the comic ZIP reader over Range requests, the bundle parsed as ES2016).

## Package

```powershell
npm run package:tv
```

writes `release/tv-web/Wicaby-Tizen-<version>.wgt` (unsigned) and `release/tv-web/Wicaby-webOS-<version>.ipk`. The
licence texts ship inside both. `npm run pack:tv` packs the last build without building it again. The `TV web app`
workflow builds the same two files on every change.

## Install on a Samsung TV (Tizen)

The `.wgt` is unsigned: a Samsung TV installs only a package signed with a certificate made for that TV.

1. On the TV: **Apps**, type `12345` on the remote, turn **Developer mode** on, enter the computer's IP, restart
   the TV.
2. Sign and install it, either with Tizen Studio (Samsung Certificate Extension, a certificate profile for the
   TV, then `tizen package -t wgt -s <profile>` and `tizen install`), or with a community tool that signs a `.wgt`
   for your TV with your free Samsung account (Apps2Samsung's "Custom WGT File").

A VPN client on the computer can hide it from the TV: pause it while installing.

## Install on an LG TV (webOS)

1. On the TV, install **Developer Mode** from the LG Content Store, sign in with a free LG account, turn on
   **Dev Mode Status** and **Key Server**, restart the TV.
2. On the computer: `npm install -g @webos-tools/cli`, `ares-setup-device` (the TV's IP from the Developer Mode
   app), `ares-novacom --device <name> --getkey`.
3. `ares-install --device <name> Wicaby-webOS-<version>.ipk`, then `ares-launch --device <name> com.wika.wicaby`.

A Developer Mode session lasts up to 1,000 hours and is extended from its app; when it runs out the TV removes the
apps installed this way. The Homebrew Channel installs `.ipk` files too.

## Server requirements

The app calls the server from the TV's browser engine, so the server must answer cross-origin requests: Jellyfin
does by default; Emby's own web clients rely on it too. Plain `http://` on the local network avoids old root
certificates on older TVs. Sign-in tokens and the Trakt keys stay in the TV's storage (a TV has no keychain);
stream URLs carry the token only to the server's own address.

## Limits

- **Comics:** CBZ, ZIP and image EPUB only. RAR, 7z, tar and PDF need decoders the TV engines do not have.
- **Speed:** Tizen's AVPlay only plays whole speeds without sound (trick play), so there is no speed menu there.
- **Not on TVs:** the mesh VPN, downloads, qBittorrent, file sources, the external player and the audio effects
  (Android only), "What's this song?" (it needs the decoded audio), and setting the volume from a controller on
  webOS (no API for apps).
- **Still to come:** Live TV's channel manager, series rules and guide search, the first-run wizard, Plex and IPTV
  sources.

## Tested on

- **Samsung:** a QE65Q60T (2020, Tizen 5.5), installed with a Samsung certificate as above.
- **LG:** the Chromium 53, 56 and 69 engines of `npm run smoke` against the mock servers; not yet a real webOS set.
