#!/usr/bin/env bash
# Builds vendor/android/wicaby-mesh.aar: the gomobile binding of packages/mesh/mobile
# (Tailscale tsnet + NetBird client/embed, userspace) for the Android apps, plus the
# licence texts of everything linked into it. Bash port of build-mesh-aar.ps1 for
# Linux/macOS and CI (GitHub Actions ubuntu runners); both scripts must stay in step.
#
# Usage: packages/mesh/scripts/build-mesh-aar.sh [--emulator] [--tailscale-only]
#   default           arm64-v8a + armeabi-v7a (release: phones, TVs, 32-bit TV sticks)
#   --emulator        adds x86_64 for emulators (debug / smoke tests only)
#   --tailscale-only  leaves NetBird out; choosing NetBird in the app then reports
#                     "NetBird is not included in this build"
# Needs: Go, a JDK 17+, an Android SDK with an NDK (ANDROID_HOME, and ANDROID_NDK_HOME or
# ANDROID_NDK_LATEST_HOME, else the newest $ANDROID_HOME/ndk/*), gomobile + gobind on PATH:
#   v=$(cd packages/mesh && go list -m -f '{{.Version}}' golang.org/x/mobile)
#   go install golang.org/x/mobile/cmd/gomobile@$v golang.org/x/mobile/cmd/gobind@$v
#   gomobile init
# Also uses: perl, zip, unzip (all on GitHub's ubuntu runners).
set -euo pipefail

emulator=0
tailscale_only=0
for arg in "$@"; do
  case "$arg" in
    --emulator) emulator=1 ;;
    --tailscale-only) tailscale_only=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Same Tailscale feature set as build-mesh-aar.ps1 (see the comment there).
ts_keep='netstack,udptransport,nattraversal,portmapper,dns,health,bakedroots,tailnetlock,useproxy,ipnbus,ace,cachenetmap,serve,acme'

die() { echo "error: $*" >&2; exit 1; }

# packages/mesh/scripts -> packages/mesh (Go module) and the repo root (vendor/).
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$src/../.." && pwd)"
target="$root/vendor/android"
aar="$target/wicaby-mesh.aar"

command -v go >/dev/null || die 'Go not found'
command -v gomobile >/dev/null || die 'gomobile not found (go install golang.org/x/mobile/cmd/gomobile@<x/mobile version in go.mod>; gomobile init)'
command -v gobind >/dev/null || die 'gobind not found (go install golang.org/x/mobile/cmd/gobind@<x/mobile version in go.mod>)'
for tool in perl zip unzip; do command -v "$tool" >/dev/null || die "$tool not found"; done
# gomobile and gobind must come from the golang.org/x/mobile version pinned in go.mod
# (as build-mesh-aar.ps1 enforces), so every machine binds with the same code.
xmobile="$(cd "$src" && go list -m -f '{{.Version}}' golang.org/x/mobile)"
[ -n "$xmobile" ] || die 'golang.org/x/mobile not found in packages/mesh/go.mod'
for tool in gomobile gobind; do
  go version -m "$(command -v "$tool")" | grep -qE "^[[:space:]]+mod[[:space:]]+golang\.org/x/mobile[[:space:]]+${xmobile//./\\.}([[:space:]]|$)" \
    || die "$tool is not built from golang.org/x/mobile $xmobile (go install golang.org/x/mobile/cmd/$tool@$xmobile)"
done

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$ANDROID_HOME" ] || die 'Android SDK not found (set ANDROID_HOME)'
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  if [ -n "${ANDROID_NDK_LATEST_HOME:-}" ]; then
    ANDROID_NDK_HOME="$ANDROID_NDK_LATEST_HOME"
  else
    ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort -V | tail -n 1 || true)"
    ANDROID_NDK_HOME="${ANDROID_NDK_HOME%/}"
  fi
fi
[ -n "$ANDROID_NDK_HOME" ] && [ -d "$ANDROID_NDK_HOME" ] || die 'No NDK: sdkmanager --install "ndk/28.2.13676358"'
export ANDROID_NDK_HOME
[ -n "${JAVA_HOME:-}" ] || command -v javac >/dev/null || die 'JDK not found (set JAVA_HOME)'

# arm64 = phones and most TVs, arm = 32-bit TV sticks (Fire TV, Chromecast HD),
# amd64 = emulators only.
targets=(android/arm64 android/arm)
[ "$emulator" = 1 ] && targets+=(android/amd64)

work="$(mktemp -d "${TMPDIR:-/tmp}/wicaby-mesh-aar-XXXXXX")"
trap 'rm -rf "$work"' EXIT

cd "$src"
echo 'Testing the forwarder allow-list'
go test ./mesh/

mkdir -p "$target"

# NetBird's embed client runs its engine with an empty MobileDependency, and on
# GOOS=android the engine calls DnsReadyListener.OnReady() unchecked: a nil interface
# panic that would kill the app. Go overlays cannot touch GOMODCACHE, so the bind runs
# on a scratch copy of this module whose go.mod replaces NetBird with a patched copy.
# Fail loudly if a NetBird upgrade moves the patched call.
nb_src="$(go list -m -f '{{.Dir}}' github.com/netbirdio/netbird)"
[ -n "$nb_src" ] && [ -d "$nb_src" ] || die 'NetBird module not found (go mod download)'
nb_dst="$work/netbird"
cp -R "$nb_src" "$nb_dst"
chmod -R u+w "$nb_dst"
engine="$nb_dst/client/internal/engine.go"
anchor='go e.mobileDep.DnsReadyListener.OnReady()'
# grep -c exits 1 on zero matches; `|| true` keeps set -e from exiting before the message below.
count="$(grep -cF "$anchor" "$engine" || true)"
[ "$count" = 1 ] || die "NetBird patch anchor not found in $engine (found $count); re-check the Android nil-listener patch"
perl -0pi -e 's/\Qgo e.mobileDep.DnsReadyListener.OnReady()\E/if l := e.mobileDep.DnsReadyListener; l != nil { go l.OnReady() }/' "$engine"
# encryption/ also holds the management server's Let's Encrypt helpers (certmagic,
# libdns/route53, the AWS SDK). Nothing in client/ calls them; if that ever changes,
# the build fails here instead of linking. rm without -f: a missing file is an error.
rm "$nb_dst/encryption/letsencrypt.go" "$nb_dst/encryption/route53.go" "$nb_dst/encryption/route53_test.go"

tags="$(go run tailscale.com/cmd/featuretags --min "--add=$ts_keep")"
[ -n "$tags" ] || die 'tailscale.com/cmd/featuretags failed'
[ "$tailscale_only" = 1 ] && tags="$tags,wicaby_no_netbird"

mod="$work/vpn-helper"
mkdir -p "$mod"
cp go.mod go.sum "$mod/"
cp -R mesh mobile "$mod/"
cd "$mod"
go mod edit -replace "github.com/netbirdio/netbird=$nb_dst"

echo "Building $aar (${targets[*]}, NDK $(basename "$ANDROID_NDK_HOME"))"
# -checklinkname=0: github.com/wlynxg/anet (NetBird's Android interface lister) links to
# net internals; NetBird's own Android build sets the same flag. One ABI per gomobile run
# (lower peak RAM), then the jni/ libraries are merged into one AAR.
export GOFLAGS="${GOFLAGS:--p=2}"
parts=()
for t in "${targets[@]}"; do
  part="$work/mesh-${t##*/}.aar"
  echo "  $t"
  gomobile bind "-target=$t" -androidapi 26 -javapkg com.wika.wicaby.mesh -trimpath -tags "$tags" \
    -ldflags '-s -w -checklinkname=0' -o "$part" ./mobile
  parts+=("$part")
done

# Merge: everything from the first AAR, jni/ from all, and a fresh AndroidManifest.xml.
# The native code targets API 26 (-androidapi), but the apps go down to 23 and only load
# it on 26+ (MeshTransport.supported); declaring 21 spares every app a tools:overrideLibrary.
merged="$work/merged"
mkdir -p "$merged"
first=1
for p in "${parts[@]}"; do
  if [ "$first" = 1 ]; then unzip -q -o "$p" -d "$merged"; first=0
  else unzip -q -o "$p" 'jni/*' -d "$merged"; fi
done
printf '%s' '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="go.mobile.gojni"><uses-sdk android:minSdkVersion="21"/></manifest>' > "$merged/AndroidManifest.xml"
rm -f "$aar"
(cd "$merged" && zip -q -r -X -9 "$aar" .)

# Licences: the exact build graph (patched NetBird, same tags), as in build-vpn-helper.mjs.
fmt='{{with .Module}}{{if .Replace}}{{.Path}} {{.Version}}|{{.Replace.Dir}}{{else}}{{.Path}} {{.Version}}|{{.Dir}}{{end}}{{end}}'
mods="$(GOOS=android GOARCH=arm64 CGO_ENABLED=1 go list -tags "$tags" -deps -f "$fmt" ./mobile | grep -v '^wicaby/' | grep -v '^$' | sort -u)"
# NetBird keeps AGPL code in management/, signal/, relay/ and combined/; none may be linked here.
# List first, filter second: a failing `go list` must stop the build, not read as "no hits".
deps="$(GOOS=android GOARCH=arm64 CGO_ENABLED=1 go list -tags "$tags" -deps ./mobile)"
[ -n "$deps" ] || die 'go list returned no packages for ./mobile'
nb="$(printf '%s\n' "$deps" | grep -E 'github\.com/netbirdio/netbird/(management|signal|relay|combined)(/|$)' || true)"
[ -z "$nb" ] || die "AGPL NetBird packages linked: $(echo "$nb" | paste -sd, -)"

goroot="$(go env GOROOT)"
lic="$target/wicaby-mesh-THIRD_PARTY_LICENSES.txt"
missing=()
{
  printf 'wicaby-mesh.aar is built from packages/mesh (Wicaby) and the following open source components.\n\n'
  printf '==== Go standard library %s\n\n' "$(go env GOVERSION)"
  cat "$goroot/LICENSE"
  printf '\n'
  while IFS= read -r m; do
    name="${m%%|*}"; dir="${m#*|}"
    files=()
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      # -i: case-insensitive like the PowerShell -match (License, license.md, Copying, ...).
      while IFS= read -r f; do files+=("$f"); done < <(find "$dir" -maxdepth 1 -type f | grep -iE '/(LICEN[CS]E|COPYING|NOTICE|PATENTS)[^/]*$' | sort)
    fi
    if [ "${#files[@]}" = 0 ]; then missing+=("$name"); continue; fi
    printf '==== %s\n\n' "$name"
    for f in "${files[@]}"; do
      case "$name" in
        'github.com/netbirdio/netbird '*) ;;
        # -i: GPL texts open with "GNU GENERAL PUBLIC LICENSE" (PowerShell -match ignores case too).
        *) if head -c 400 "$f" | grep -qiE 'GNU (Affero |Lesser )?General Public License'; then die "$name is (A/L)GPL licensed"; fi ;;
      esac
      cat "$f"
      printf '\n'
    done
  done <<< "$mods"
} > "$lic"
[ "${#missing[@]}" = 0 ] || echo "warning: no licence file found for: ${missing[*]}" >&2

# Per-ABI size of the native library inside the AAR.
unzip -l "$aar" 'jni/*' | awk 'NR>3 && $4 ~ /^jni\// { printf "  %-32s %6.1f MB\n", $4, $1/1048576 }'
n_mods="$(printf '%s\n' "$mods" | grep -c . || true)"
size="$(du -m "$aar" | cut -f1)"
echo "OK: $aar (${size} MB), $n_mods modules, no AGPL NetBird package"
