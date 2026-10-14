# Android apps (`apps/android`)

`apps/android` is one Gradle project that builds both native Android clients for Emby and Jellyfin: the Android TV app and the phone/tablet app. For each app's features, see [`apps/android/README.md`](../apps/android/README.md). This page covers the structure, the build, signing, updates and testing.

## Modules

`settings.gradle.kts` includes five modules:

| Module | Kind | Namespace / applicationId | minSdk | Role |
|---|---|---|---|---|
| `:core` | library, no UI | `com.wika.wicaby.core` | 23 | Emby/Jellyfin client and models, auth and Keystore-encrypted token, LAN discovery (UDP 7359), `DeviceProfile`, DataStore prefs, the ExoPlayer setup (FFmpeg audio + libass), the play session and its reporting, markers and resume thresholds, BIF trickplay, versions, trailers, the offline progress queue, the comic reader logic, the qBittorrent client and `TorrentsViewModel`, the in-app updater, and the `ServerTransport` seam with `MeshTransport` |
| `:mesh-ui` | library, Compose foundation | `com.wika.wicaby.meshui` | 23 | The "Remote Access" panel (`MeshLoginPanel`): Tailscale/NetBird sign-in with a QR code, the peer list. Each app passes its own buttons, fields and style tokens. ZXing core draws the QR code. Also `LogoLoader`, the brush-drawn loading mark both apps use. |
| `:livetv-ui` | library, Compose foundation | `com.wika.wicaby.livetvui` | 23 | The Live TV guide grid's drawing core (`GuideLane.kt`): `GuideState`, the lanes drawn in one `drawBehind`, the ruler and the now line. The TV grid (D-pad) and the tablet grid (touch, `TabletGuide`) add their own channel cells and input. |
| `:tv` | application (Compose for TV, `tv-material`) | `com.wika.wicaby.tv` (both) | 23 | Android TV / Google TV / Fire TV. Also runs on phones, locked to landscape. Launcher integration: Watch Next, preview channels (Next Up, Recently Added; `data/HomeChannels.kt`) and the system screen saver (`Dream.kt`). |
| `:mobile` | application (Compose Material 3, adaptive) | `com.wika.wicaby.mobile` / `com.wika.wicaby` | 26 | Phones and tablets: bottom bar or navigation rail, offline downloads (WorkManager) and an offline home when the server is unreachable, PiP, `MediaSessionService`; segment skipping per kind (`player/SkipSettings`), Bonus row, season / previous episodes watched, voice search, external player. |

`:tv` and `:mobile` depend on `:core`, `:mesh-ui` and `:livetv-ui`. `:mesh-ui` and `:livetv-ui` expose `:core` as `api`. The module that used to be `:app` is now `:tv`, but the applicationIds did not change, so installed copies keep updating.

`:core` uses the embedded mesh library as a local artifact:

```kotlin
implementation("wicaby.vendor:wicaby-mesh:0@aar")
```

It is resolved from an Ivy repository in `settings.gradle.kts` pointing at `../../vendor/android` (that is, `vendor/android/wicaby-mesh.aar` at the repo root). That file is not in git: build it first (see [mesh.md](mesh.md)). Without it, Gradle fails to resolve `:core`.

### Code layout

```
apps/android/
├─ core/src/main/java/com/wika/wicaby/core/
│  ├─ Core.kt                 process-wide state: Core.http (shared OkHttpClient), prefs, transport, mesh, scope
│  ├─ data/                   Emby.kt (API, incl. specialFeatures/mediaSegments), DeviceProfile, Discovery, Prefs, Versions, VideoRange, OfflineProgress, Images
│  ├─ VoiceSearch.kt          RecognizerIntent: available(), intent(), result() (search screens)
│  ├─ player/                 Playback (session), Engine, Segments (SegmentKind, skippableAt), Trickplay, Trailers, Aspect, DisplayMode,
│  │                          ExternalPlayer (VLC/MX/ACTION_VIEW: available, intent, report)
│  ├─ comics/                 Comics, ComicArchive, ComicPages, ComicReader
│  ├─ torrents/               QbitClient, QbitStore, TorrentsViewModel, Model, Format
│  ├─ update/Updates.kt       sideload updater
│  ├─ net/ServerTransport.kt  the transport seam + TransportInterceptor
│  └─ mesh/MeshTransport.kt   Tailscale/NetBird node over the gomobile AAR
├─ mesh-ui/…/meshui/MeshLoginPanel.kt, LogoLoader.kt
├─ livetv-ui/…/livetvui/GuideLane.kt
├─ tv/src/main/java/com/wika/wicaby/tv/       ui/, player/, reader/, data/ (TvSettings, WatchNext, AppLanguage)
└─ mobile/src/main/java/com/wika/wicaby/mobile/  ui/, player/, reader/, download/
```

## Toolchain

| Item | Version (at the time of writing) |
|---|---|
| Gradle wrapper | 9.8.1 (`gradle/wrapper/gradle-wrapper.properties`) |
| Android Gradle Plugin | 9.4.1 (`build.gradle.kts`) |
| Kotlin Compose / serialization plugins | 2.4.21 |
| compileSdk / targetSdk | 37 (`platforms;android-37.0`); build-tools: AGP 9.4.1's default (not pinned) |
| Java target | 17 (JDK 17+ to build; tested with Microsoft OpenJDK 21) |
| Compose BOM | 2026.09.00 |
| Media3 | 1.11.1, with `org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1` and `io.github.peerless2012:ass-media:0.5.1` |

Point the SDK with `ANDROID_HOME` or `sdk.dir` in `apps/android/local.properties`. That file is gitignored.

## Building

From the repo root, build the mesh library first. Then use the Gradle wrapper in `apps/android`:

```sh
npm run build:mesh-aar            # vendor/android/wicaby-mesh.aar (arm64-v8a + armeabi-v7a), Windows
bash packages/mesh/scripts/build-mesh-aar.sh   # same on Linux/macOS (what CI runs)

cd apps/android
./gradlew :tv:assembleDebug :mobile:assembleDebug     # mobile: both flavours
./gradlew :tv:assembleRelease :mobile:assembleFossRelease :mobile:assembleGplayRelease   # R8 minified + resource shrinking
./gradlew :core:testDebugUnitTest :mobile:testFossDebugUnitTest :mobile:testGplayDebugUnitTest
./gradlew lint :mobile:lintGplayDebug
```

The APKs land in `<module>/build/outputs/apk/<buildType>/` (mobile: `mobile/build/outputs/apk/<flavour>/<buildType>/`).

- **Mobile flavours** (cast spec CA-10, dimension `distribution`): `foss`, the default (F-Droid builds it), keeps the Jellyfin FFmpeg audio decoder and links no Google code; `gplay` adds Google Cast (`media3-cast`, Play services, under the GPL section 7 permission in [LICENSE-EXCEPTION.md](../LICENSE-EXCEPTION.md)) and leaves the FFmpeg decoder out, so the server transcodes those audio codecs. Both keep the same `applicationId` and `versionCode`, and each reads its own update channel (`mobile`, `mobile-gplay`). `:core` only compiles against the FFmpeg decoder; `:tv` and mobile `foss` ship it. `node tools/checks/flavour-check.mjs --gradle --apk` checks the classpaths and the built release APKs.

- **Lint:** every module turns `MissingTranslation` into an error. `UnsafeOptInUsageError` is disabled where Media3's `@UnstableApi` is used on purpose.
- **Unit tests:** `:core` has JVM unit tests for the device profile, display-mode choice, Emby JSON, versions, video range, BIF, segments, transport URL rewriting, mesh status parsing, the offline queue, marking episodes watched on both flavours, comics (against `core/src/test/resources/comics/fixture.cbz`), the qBittorrent client (MockWebServer), `UpdateLogic` and the translation parity check. `:mobile` has `StringsParityTest`.
- **Baseline profile:** `:mobile` ships a hand-written baseline profile (`mobile/src/main/baseline-prof.txt`), installed by ProfileInstaller.

### ABI splits

The mesh library adds tens of MB of native code per ABI, so both apps build one APK per CPU type (`splits.abi`):

| App | Split APKs | Universal APK |
|---|---|---|
| `:tv` | `armeabi-v7a`, `arm64-v8a` | yes (`isUniversalApk = true`) |
| `:mobile` | `armeabi-v7a`, `arm64-v8a` | no |

- `armeabi-v7a` is for 32-bit TV sticks and most TVs that run a 32-bit userland, including Sony.
- `arm64-v8a` is for phones and 64-bit boxes.
- The universal TV APK carries every ABI that the AAR contains.

The splits apply to debug builds too. For release, the APKs are renamed `Wicaby-TV-<version>-{armv7,arm64,universal}.apk` and `Wicaby-Mobile-<version>-{armv7,arm64}.apk` (foss) and `Wicaby-Mobile-Cast-<version>-{armv7,arm64}.apk` (gplay) (see [release.md](release.md)).

## Signing

Both apps are signed with the same release key. Updates must use that key, or Android refuses to install them over an existing copy, so **keep the keystore safe**.

Each app's `build.gradle.kts` reads `apps/android/keystore.properties`:

```properties
storeFile=keystore/wicaby-release.jks
storePassword=…
keyAlias=wicaby
keyPassword=…
```

`storeFile` is relative to `apps/android`. `apps/android/.gitignore` excludes `keystore/`, `keystore.properties`, `*.jks`, `*.keystore` and `local.properties`. **None of them may ever be committed.** Without `keystore.properties`, `assembleRelease` still builds, but the APKs are unsigned.

To create a key:

```sh
keytool -genkeypair -keystore keystore/wicaby-release.jks -storetype PKCS12 -alias wicaby \
  -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Wicaby"
```

In CI, the keystore and its passwords come from encrypted GitHub secrets:

- `KEYSTORE_BASE64`: the `.jks` file, base64-encoded;
- `KEYSTORE_PASSWORD`;
- `KEY_ALIAS`;
- `KEY_PASSWORD`.

The release workflow decodes the keystore into `apps/android/keystore/wicaby-release.jks` and writes `apps/android/keystore.properties` from the other three, before `assembleRelease`. See [release.md](release.md).

Debug and release builds share the applicationIds but not the signing key. Uninstall one (`adb uninstall com.wika.wicaby.tv`) before installing the other.

## In-app updater (sideloaded APKs)

Neither app is on a store, so both update themselves from a manifest. The logic lives in `core/update/Updates.kt`; `UpdateLogicTest` covers the pure rules.

### How it works

1. **Settings.** On TV, Settings → About → "Update URL". On mobile, Settings → About. The field holds the address of an `update.json`. Empty means the default, `UpdateLogic.DEFAULT_URL`: `https://github.com/WicaebethTheo/wicaby/releases/latest/download/update.json`. GitHub answers it with https redirects (to the tag's asset, then its download host), which the updater follows; a redirect to http is refused in release builds. Relative APK URLs resolve against the URL typed (or the default), not the redirect target, so bare file names point at `…/releases/latest/download/<file>`.
2. **Check.** Each app calls `Updater.init("tv" | "mobile", versionCode, versionName)` at start. `checkAtStart()` runs at most once every 6 hours and stays silent unless there is an update. "Check for Updates" forces a check. The manifest is fetched with `Cache-Control: no-cache` through `Core.http`, so the mesh transport applies too.
3. **Newer?** The app reads its own entry (`tv` or `mobile`). `versionCode` decides. If the manifest has no `versionCode`, `versionName` is compared by numeric parts; a leading `v` and suffixes such as `-beta` or `+meta` are ignored.
4. **ABI choice.** The app takes the APK for `Build.SUPPORTED_ABIS[0]`, else `universal`, else any other ABI the device runs. URLs may be relative to the manifest URL.
5. **Offer.** The TV shows a dialog and the phone a card, with the notes in the app language (falling back to `en`, then `fr`, then any language), and the buttons "Update" and "Later".
6. **Install.**
   - **Permission:** Android 8+ needs "Install unknown apps" allowed for Wicaby. The UI offers "Open Settings", which tries `ACTION_MANAGE_UNKNOWN_APP_SOURCES`, then the security settings, then the settings root.
   - **Download:** the APK goes to `cacheDir/updates/Wicaby-<app>-<versionCode>-<abi>.apk` through a `.part` file. A cached copy whose hash matches is reused.
   - **Check:** the SHA-256 must match, or the download fails with "Corrupted file".
   - **Install:** the file is committed to a `PackageInstaller` session. The result comes back to `UpdateReceiver` (declared in `:core`'s manifest, not exported), and the system confirmation dialog is launched from there. If the user declines, the offer comes back.

The `REQUEST_INSTALL_PACKAGES` permission is declared in `:core`'s manifest.

### `update.json` format

```json
{
  "tv": {
    "versionCode": 6,
    "versionName": "0.4.0",
    "notes": { "fr": "…", "en": "…" },
    "apks": {
      "armeabi-v7a": { "url": "Wicaby-TV-0.4.0-armv7.apk", "sha256": "<64 hex>" },
      "arm64-v8a":   { "url": "Wicaby-TV-0.4.0-arm64.apk", "sha256": "<64 hex>" },
      "universal":   { "url": "Wicaby-TV-0.4.0-universal.apk", "sha256": "<64 hex>" }
    }
  },
  "mobile": {
    "versionCode": 2,
    "versionName": "0.2.0",
    "notes": { "en": "…" },
    "apks": {
      "armeabi-v7a": { "url": "…", "sha256": "…" },
      "arm64-v8a":   { "url": "…", "sha256": "…" }
    }
  }
}
```

- Keys are app channels (`tv`, `mobile`). `apks` keys are Android ABI names or `universal`.
- Unknown fields are ignored (lenient parser).
- An entry with an empty `url` is skipped.
- An entry without a valid 64-hex `sha256` is refused. The generator always writes one.
- Manifest and APK URLs must be https (debug builds may use http).
- Before installing, the APK's package name, signing certificate and versionCode are checked against the installed app.

### Generating it

`tools/release/make-update-manifest.mjs` builds the manifest from the APKs in `release/tv/` and `release/mobile/` at the repo root:

```sh
node tools/release/make-update-manifest.mjs <base-url> [--flat] [--notes-fr "…"] [--notes-en "…"]
```

- For each app, it takes the newest version among the files matching `Wicaby-<TV|Mobile>-<version>-<armv7|arm64|universal>.apk`. Each one is hashed with SHA-256 and mapped to its ABI (`armv7` → `armeabi-v7a`, `arm64` → `arm64-v8a`).
- `versionCode` comes from `aapt2 dump badging` (the newest build-tools under `ANDROID_HOME` or `ANDROID_SDK_ROOT`). As a fallback, it comes from `apps/android/<module>/build.gradle.kts`, but only when that file's `versionName` matches the APK's.
- URLs are `<base-url><app>/<file>`, or `<base-url><file>` with `--flat` (GitHub Releases assets have no folders). Without a base URL they stay relative.
- Notes, in order of precedence:
  1. `release/<app>/NOTES.fr.txt` and `NOTES.en.txt` (or `.md`);
  2. `--notes-fr` and `--notes-en`;
  3. the notes already in `release/update.json` for the same `versionCode`.
- The output is `release/update.json`. The script exits with an error when no APK matches.

**Bump `versionCode` and `versionName` in `tv/build.gradle.kts` and `mobile/build.gradle.kts` for every release.** The updater only offers a higher `versionCode`.

## HTTPS servers with a private CA

Both apps trust the system CA store and the CAs the user installed (Android settings → Security → Encryption and credentials → Install a certificate → CA certificate). A server behind a home reverse proxy or a self-hosted PKI therefore works over https once its root CA is installed on the device. Tailscale and NetBird stay on the system store only. The rules are in `tv` and `mobile` `res/xml/network_security_config.xml`; cleartext http is unchanged.

## Comic reader

Both apps read CBZ books (Emby/Jellyfin `Book` items) with shared logic in `core/comics/`:

| File | Role |
|---|---|
| `Comics.kt` | Backend: fetches the archive once from `/Items/{id}/File` (falling back to `/Download`) through `Core.http` into `cacheDir/comics` (LRU, about 1 GB), opens it, and writes progress back. Unsupported formats (CBR, PDF, EPUB) raise a `ComicException` the reader shows as is. |
| `ComicArchive.kt` | Random access over the ZIP: the central directory is read once and pages are inflated on demand. It handles CP437 names and ComicInfo `Page` indexes ("Deleted" pages are skipped). |
| `ComicPages.kt` | Pure JVM rules mirrored from the desktop (`apps/desktop/src/main/comics/`). Natural page order. Komga-style spreads: the cover, the last page and wide pages stand alone. Long-strip detection (ComicInfo `Format=Web`, or a median height/width above 2.5). ComicInfo parsing (manga = right to left). Progress ticks. |
| `ComicReader.kt` | Observed state of one open book: page window decoding (2 pages each side on TV, 3 on mobile), downsampling sized for a ×2 zoom, thumbnails, direction and mode. |

Progress is stored in `PlaybackPositionTicks` as `page × 10 000`, the jellyfin-web comics convention, so clients resume each other's position. It goes through `UserData` (`/UserItems/{id}/UserData` on Jellyfin 10.9+, the per-user route otherwise) and never through `Sessions/Playing`: the server would mark a runtime-less item played and reset it.

The screens are `tv/…/reader/ReaderActivity.kt` (D-pad: spreads on 16:9, ←/→ turn, OK opens the bar) and `mobile/…/reader/ReaderActivity.kt` (swipe, pinch and double-tap zoom, two-page spreads on landscape tablets, vertical strip for webtoons). The unit tests run against `core/src/test/resources/comics/fixture.cbz`.

## i18n

French is the default resource locale (`res/values/`) and English the translation (`res/values-en/`), in every module that has strings: `:core`, `:mesh-ui`, `:livetv-ui`, `:tv` and `:mobile`. The rules:

- Both folders carry the same `string`, `plurals` and `string-array` keys with the same format arguments. `TranslationsTest` (in `:core`, covering `:core`, `:tv`, `:mobile` and `:livetv-ui`) and `StringsParityTest` (in `:mobile`, covering `:mobile`, `:mesh-ui` and `:livetv-ui`) enforce this, and lint's `MissingTranslation` is an error.
- Strings that `:core` hands to the UIs (errors, update messages) live in `:core`'s resources, through `Core.str(...)`.
- **In-app language** (System, Français, English):
  - Both apps declare `res/xml/locales_config.xml` (`fr`, `en`).
  - On API 33+ the choice goes through the system `LocaleManager`, which also lists it in the system settings.
  - Below 33 it is stored in the app's preferences, applied with `AppCompatDelegate.setApplicationLocales` and in each activity's `attachBaseContext`. See `tv/…/data/AppLanguage.kt` and `mobile/…/Lang.kt`.
- `:mobile` sets `androidResources.localeFilters = ["fr", "en"]` and disables language splits in bundles, so a language switch never lacks resources.

## Testing on emulators

The Android emulator images are x86_64. The release AAR only contains ARM code, so build the mesh library with the emulator ABI before testing remote access:

```sh
powershell -File packages/mesh/scripts/build-mesh-aar.ps1 -Emulator   # adds x86_64
bash packages/mesh/scripts/build-mesh-aar.sh --emulator              # same on Linux/macOS
```

- **TV:** use an Android TV image (API 36, `android-tv/x86_64`) and install the **universal** TV APK, which carries the x86_64 libraries. The per-ABI APKs only contain ARM code. Recent x86_64 images can translate ARM code, but the universal APK avoids depending on that.
- **Phone:** use a Google APIs image (API 36, `google_apis/x86_64`). `:mobile` has no universal APK.
- **Mock server:** never point an emulator at a real server or TV. Use `node tools/mock-server/mock-emby.mjs 8104 [video.mkv]` (or `mock-jellyfin.mjs`), with user `Wika` and password `wicaby`. From the emulator, the host is `10.0.2.2`, so type `10.0.2.2:8104` on the setup screen.
  - Use a video **without an audio track**: every stream URL serves that file.
  - The mock draws its artwork as SVG, so only debug builds (which bundle `coil-svg`) show it.
- **Useful commands:**

  ```sh
  adb install -r tv/build/outputs/apk/debug/tv-universal-debug.apk
  adb shell am start -n com.wika.wicaby.tv/.MainActivity
  adb shell am start -a android.intent.action.VIEW -d wicaby://play/<itemId> -n com.wika.wicaby.tv/.MainActivity
  adb shell am start -n com.wika.wicaby.tv/.MainActivity --es previewPlayer <itemId>   # debug: OSD without media
  adb shell am start -n com.wika.wicaby/com.wika.wicaby.mobile.MainActivity
  adb exec-out screencap -p > shot.png
  ```

- **Mesh smoke test:** `packages/mesh/android/sample` brings a real node up to the sign-in step on an emulator, without signing in. See [mesh.md](mesh.md#testing).
- **Real TVs:** follow "Install on a TV" in [`apps/android/README.md`](../apps/android/README.md). Enable network debugging, `adb connect <tv-ip>:5555`, then `adb install -r`. Test builds should not go to a TV someone actually uses.

## Licences

- `media3-ffmpeg-decoder` is **GPL-3.0**, so distributed APKs fall under the GPL. This is one reason Wicaby is GPL-3.0.
- `ass-media` is MIT (libass is ISC), Geist is SIL OFL 1.1 (`core/src/main/assets/OFL-Geist.txt`) and ZXing is Apache-2.0.
- In the mesh AAR, the Tailscale and NetBird client code is BSD-3; every linked module's licence is in `vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt`. The build guard keeps it free of (A/L)GPL code (see [mesh.md](mesh.md#the-agpl-guard)).
