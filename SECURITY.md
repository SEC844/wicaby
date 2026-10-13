<!--
  MAINTAINER NOTE (staging draft; delete this comment before publishing).
  - Turn on private vulnerability reporting on the public repo before publishing this file
    (plan phase 5): gh api -X PUT repos/WicaebethTheo/wicaby-releases/private-vulnerability-reporting
  - The Android updater text describes the 0.2.0 default (phase 4 code task: default update URL
    = wicaby-releases latest update.json). Until that lands, the URL is empty by default.
  - Recommended code fix: make Updates.kt refuse an APK whose manifest entry has no sha256
    (make-update-manifest.mjs always writes one), then drop "when the manifest lists one" below.
-->

# Security policy

## Supported versions

Wicaby is released as a whole: one tag (`vX.Y.Z`) covers the Windows app, the Android TV app,
the Android mobile app and the mesh helper. Only the **latest release** gets security fixes;
there are no backports.

| Release | Windows | Android TV | Android mobile | Supported |
|---|---|---|---|---|
| 0.2.x (latest) | 0.2.x | 0.2.x | 0.2.x | Yes |
| older | | | | No |

Binaries and the Android `update.json` manifest are published at
`https://github.com/WicaebethTheo/wicaby-releases/releases`. Builds from any other source are not
supported.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through a GitHub security advisory on the public releases repository:
**Security → Report a vulnerability** on
`https://github.com/WicaebethTheo/wicaby-releases/security/advisories/new`.
(The code repository is private, so its own advisory page is not reachable from outside.)

Include:

- the affected app(s) and version (Settings → About);
- the Windows or Android version and device;
- the server type and version (Emby or Jellyfin) when it matters;
- steps to reproduce, and what an attacker gains;
- a proof of concept if you have one. Test only against a server and devices you own, for
  example a throwaway Emby or Jellyfin test server, never someone else's.

What to expect: an acknowledgement within 7 days, an assessment within 30 days, and a fix in
the next release for confirmed issues, with credit in the advisory and the changelog unless you
prefer otherwise. Please keep the report confidential until a fixed release is published.

## Scope

In scope:

- the Windows app (`apps/desktop`): main process, preload, renderer, the `app://` and
  `wicaby-media://` protocols, IPC, the credential vault, deep links (`wicaby://`), the mpv
  integration, downloads, the comic reader, the qBittorrent client and the remote-access
  features;
- the Android apps (`apps/android`): `:core`, `:mesh-ui`, `:tv` and `:mobile`, including token
  storage and the in-app updater;
- the mesh helper (`packages/mesh`): `wicaby-mesh.exe`, the Android AAR and their loopback
  forwarders;
- the release tooling (`tools/release`) and the published `update.json`.

Out of scope (please report these upstream):

- Emby, Jellyfin and qBittorrent servers themselves;
- Electron/Chromium, mpv, FFmpeg, Media3, Tailscale, NetBird and other third-party components,
  unless Wicaby uses them in an unsafe way;
- attacks that need administrator rights or full control of the user's Windows account or
  unlocked Android device;
- the mock servers in `tools/mock-server/`, which are test tools and never ship.

## Security model

Each statement below was checked against the code; the source file is given in brackets, with
paths relative to the app or package folder.

### Windows app

- **Server tokens stay in the main process.** Sign-in, every API call and token storage happen
  in the main process. The renderer talks to it only through a typed IPC bridge exposed by the
  preload with `contextBridge` (`src/preload/index.ts`). The server records shared with the UI
  carry `hasToken: boolean`, not the token (`src/shared/contract.ts`). Images, streams and
  subtitles go through the `wicaby-media://api/<serverId>/…` protocol, whose handler adds the
  auth headers in the main process (`src/main/protocols.ts`). mpv receives the auth header
  through `http-header-fields` over its JSON IPC pipe, not on its command line
  (`src/main/playback/mpv-player.ts`).
- **Credential vault encrypted with DPAPI.** Access tokens, the qBittorrent password and the
  mesh auth key are stored in one file encrypted with Electron `safeStorage`, which uses Windows
  DPAPI and binds it to the Windows user account. When OS encryption is unavailable, credentials
  are kept in memory only and never written in clear (`src/main/core/vault.ts`).
- **Sandboxed renderer.** Every window uses `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false` and `webSecurity: true`; DevTools are off in production builds unless
  `WICABY_DEVTOOLS=1` is set. Navigation to anything but the app origin is blocked, and
  `window.open` is denied (http(s) links open in the default browser)
  (`src/main/windows/window-manager.ts`). Web permissions are limited to fullscreen and
  sanitised clipboard writes (`src/main/index.ts`).
- **Content Security Policy.** The production UI is served from `app://wicaby/` with this
  policy (`src/main/protocols.ts`): `default-src 'self'`; `script-src 'self'` (no inline or
  remote scripts, no `eval`); `style-src 'self' 'unsafe-inline'` (inline styles are allowed);
  `img-src 'self' data: blob: wicaby-media:`; `media-src 'self' blob: data: wicaby-media:`;
  `connect-src 'self' wicaby-media:`; `font-src 'self' data:`; `worker-src 'self' blob:`;
  `frame-src https://www.youtube-nocookie.com` (trailers only); `object-src 'none'`;
  `base-uri 'none'`; `form-action 'none'`; `frame-ancestors 'none'`. The `app://` handler
  refuses paths outside the renderer folder.
- **qBittorrent.** Requests use a separate in-memory session. A certificate that fails
  verification is accepted only after the user trusts its SHA-256 fingerprint for that host
  (`src/main/torrents/torrent-service.ts`).
- **mpv.** Each mpv process gets a named pipe with a random name (`\\.\pipe\wicaby-mpv-<uuid>`)
  (`src/main/playback/mpv-controller.ts`). Extra mpv arguments from the settings go through
  an allow-list (`src/shared/mpv-args.ts`): only `--name=value` picture, scaling, shader,
  subtitle, sync, tone-mapping and audio options get through. Anything that loads scripts or
  config, writes files, talks to a pipe or takes over the embedding (`--script*`, `--include`,
  `--config*`, `--input-*`, `--log-file`, `--dump-*`, `--wid`, `--idle`...) is refused, and
  path values must be local drive paths (no UNC, device or `..`).

Known limitations:

- Emby and Jellyfin may embed the token as a query parameter (`api_key` / `ApiKey`) in the
  `TranscodingUrl` they return. When the built-in HTML player (the fallback when mpv is missing
  or fails) plays a server transcode, that URL is passed through `wicaby-media://` and is
  therefore visible to the renderer.
- The server administration pages (administrators only) display and copy the server's API keys
  on purpose.
- Plain `http://` servers are supported, as on the official clients; use HTTPS or the mesh for
  access over untrusted networks.
- "Use mpv.conf" is a power-user feature: a user `mpv.conf` can set anything, including Lua or
  JavaScript scripts, and only the user should turn it on. A compromised renderer that can
  write settings over IPC could enable it, so a renderer compromise should be treated as code
  execution as the Windows user. Extra mpv arguments are allow-listed (see above) and cannot
  load code on their own.

### Android apps

- Access tokens are encrypted with AES-GCM using a key generated in, and never exported from,
  the Android Keystore before they are written to DataStore
  (`core/src/main/java/com/wika/wicaby/core/data/Prefs.kt`).
- `android:allowBackup="false"` on both apps, so tokens and settings are not copied into
  backups (`tv/src/main/AndroidManifest.xml`, `mobile/src/main/AndroidManifest.xml`).
- Cleartext HTTP is allowed (`usesCleartextTraffic="true"`) because many home servers have no
  HTTPS.
- **In-app updates** are on by default and read
  `https://github.com/WicaebethTheo/wicaby-releases/releases/latest/download/update.json` over
  HTTPS. The user can change the manifest URL in Settings → About, or clear it to turn updates
  off. A downloaded APK is checked against the SHA-256 listed in the manifest when the manifest
  lists one (the published manifests always do), then handed to `PackageInstaller`, which asks
  the user to confirm. Android itself only installs an update signed with the same key as the
  installed app, which is the main guarantee, because the manifest and the APKs come from the
  same place (`core/src/main/java/com/wika/wicaby/core/update/Updates.kt`).

### Mesh helper (`packages/mesh`)

- **Loopback-only forwarders.** Each media server is reached through
  `http://127.0.0.1:<port>/<token>/…`. The listener binds `127.0.0.1` only, and the 128-bit
  random path token keeps other local processes and DNS-rebinding web pages from using it as a
  way into the mesh (`mesh/forward.go`).
- **Peers only.** A forwarder can only be opened for, and only dials, an address that is a
  current peer of the mesh; the peer list is re-checked on every request and every new
  connection, and redirects are kept on the forwarder (`mesh/forward.go`, tested in
  `mesh/forward_test.go`). Nothing else is routed: the node runs in userspace and installs no
  network adapter or routes.
- **Secrets on stdin.** The Windows app drives `wicaby-mesh.exe` with JSON lines on stdin; the
  auth key never appears in its command line or environment (`cmd/wicaby-mesh/main.go`,
  `apps/desktop/src/main/vpn/embedded-mesh.ts`). Closing stdin shuts the node down.
- The node's own state (its machine and node keys) is kept by Tailscale or NetBird in
  `<userData>/mesh/<provider>`, protected by file-system permissions rather than DPAPI.
- **Reduced Tailscale surface on Android.** The AAR is built with Tailscale feature tags that
  compile out SSH, Taildrop, exit nodes, subnet routes and log upload to `log.tailscale.com`
  (`scripts/build-mesh-aar.ps1`).
- **Licence guard.** Both build scripts fail if any AGPL NetBird package (`management/`,
  `signal/`, `relay/`, `combined/`) is linked.

### Repository and releases

- The signing keystore, `keystore.properties`, `local.properties`, the `vendor/` binaries and
  the `.dev/` scratch folder are git-ignored. See [CONTRIBUTING.md](CONTRIBUTING.md).
