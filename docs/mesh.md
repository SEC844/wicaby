# Mesh helper (`packages/mesh`)

Wicaby can reach a media server that is only on the user's **Tailscale** or **NetBird** network, with no VPN app installed and no admin rights. It does this with its own userspace node on that network, written in Go. The same Go code ships in two forms:

| Form | Built by | Used by | Lands in |
|---|---|---|---|
| `wicaby-mesh.exe` (Linux: `wicaby-mesh`), a stdio helper process | `npm run build:mesh` (`packages/mesh/scripts/build-vpn-helper.mjs`) | Desktop (`apps/desktop/src/main/vpn/embedded-mesh.ts`) | `vendor/vpn-helper/` → `resources/vpn-helper/` in the installer |
| `wicaby-mesh.aar`, a gomobile binding | `npm run build:mesh-aar` (`packages/mesh/scripts/build-mesh-aar.ps1`), or `build-mesh-aar.sh` on Linux/macOS and CI | Android `:core` (`core/mesh/MeshTransport.kt`) | `vendor/android/` (resolved by `apps/android/settings.gradle.kts`) |

`vendor/` sits at the repo root and is not in git.

## Layout

```
packages/mesh/
├─ go.mod                 module wicaby/vpn-helper (historic name), pins NetBird, tailscale.com, Go toolchain
├─ mesh/                  platform-neutral package shared by both forms
│  ├─ node.go             Node, Config, Status/Peer types, the status hub
│  ├─ forward.go          loopback forwarders + mesh allow-list
│  ├─ forward_test.go     allow-list, Location rewriting, end-to-end forwarder tests
│  ├─ tailscale.go        provider: tailscale.com/tsnet
│  ├─ netbird.go          provider: github.com/netbirdio/netbird/client/embed (build tag !wicaby_no_netbird)
│  ├─ netbird_off.go      stub when built with -tags wicaby_no_netbird
│  └─ netif_android.go    Android interface lister for tsnet (GOOS=android only)
├─ cmd/wicaby-mesh/       the Windows helper: JSON lines on stdin/stdout
├─ mobile/                the gomobile face (strings, ints, callbacks only)
├─ android/sample/        throwaway emulator smoke test (not part of the product build)
└─ scripts/               build-vpn-helper.mjs (desktop helper), build-mesh-aar.ps1 (AAR, Windows),
                          build-mesh-aar.sh (AAR, bash port for Linux/macOS and CI)
```

## Design

### One node, two providers

`mesh.New(Config)` builds a `Node` for `Provider` `"tailscale"` or `"netbird"`:

- `Dir` is the state directory. It holds the node key, so it must stay private to the app.
- `Hostname` is the node's name on the mesh. Both apps use `wicaby-<device name>` as a DNS label, at most 63 characters (`wicaby-<pc>` on Windows, `wicaby-<device>` on Android).
- `ControlURL` is a Headscale URL (Tailscale) or a self-hosted NetBird management URL. Empty means the hosted service; for NetBird that is `https://api.netbird.io:443`.

Each provider implements `run`, `dial`, `logout` and `close`, and pushes a `Status` into a hub. The hub drops unchanged statuses (it compares the JSON), so callers only see real changes.

**Tailscale (`tsnet.Server`).**

- The auth key is set on `tsnet.Server.AuthKey`; tsnet ignores it once the node has state.
- The status is polled from the local client every 2 s.
- `BackendState` maps to `connected`, `needs-login` or `connecting`. `NeedsMachineAuth` becomes `needs-login` with the error "waiting for approval by the tailnet admin".
- Mullvad exit nodes (`*.mullvad.ts.net`) are dropped from the peer list, and peers are sorted, so the order stays stable.
- `logout` calls `LocalClient().Logout`.

**NetBird (`client/embed`).**

- Login order: a setup key if one was given; otherwise the peer key saved in `<dir>/config.json` at first registration. If that key is refused (permission denied, unauthenticated, not found, expired login), or there is no key at all, the node runs the OAuth device authorization flow (RFC 8628) against the IdP the management server advertises. It shows `authUrl` (the `verification_uri_complete` when available) and `userCode`, then polls the token endpoint and registers with the resulting JWT.
- `BlockInbound: true`: Wicaby only dials out, and nobody on the mesh needs to reach the device.
- The status is polled every 3 s from the embed client. A management error shows up in `error` while the state stays `connected`.
- `logout` stops the client, deregisters the peer on the management server, then deletes `config.json` and `state.json`.
- NetBird's userspace stack has no DNS, so peers are always dialled by IP (see the allow-list below).

### Per-server loopback forwarders with a token

The node never exposes a proxy, a SOCKS port or a TUN device. The app asks for one **forwarder per server origin**:

```
Forward("http://100.64.1.2:8096")  ->  "http://127.0.0.1:50123/9f86d081884c7d659a2feaa0c55ad015"
```

- One loopback listener (`127.0.0.1:0`) serves every forwarder. Each origin gets a random 128-bit token (32 hex characters), and the token is the first path segment. Asking twice for the same origin returns the same base.
- Requests whose `Host` header is not exactly `127.0.0.1:<port>` get a 403. This blocks DNS-rebound web pages. Without the token, another local process cannot use the listener as a way into the mesh.
- The **allow-list** (`meshView`) is rebuilt from every status. A forwarder can only be opened for a host that is a current peer, either by IP or by its DNS name (the name is mapped to the peer's first IPv4 address). The check runs again on every dial and on every request, because pooled connections skip the dialer. Both userspace dialers would otherwise send any other destination straight out through the host network. A refused origin gets `destination is not a peer of this mesh`.
- The reverse proxy passes the path and query byte for byte and streams with `FlushInterval: -1` (media and long polls). It rewrites `Location` headers that point at the upstream back onto the forwarder.

The apps keep the stored server address unchanged and only rewrite URLs at the edge:

- **Desktop:** `EmbeddedMesh` registers `setAddressRoute({ ensure, rewrite })` with `connection/api-client.ts`. Everything that goes through it is covered: `net.fetch`, `wicaby-media://`, the WebSocket and the URLs handed to mpv. `ensureRoute` only asks for a forwarder when the host is a peer of the connected node. It accepts a reply only if it matches `^http://127\.0\.0\.1:\d+/[0-9a-f]+$`. Wanted origins are reopened after a helper restart.
- **Android:** `MeshTransport` is `Core.transport`. `TransportInterceptor` (in `core/net/ServerTransport.kt`) calls `forward(origin)` for every OkHttp request, so the API, Coil, ExoPlayer (`OkHttpDataSource`) and downloads all follow. Origins the node refused are cached until the peer list changes.

### Auth keys only on stdin

A Tailscale auth key or a NetBird setup key is optional; without one the user signs in through a browser or a QR code. Keys never travel in `argv` or the environment, where other processes can read them:

- **Desktop** (NetBird setup key only; the desktop UI takes no Tailscale auth key): the key is kept in the DPAPI vault (`vault.bin`, entry `mesh-auth-key`) and sent in the `start` command on stdin at each helper launch (restarts included) until the node first reports `connected`. It is then deleted from the vault, because the node key is the credential from then on.
- **Android:** the key goes straight to `Mobile.start(..., authKey, ...)` and is never stored.

### The JSON-lines protocol (`cmd/wicaby-mesh`)

```
wicaby-mesh.exe --provider tailscale|netbird --dir <state dir> --hostname <name>
                [--control-url <url>] [--verbose]
```

Commands go to stdin, events come out on stdout, and diagnostics go to stderr, one JSON object per line. Unknown commands are ignored. A line that is not JSON is reported on stderr. Invalid flags (unknown provider, missing `--dir` or `--hostname`) exit with code 2.

| stdin | stdout reply |
|---|---|
| `{"cmd":"start","authKey":"…"}` (`authKey` optional; only the first `start` counts) | the current `status` |
| `{"cmd":"forward","id":1,"upstream":"http://100.64.1.2:8096"}` | `{"type":"forward","id":1,"base":"http://127.0.0.1:50123/<token>"}`, plus `"error"` when refused |
| `{"cmd":"logout"}` (20 s timeout) | `{"type":"logout","error":""}` |

Status events are also pushed on every change:

```json
{"type":"status","state":"needs-login","authUrl":"https://login.tailscale.com/a/…","ips":[],"peers":[]}
{"type":"status","state":"connected","selfName":"wicaby-salon","selfDnsName":"wicaby-salon.tail1234.ts.net",
 "ips":["100.101.102.103"],"dnsSuffix":"tail1234.ts.net",
 "peers":[{"name":"nas","dnsName":"nas.tail1234.ts.net","ips":["100.64.1.2","fd7a:115c:a1e0::2"],"online":true,"os":"linux"}]}
```

- `state` is one of `connecting`, `needs-login`, `connected` or `error`.
- `userCode` is set during the NetBird device flow.
- `ips` and `peers` are always arrays.

When stdin closes (Wicaby quit or crashed), the helper shuts the node down. On the desktop side, `EmbeddedMesh`:

- closes stdin to stop the helper, and kills it 3 s later as a backstop;
- restarts a crashed helper after 1, 2, 5, 10, 30, then 60 s (the counter resets after a minute of uptime or a successful connection);
- passes stderr to the Wicaby log with URLs and `user_code=` values redacted.

Its state lives in `<userData>/mesh/`: `wicaby.json` (enabled, provider, management URL) and one state directory per provider.

### The gomobile face (`mobile/`)

Only strings, ints, booleans, errors and callback interfaces cross the boundary. The Java package is `com.wika.wicaby.mesh.mobile.Mobile`:

| Function | Notes |
|---|---|
| `Start(provider, stateDir, hostname, managementURL, authKey, listener)` | One node per process. It points `TS_LOGS_DIR` and `TMPDIR` at app-private folders next to `stateDir`, because an app process has no `$HOME` and tsnet's log policy panics with nowhere to write. |
| `Status()`, `Peers()` | JSON, same shapes as above. Without a node: `{"type":"status","state":"stopped",…}`. |
| `Forward(upstream)`, `OpenForwarder(host, port, https)` | Same allow-list as the helper. |
| `Logout()`, `Stop()` | |
| `SetLogger(logger, verbose)` | Lines reach the `Logger` callback with sign-in links and `user_code=` redacted (stderr goes nowhere on Android). |

On Android, `MeshTransport` keeps its state in `filesDir/mesh/`:

- `wicaby.json` holds the preferences;
- `<provider>/` holds the node key;
- `logs/` and `tmp/` are the folders `Start` creates.

All start, stop and sign-out calls run on one worker thread, and status callbacks from a stopped run are dropped. Below API 26 it reports `Unsupported` and never loads the native library. The node runs on Go threads inside the app process. There is no foreground service: a media session or a download service keeps the process alive in the background, and `resume()` reconnects when the app comes back.

`netif_android.go` registers an interface getter for tsnet based on `github.com/wlynxg/anet`. Android 11+ denies the netlink dump behind `net.Interfaces`, which tsnet's network monitor, netcheck and magicsock need.

### Log upload opt-out

A media client has no business sending diagnostics to a VPN vendor:

- `newTailscale` sets `TS_NO_LOGS_NO_SUPPORT=true` before tsnet starts, so tsnet uploads nothing to `log.tailscale.com`. This holds for both the Windows helper and the AAR.
- The AAR is also built with `ts_omit_*` feature tags (see below), which compile log upload out entirely.
- tsnet's own logs are discarded unless `--verbose` (Windows) or a debug build (Android). Only `UserLogf` lines are kept.
- NetBird logs go to the same writer at level `error` (`info` with verbose). They are only written locally: the helper's stderr (Wicaby's own log on Windows) or the `Logger` callback (logcat on Android).

## Building

### Desktop helper (Windows, Linux)

```sh
npm run build:mesh                                   # for this machine
GOOS=linux GOARCH=amd64 npm run build:mesh           # cross-compile (go test is skipped)
node packages/mesh/scripts/build-vpn-helper.mjs --out <dir>   # another folder than vendor/vpn-helper
```

`build-vpn-helper.mjs` needs Go (`winget install -e --id GoLang.Go`, or the distribution's `golang` package). `go.mod` pins the toolchain, and Go downloads it if the installed one is older. GOOS and GOARCH are read from the environment like any `go` command. The script:

1. runs `go test ./mesh/` (the forwarder allow-list) when building for the machine it runs on;
2. builds `vendor/vpn-helper/wicaby-mesh.exe` (`wicaby-mesh` for a non-Windows GOOS) with `CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' ./cmd/wicaby-mesh` (both providers, no feature tags);
3. writes `vendor/vpn-helper/THIRD_PARTY_LICENSES.txt` (CRLF and UTF-8 BOM for Windows, byte for byte what the former `build-vpn-helper.ps1` wrote) with the Go standard library licence and every linked module's `LICENSE`/`COPYING`/`NOTICE`/`PATENTS` files;
4. runs the AGPL guard (below).

`apps/desktop/electron-builder.yml` copies `vendor/vpn-helper` to `resources/vpn-helper`. In development, `locateMeshHelper` also finds `vendor/vpn-helper/wicaby-mesh.exe` (Linux: `wicaby-mesh`) from `apps/desktop`. Without the helper, the embedded node reports `not-installed` and the UI offers only the installed Tailscale or NetBird clients.

### Android AAR

There are two equivalent scripts. `build-mesh-aar.ps1` is the Windows one, behind `npm run build:mesh-aar`. `build-mesh-aar.sh` is its bash port for Linux, macOS and CI (`ci.yml` and `release.yml` run it on `ubuntu-latest`). They take the same options and must stay in step: a change to one (tags, patch, ABIs, guard, licence collection) goes into the other in the same commit.

```sh
# Windows
npm run build:mesh-aar                                                     # arm64-v8a + armeabi-v7a (release)
powershell -File packages/mesh/scripts/build-mesh-aar.ps1 -Emulator        # adds x86_64 for emulators
powershell -File packages/mesh/scripts/build-mesh-aar.ps1 -TailscaleOnly   # no NetBird

# Linux / macOS / CI
bash packages/mesh/scripts/build-mesh-aar.sh                               # arm64-v8a + armeabi-v7a (release)
bash packages/mesh/scripts/build-mesh-aar.sh --emulator                    # adds x86_64 for emulators
bash packages/mesh/scripts/build-mesh-aar.sh --tailscale-only              # no NetBird
```

Both need:

- Go and JDK 17+;
- the Android SDK with an NDK (`sdkmanager --install "ndk/28.2.13676358"`). The scripts use `ANDROID_NDK_HOME` if set; otherwise the bash script tries `ANDROID_NDK_LATEST_HOME` (set on GitHub's runners), and both fall back to the newest NDK under `$ANDROID_HOME/ndk`;
- gomobile and gobind at the `golang.org/x/mobile` version pinned in `packages/mesh/go.mod`. `build-mesh-aar.ps1` installs that version into `~/go/bin` itself when they are missing or built from another version. For the bash script, put them on `PATH` first, as CI does. Skip `gomobile init`: `gomobile bind` does not need it, and it would replace the pinned gobind with `gobind@latest`, which the bash script refuses.

```sh
cd packages/mesh
v=$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install golang.org/x/mobile/cmd/gomobile@$v golang.org/x/mobile/cmd/gobind@$v
```

- for the bash script only: `perl` (applies the patch), `zip` and `unzip` (merge the per-ABI AARs). GitHub's ubuntu runners have all three. The PowerShell script uses `robocopy` to copy the NetBird module.

The scripts work in a scratch copy (`%TEMP%\wicaby-mesh-aar-<pid>`, or a `mktemp -d` directory for the bash script):

1. `go test ./mesh/`.
2. Copy the NetBird module from the module cache and apply the **Android patch** (next section). Delete `encryption/letsencrypt.go`, `route53.go` and `route53_test.go`: they are management-server helpers that would drag certmagic, libdns and the AWS SDK into the client. If client code ever calls them, the build fails instead of linking them.
3. Compute the build tags with `go run tailscale.com/cmd/featuretags --min --add=netstack,udptransport,nattraversal,portmapper,dns,health,bakedroots,tailnetlock,useproxy,ipnbus,ace,cachenetmap,serve,acme`. Everything else in tsnet is compiled out (SSH, Taildrop, exit nodes and subnet routes, Drive, cloud integrations, CLI, posture, log upload…). `serve` and `acme` stay only because tsnet's API references them. `-TailscaleOnly` / `--tailscale-only` adds `wicaby_no_netbird`.
4. Point a copy of `go.mod` at the patched NetBird (`go mod edit -replace`), then run one `gomobile bind` per ABI (`-target=android/arm64`, `android/arm`, plus `android/amd64` with `-Emulator` / `--emulator`). The flags are `-androidapi 26 -javapkg com.wika.wicaby.mesh -trimpath -ldflags '-s -w -checklinkname=0'`, with `GOFLAGS=-p=2` unless set. One ABI at a time keeps the memory use down. `-checklinkname=0` is needed by `wlynxg/anet`, as in NetBird's own Android build.
5. Merge the per-ABI AARs into `vendor/android/wicaby-mesh.aar`: everything from the first part, `jni/` from all of them. The archive gets a fresh manifest declaring `minSdkVersion 21`. The native code targets API 26, and the apps only load it on 26+ (`MeshTransport.supported`). Declaring 21 saves the apps a `tools:overrideLibrary`.
6. Write `vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt` from the exact build graph (`GOOS=android GOARCH=arm64`, same tags), run the AGPL guard, and print the per-ABI size of `libgojni.so`.

With NetBird, the native library is several tens of MB per ABI; `-TailscaleOnly` cuts it by about 30 MB. This is why both Android apps build one APK per ABI (see [android.md](android.md)).

`apps/android/core/consumer-rules.pro` keeps `go.**` and `com.wika.wicaby.mesh.**`, because `libgojni` calls back into them by name over JNI.

### The NetBird Android patch

NetBird's embed client runs its engine with an empty `MobileDependency`. On `GOOS=android`, the engine calls `DnsReadyListener.OnReady()` without a nil check, and the resulting nil-interface panic would kill the app. Everything else on that path is nil-safe in netstack mode (no `VpnService`, no socket protection). Go overlays cannot touch `GOMODCACHE`, so the script patches its scratch copy of `client/internal/engine.go`:

```go
go e.mobileDep.DnsReadyListener.OnReady()
// becomes
if l := e.mobileDep.DnsReadyListener; l != nil { go l.OnReady() }
```

The anchor must occur exactly once. When a NetBird upgrade moves or changes that line, the script stops with `NetBird patch anchor not found … re-check the Android nil-listener patch`. Re-read `engine.go` in the new version and update the anchor (or drop the patch if upstream fixed it). The Windows helper does not need the patch.

### The AGPL guard

NetBird keeps AGPL code in `management/`, `signal/`, `relay/` and `combined/`. The Tailscale and NetBird client code Wicaby embeds is BSD-3; the other linked modules are under various licences (BSD, MIT, Apache-2.0, possibly MPL-2.0), each recorded in the `THIRD_PARTY_LICENSES.txt` written next to the binary. All three build scripts, and the `AGPL guard` step of `ci.yml`, enforce this:

- `go list -deps` of the target (`./cmd/wicaby-mesh`, or `./mobile` with the AAR's tags) must not contain any `github.com/netbirdio/netbird/(management|signal|relay|combined)` package. Otherwise: `AGPL NetBird packages linked: …`.
- While collecting licences, any module other than NetBird whose licence title says GNU GPL, AGPL or LGPL stops the build (`<module> is (A/L)GPL licensed`). Only the first 400 characters are checked, because the MPL-2.0 text mentions the GPL in its body.
- A module without a licence file only raises a warning.

The guard keeps the mesh binaries free of NetBird server code and of any (A/L)GPL code, whatever the licence of the apps that embed them. MPL-2.0 modules are let through on purpose.

## Testing

- `go test ./mesh/` in `packages/mesh` covers the allow-list, `Location` rewriting and a full forwarder against a fake dialer. Every build script runs it first.
- `node tools/checks/mesh-selfcheck.mjs` (part of `npm run checks`) drives `embedded-mesh.ts` routing with hand-fed helper messages, without the helper.
- `node tools/checks/vpn-selfcheck.mjs` covers the parsers for the installed Tailscale and NetBird CLIs.
- `packages/mesh/android/sample` is an emulator-only smoke test. It brings a real node up to the sign-in step, never completes a login, and checks that non-peers are refused (`10.0.2.2`, an unowned `100.x`, the internet). It needs the `-Emulator` (or `--emulator`) AAR. Run it from the repo root:

  ```sh
  apps\android\gradlew.bat -p packages\mesh\android\sample :app:connectedDebugAndroidTest
  ```

## Upgrading

1. In `packages/mesh`, run `go get -u ./... && go mod tidy`.
2. `go.mod` repeats NetBird's own `replace` directives (wireguard-go, pion/ice, circl, service, easyjson, dex), because a dependency's replaces are not inherited. Copy them again from the new NetBird `go.mod`.
3. Rebuild both forms. The patch anchor and the AGPL guard re-verify themselves.
