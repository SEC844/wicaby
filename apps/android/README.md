# Wicaby Android apps

This Gradle project (`apps/android/` in the monorepo) builds the two native Android clients for Emby, with Jellyfin as a bonus:

| Module | What | Package | Version |
|---|---|---|---|
| `:core` | Android library without UI, shared by both apps: Emby/Jellyfin client and models, auth and token vault, LAN discovery, DeviceProfile, markers and resume/watched thresholds, DataStore prefs, the ExoPlayer setup (FFmpeg + libass), the play session and its reporting, BIF trickplay, the offline progress queue, and the `ServerTransport` seam | `com.wika.wicaby.core` | n/a |
| `:mesh-ui` | The "Accès à distance" panel (Tailscale/NetBird sign-in) and the `LogoLoader` loading mark, shared by both apps, Compose foundation only | `com.wika.wicaby.meshui` | n/a |
| `:livetv-ui` | The Live TV guide grid's drawing core (guide state, lanes, ruler, now line) shared by the TV grid and the tablet grid, Compose foundation only | `com.wika.wicaby.livetvui` | n/a |
| `:tv` | Android TV app (Compose for TV) | `com.wika.wicaby.tv` | 0.3.0 |
| `:mobile` | Phone and tablet app (Compose Material 3) | `com.wika.wicaby` | 0.3.0 |

## Android TV app (`:tv`)

This is the native Android TV client. It is built with Kotlin, Jetpack Compose for TV and Media3 ExoPlayer, and it uses the "Graphite" design system (see [`docs/design.md`](../../docs/design.md)) with the Geist font.

It installs on Android TV, Google TV and Fire TV, from Android 6.0 (API 23) up. It also runs on phones and tablets: there it is locked to landscape and full screen (edge-to-edge, notch area used, bars on swipe). The 960×540 dp TV layout is scaled to fit, so 20:9 screens get a wider canvas instead of black bars. Touch works throughout: tap cards and buttons, swipe rows; in the player, a tap toggles the OSD and the scrub bar can be dragged.

## Features

- **Add a server.** Find servers on the LAN with the Emby/Jellyfin UDP 7359 discovery, or type an address (`192.168.1.20`, `host:8096` or `https://…`; `/emby` is detected automatically).
- **Sign in.** Pick a user from the public user list and enter a password, or choose "Autre" to type a username. The access token is encrypted with an Android Keystore AES-GCM key and stored in DataStore.
- **Navigation.** A floating tvOS-style tab pill at the top: Accueil, then each library (films, séries, TV en direct, bandes dessinées…), extra screens such as Torrents, then Recherche and Réglages as icons. The clock (optional) and the user's avatar sit on the right; the avatar opens a profile menu (change user or server, Réglages, sign out). The selected tab is a soft white pill that slides between tabs. The bar fades out when the content scrolls and comes back when focus returns to it. Back from the content moves focus to the bar; Back on the bar asks "Quitter Wicaby ?" (Annuler has focus). New top-level screens go in `extraTabs()` in `ui/Main.kt`.
- **Home.** A hero carousel sits on a full-screen backdrop: ←/→ on the buttons switches title, and it advances on its own every 9 s. Below it are the Reprendre, À suivre and "Ajouts récents · <bibliothèque>" rows.
- **Libraries.** Paged grids. Folders and box sets open as sub-grids. TV en direct lists the channels; OK plays one.
- **Detail.** Logo or title, metadata, badges (4K/codec/audio, the dynamic range: "Dolby Vision · HDR10", "HDR10+", "HDR10" or "HLG" with the Dolby Vision profile, and "N versions"), and the buttons Lire/Reprendre, Depuis le début, Bande-annonce, Favori and Vu. For series, the season pills switch on focus and the episodes appear in a row.
  - **Versions.** An item with several MediaSources (4K and 1080p, VF and VOST, a director's cut) shows a "Version" picker, labelled from the source name or else "4K HDR · HEVC · Atmos" (plus audio languages when they differ). The choice is remembered per item (`core/data/Versions.kt`) and goes to PlaybackInfo and the play session as `MediaSourceId`. The "Audio" and "Sous-titres" pickers list the selected version's streams; their choice is passed to the first PlaybackInfo.
  - **Bande-annonce.** Local trailers (`LocalTrailerCount`, `…/LocalTrailers`) play in the normal player in trailer mode, which reports nothing (the film's progress is untouched). YouTube trailers (`RemoteTrailers`) open with `ACTION_VIEW` in the YouTube app, else a browser; a TV with neither (Android TV's browser stub does not count) shows the link as a QR code.
- **Search.** Covers films, series and episodes.
- **Comics (CBZ, CBR, CB7, CBT, PDF, image EPUB).** Book items show "Lire" / "Reprendre la lecture (p. N)" and open `reader/ReaderActivity`: double-page spreads on 16:9 (cover, landscape and last pages alone), manga order from ComicInfo, ←/→ turn (and pan a zoomed page first), ↑/↓ pan, OK opens the bar (thumbnails, page scrubber, fit page / width, zoom ×2, manga order, vertical scroll), Back exits and saves the page. Webtoons (ComicInfo `Format=Web` or very tall pages) scroll vertically. The archive comes from `/Items/{id}/File` (falling back to `/Download`) through `Core.http` into `cacheDir/comics` (1 GB LRU); progress is `PlaybackPositionTicks = page × 10 000` on `…/UserData`, like jellyfin-web. RAR, 7z and tar go through libarchive and are extracted once; PDF pages are drawn by `PdfRenderer`; other formats and text EPUBs say why they do not open. The logic lives in `core/comics/`.
- **Player.** Built on ExoPlayer (+ HLS, MediaSession), with the FFmpeg audio extension and libass.
  - **Device profile.** It probes `MediaCodecList`, preferring hardware decoders:
    - max size per codec with `areSizeAndRateSupported` (plus a frame-rate cap above 1080p, e.g. 4K30 decoders);
    - H.264/HEVC profiles and levels (Hi10P is only claimed when the decoder lists it);
    - HDR10/HLG/Dolby Vision from the decoder profiles **and** the display's HDR types, with Jellyfin's known-broken list (Fire TV 4K/Max DV+HDR10+, Shield DV P7). Jellyfin gets `VideoRangeType` exclusions; Emby only understands `VideoRange` SDR/HDR;
    - audio: platform decoders, FFmpeg, and HDMI passthrough (`isPassthroughPlaybackSupported`, plus `getDirectPlaybackSupport` on API 33+). Passthrough is re-read for every playback, so it follows the TV/AVR currently connected;
    - subtitles: PGS/VobSub/DVB play embedded in direct play and are burned in (`Encode`) when the server transcodes.
  - **Skip intro / credits.** From Emby chapter markers (`IntroStart`/`IntroEnd`/`CreditsStart`) or Jellyfin `/MediaSegments`. "Passer l’intro" appears at the intro, fades after 8 s and comes back with the OSD; OK accepts.
  - **Next episode.** At the credits (or the last 30 s), a card counts down 15 s, then plays the next episode in the same player. Back hides it. After 3 episodes in a row with no key pressed, "Toujours là ?" pauses instead.
  - **Resume and watched.** A resume point outside 5–90 % is ignored. Stopping after the credits marker marks the episode watched even before 90 %.
  - **Display.** Optional refresh-rate (and resolution) matching through `preferredDisplayModeId`, off by default. The screen stays on only while video is actually playing.
  - **Remote controls:**
    - OK: play/pause.
    - ←/→: scrub ±10 s (30 s, then 2 min, when held). The seek commits 0.65 s after the last press.
    - ↓: focus the control bar ("Audio et sous-titres", then → the picture format at the bottom right); ↓ again or OK opens the audio and subtitle panel, ↑ or Back returns to scrubbing. Menu / Captions open the panel directly.
    - Picture format: OK on the bottom-right button cycles Ajuster, Remplir l’écran (crops), Étirer and Zoom (a 4/3 enlargement that crops letterbox bars); the name flashes at the top. It is remembered per item for the session (`core/player/Aspect.kt`).
    - Back: closes the panel, then the OSD, then exits.
  - **Playback state.** Playback resumes from the saved position. Start, progress (every 10 s, plus pause/unpause) and stop are reported to `/Sessions/Playing*`. While paused, `/Sessions/Playing/Ping` keeps transcodes alive. Transcodes are ended with `DELETE /Videos/ActiveEncodings`.
  - **Auth.** Jellyfin gets only the `Authorization: MediaBrowser …` header (Jellyfin 12 rejects the legacy forms); Emby keeps `X-Emby-Token` and `api_key` on stream URLs.
- **Watch Next.** Stopping a film or episode midway puts it in the launcher's "Continuer à regarder" / Play Next row (one entry per series); finishing an episode replaces it with the next one. The card opens the player directly (`wicaby://play/<id>`).
- **Réglages.** Sections on the left, detail on the right (tvOS style); choices open a picker sheet.
  - **Lecture:**
    - maximum bitrate for Ethernet, Wi‑Fi and remote access (through the mesh);
    - episodes: chain the next episode, countdown length, intro (offer to skip, skip automatically, nothing), resume (automatic, ask, always from the start);
    - display frequency matching;
    - preferred audio language, subtitle language and subtitle mode, saved in the server user configuration;
    - HDMI passthrough per codec (AC3, E-AC3, DTS, TrueHD: Auto / Toujours / Désactivé). This feeds both the DeviceProfile and the audio sink, so "Désactivé" really decodes;
    - size and style of text subtitles (SRT, WebVTT).
  - **Interface:** accent colour, clock, home rows shown, and a backdrop screensaver after N minutes idle.
  - **Comptes:** change user or server, sign out (which revokes the token).
  - **Accès à distance:** the Tailscale / NetBird sign-in panel (`ui/RemoteAccess.kt`).
  - **À propos:** version, the update URL and "Rechercher les mises à jour" (see below), licences, and this device's decoders (video limits, HDR, audio, passthrough).
  - TV-only preferences live in `data/TvSettings.kt` (SharedPreferences, readable by the player before any screen loads).

## Phone and tablet app (`:mobile`)

From Android 8.0 (API 26) up. It uses Compose Material 3 retinted to Graphite (custom colour scheme, Geist type, no dynamic colour), edge-to-edge and portrait-first. Phones in portrait get a bottom bar; windows at least "medium" wide (tablets, foldables, landscape phones) get a navigation rail (`WindowSizeClass`). Each tab keeps its own back stack, the system back gesture (predictive back) pops it, and posters morph into the detail page (`SharedTransitionLayout`).

- **Setup.** LAN discovery and manual address, then "Qui regarde ?" with the public users, a password field or "Autre".
- **Accueil.** A hero carousel (swipe or every 8 s), then Continuer, À suivre and "Récemment ajoutés · <bibliothèque>". Pull to refresh.
- **Bibliothèques.** Library cards, then a paged poster grid with sort (nom, date d'ajout, année, note; picking it again reverses it) and filters (tout, non vus, favoris). Collections and folders open as grids; a cast member opens their titles.
- **Detail.** The backdrop scrolls away with parallax under a collapsing toolbar. Actions are Lire/Reprendre, Depuis le début, Bande-annonce, Télécharger, Favori and Vu. Below come the Version / Audio / Sous-titres pickers (as on the TV, from core's `Versions`), the overview, badges (with the dynamic range and "N versions"), season chips with the episode list (each with its own download button), the cast, and similar titles. "Télécharger" fetches the selected version (`/Items/{id}/Download?MediaSourceId=` on Emby, the version's own item on Jellyfin), and the offline copy keeps only that version's streams.
- **Recherche.** Films, series and episodes, debounced.
- **Comics (CBZ, CBR, CB7, CBT, PDF, image EPUB).** The same reader logic as the TV (`core/comics/`) in `reader/ReaderActivity`: swipe pages (reversed in manga order), pinch and double-tap zoom, a tap in the centre shows the page slider and options, two-page spreads on tablets in landscape, and a vertical strip for webtoons.
- **Téléchargements.**
  - "Hors ligne": original files from `/Items/{id}/Download`, through WorkManager (a foreground `dataSync` worker with a progress notification, resumable with `Range`, Wi-Fi only by default). Each copy keeps its item JSON (streams, chapters) and poster, so it plays with intro skip in airplane mode. A watch state the server could not get goes into `OfflineProgress` and is sent (`/Users/{u}/Items/{id}/UserData` on Emby, `/UserItems/{id}/UserData` on Jellyfin) when a network returns.
  - "Torrents": the qBittorrent pane, drawn from core's `TorrentsViewModel`.
- **Réglages.** Account (change user, change server, sign out), accent colour, streaming bitrate, Wi-Fi-only downloads, and under À propos the update URL and "Rechercher les mises à jour" (see "Updates for sideloaded APKs").
- **Player.** A separate task, so Picture-in-Picture floats over the app. It is fullscreen landscape and immersive.
  - Gestures: a tap toggles the controls; a double tap on the left or right third seeks ±10 s with a ripple, and further taps keep adding 10 s; a horizontal drag seeks with a time preview and the Emby BIF trickplay frame; a vertical drag sets brightness on the left half and volume on the right; a pinch steps Ajuster → Remplir l’écran → Zoom and pinching in returns to Ajuster.
  - A picture-format button in the top bar cycles Ajuster, Remplir l’écran, Étirer and Zoom, with the same per-item memory as the TV; the name flashes at the top.
  - Sheets for audio/subtitles and speed (in-window, so the system bars stay hidden). "Passer l’intro" and the next-episode card with a 10 s countdown use the same core rules as the TV.
  - Picture-in-Picture enters on its own when you go Home while playing (Android 12+, `onUserLeaveHint` before). Closing the PiP window ends the session.
  - A `MediaSessionService` keeps audio playing off screen, with lock-screen and notification controls. The screen stays on only while frames move.

### Mesh seam

`core/net/ServerTransport.kt` is where an embedded mesh VPN plugs in. Every server byte goes through `Core.http`: the API, Coil artwork, ExoPlayer (`OkHttpDataSource`) and downloads. Its `TransportInterceptor` asks `Core.transport.forward(origin)` for a local forwarder base (`http://127.0.0.1:<port>/<token>`) and rewrites the URL onto it. The stored server address never changes.

## Build

You need JDK 17+ (tested with Microsoft OpenJDK 21) and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`). The project compiles against `platforms;android-37.0` with `build-tools;36.1.0`. The Gradle wrapper downloads Gradle 9.8.1 itself.

Before the first Gradle build, build the embedded mesh library (Remote access: Tailscale/NetBird in userspace, no VPN app needed). It goes to `vendor/android/wicaby-mesh.aar` at the repo root, which is not in git. This needs Go, an NDK (`sdkmanager --install "ndk/28.2.13676358"`) and gomobile; the header of `packages/mesh/scripts/build-mesh-aar.ps1` lists the commands. From the repo root:

```sh
npm run build:mesh-aar                                                # release: arm64-v8a + armeabi-v7a
powershell -File packages/mesh/scripts/build-mesh-aar.ps1 -Emulator   # adds x86_64 for emulators
```

Add `-TailscaleOnly` to leave NetBird out (about 19 MB per ABI instead of 47).

```sh
cd apps/android
./gradlew :tv:assembleDebug :mobile:assembleDebug        # */build/outputs/apk/debug/*.apk
./gradlew :tv:assembleRelease :mobile:assembleRelease    # R8-shrunk and signed, see below
```

Release signing (both apps, same key) reads `apps/android/keystore.properties`, which is gitignored (the keystore itself goes in `apps/android/keystore/`, also ignored):

```properties
storeFile=keystore/wicaby-release.jks
storePassword=…
keyAlias=wicaby
keyPassword=…
```

Without that file, `assembleRelease` still builds, but the APK is unsigned. To create a keystore:

```sh
keytool -genkeypair -keystore keystore/wicaby-release.jks -storetype PKCS12 -alias wicaby \
  -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Wicaby"
```

Unit tests live in `:core` (device profile, display-mode choice, markers and thresholds, BIF parsing, transport URL rewriting, the offline progress queue, comic page order, spreads, ComicInfo and progress ticks against a generated CBZ fixture) and run on the JVM:

```sh
./gradlew :core:testDebugUnitTest
```

`:mobile` ships a hand-written baseline profile (`mobile/src/main/baseline-prof.txt`, installed by ProfileInstaller) that precompiles the app and core code.

Keep the keystore. Updates must be signed with the same key, or Android refuses to install them over an existing copy.

The prebuilt APKs are in `release/tv/` and `release/mobile/` at the repo root.

## Updates for sideloaded APKs

Both apps can update themselves when they were installed outside a store. Réglages → À propos → "URL de mise à jour" holds the address of a manifest (empty, the default, turns it off). The apps check it at start, at most once every 6 hours, and on "Rechercher les mises à jour". When the manifest has a newer `versionCode`, the TV shows a tvOS-style dialog and the phone a card (on Accueil and in Réglages), with the notes in the app language and "Mettre à jour" / "Plus tard".

```json
{
  "tv":     { "versionCode": 6, "versionName": "0.4.0", "notes": { "fr": "…", "en": "…" },
              "apks": { "armeabi-v7a": { "url": "…", "sha256": "…" }, "arm64-v8a": { … }, "universal": { … } } },
  "mobile": { … }
}
```

- The APK for `Build.SUPPORTED_ABIS[0]` is used, else `universal`, else another ABI the device runs. URLs may be relative to the manifest.
- It downloads into the cache, the SHA-256 must match, then a `PackageInstaller` session installs it and Android asks the user to confirm. Updates must be signed with the same key as the installed app.
- Android 8+ needs "Installer des applis inconnues" allowed for Wicaby: the card or dialog offers "Ouvrir les réglages", which opens that page (or the security settings on TVs without it).
- The logic lives in `core/update/Updates.kt` (`UpdateLogicTest` covers version comparison and the ABI choice).

To publish, build the release APKs into `release/tv` and `release/mobile` (repo root) with the usual names (`Wicaby-TV-0.4.0-arm64.apk`, `…-armv7.apk`, `…-universal.apk`, `Wicaby-Mobile-0.2.0-arm64.apk`…), then, from the repo root:

```sh
node tools/release/make-update-manifest.mjs https://example.org/wicaby/ --notes-fr "…" --notes-en "…"
```

It takes the newest version of each app, reads its `versionCode` with `aapt2` (from `ANDROID_HOME` build-tools, falling back to `build.gradle.kts` when the names match), hashes each APK and writes `release/update.json`. `release/<app>/NOTES.fr.txt` and `NOTES.en.txt` override the notes per app. Without a base URL, the APK URLs stay relative (`tv/<file>`).

Host `release/` on any HTTP server (`npx http-server release`, nginx, a NAS) and set the URL to `…/update.json`. With GitHub Releases, attach the APKs and `update.json` to a release and run the script with `--flat` and `https://github.com/<owner>/<repo>/releases/latest/download/` as the base URL (release assets have no folders), then set the app's URL to `…/releases/latest/download/update.json`.

## Licences

- FFmpeg audio comes from `org.jellyfin.media3:media3-ffmpeg-decoder`, which is **GPL-3.0**. No LGPL build of the Media3 FFmpeg extension is published (nextlib, the other option, is GPL-3.0 too), so distributed APKs fall under the GPL. To avoid it, drop that dependency: the profile then advertises only platform decoders and passthrough, and the server transcodes the rest.
- libass comes through `io.github.peerless2012:ass-media` (MIT; libass itself is ISC).
- Geist is SIL OFL 1.1.
- The mesh library (`packages/mesh/`: Tailscale tsnet and NetBird `client/embed`) is BSD-3, with its dependencies' notices in `vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt` (repo root). The build script fails if any AGPL NetBird package (`management/`, `signal/`, `relay/`, `combined/`) is linked. QR codes use ZXing core (Apache-2.0).

## Install on a TV

1. On the TV, open Settings → Device preferences → About and press OK 7 times on "Build" to enable developer options.
2. In Developer options, turn on **Network debugging** (or **ADB debugging** on Fire TV).
3. Run:

```sh
adb connect <tv-ip>:5555        # accept the prompt on the TV
adb install -r Wicaby-TV-0.2.0-release.apk
```

Wicaby then appears in the TV's app list (on Android TV, with its banner).

The debug and release builds share the package id `com.wika.wicaby.tv` but are signed with different keys. Uninstall one (`adb uninstall com.wika.wicaby.tv`) before you install the other.

## Development notes

- **Mock server.** `node tools/mock-server/mock-emby.mjs 8104 [video.mkv]` (from the repo root) starts a fake Emby (user `Wika`, password `wicaby`). From the emulator, reach it at `http://10.0.2.2:8104`. Every stream URL serves the optional video file, so use one **without an audio track**. Videos carry Emby chapter markers at 5–20 % (intro) and 85 % (credits) of their nominal runtime, so with a short clip, seek or use a matching file to see them. "Néon Fantôme" (`movie-0`) has two versions (4K Dolby Vision 8.1 VF+VO and 1080p VOST), a local trailer and a YouTube one; "La Dernière Manche" (`movie-1`) only has the YouTube trailer. PlaybackInfo returns the MediaSource named by `MediaSourceId` and logs the requested source and track indexes.
- **Deep link.** `adb shell am start -a android.intent.action.VIEW -d wicaby://play/<itemId> -n com.wika.wicaby.tv/.MainActivity` starts playback, as the Watch Next row does. The mock draws its artwork as SVG, so only debug builds bundle `coil-svg`, and release builds show no artwork against the mock.
- **OSD preview.** On debug builds, `adb shell am start -n com.wika.wicaby.tv/.MainActivity --es previewPlayer <itemId>` opens the player OSD for an item without loading any media.
- **Mobile against the mock.** Use `node tools/mock-server/mock-emby.mjs 8230 <silent.mkv>`, then type `10.0.2.2:8230` on the setup screen. Launch with `adb shell am start -n com.wika.wicaby/com.wika.wicaby.mobile.MainActivity`.
- **Code layout:**
  - `core/src/main/java/com/wika/wicaby/core/`: `Core.kt` (process-wide state), `data/`, `player/`, `net/`.
  - `mobile/src/main/java/com/wika/wicaby/mobile/`: `ui/` (theme, icons, screens), `player/` (activity, gestures, service), `download/`.
  - TV, in `tv/src/main/java/com/wika/wicaby/tv/`:
    - `data/`: Watch Next (the shared client, profile and prefs moved to `:core`).
    - `ui/`: theme tokens, focus/lift modifier, and the screens.
    - `player/`: the TV player activity and its OSD (the session itself is `core/player/Playback.kt`).
