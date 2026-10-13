# Builds vendor/android/wicaby-mesh.aar: the gomobile binding of packages/mesh/mobile
# (Tailscale tsnet + NetBird client/embed, userspace) for the Android apps, plus
# the licence texts of everything linked into it.
#
# Usage: npm run build:mesh-aar, or
#        powershell -File packages/mesh/scripts/build-mesh-aar.ps1 [-Emulator] [-TailscaleOnly]
#   default         arm64-v8a + armeabi-v7a (release: phones, TVs, 32-bit TV sticks)
#   -Emulator       adds x86_64 for emulators (debug / smoke tests only)
#   -TailscaleOnly  leaves NetBird out (~47 -> ~18 MB per ABI); choosing NetBird in
#                   the app then reports "NetBird is not included in this build"
# Needs: Go, JDK 17+, Android SDK with an NDK (sdkmanager --install "ndk/28.2.13676358").
# gomobile + gobind must match golang.org/x/mobile in go.mod (now
# v0.0.0-20261011034528-197770444867); the script installs that version when needed:
#   go install golang.org/x/mobile/cmd/gomobile@<version> golang.org/x/mobile/cmd/gobind@<version>
#   gomobile init

param([switch]$Emulator, [switch]$TailscaleOnly)

# Tailscale features Wicaby's node needs; every other tsnet subsystem is compiled out
# with ts_omit_* tags (tailscale.com/cmd/featuretags resolves their dependencies).
# Kept: userspace netstack, direct UDP + NAT traversal + port mapping (else everything
# relays over DERP), MagicDNS, health, baked-in CA roots, Tailnet Lock (needed to join
# a locked tailnet), system HTTP proxies, the IPN bus (tsnet sign-in), ACE, and the
# netmap cache (faster reconnects). serve and acme only because tsnet's own API
# (ListenService, ListenTLS) references them; Wicaby never turns them on. Gone: SSH,
# Taildrop, exit nodes and subnet routes, Drive, AWS/Kube/cloud, CLI, posture, log
# upload to log.tailscale.com, ...
$tsKeep = 'netstack,udptransport,nattraversal,portmapper,dns,health,bakedroots,tailnetlock,useproxy,ipnbus,ace,cachenetmap,serve,acme'

# Writes one AAR from the per-ABI ones: everything from the first, jni/ from all.
# A fresh archive: .NET's in-place Update mode leaves local headers that disagree
# with gomobile's data-descriptor entries, which Gradle's AAR extractor rejects.
function Write-Aar([string[]]$parts, [string]$out) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  if (Test-Path $out) { Remove-Item -Force $out }
  $fs = [IO.File]::Open($out, 'CreateNew')
  $dst = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $first = $true
    foreach ($p in $parts) {
      $src = [IO.Compression.ZipFile]::OpenRead($p)
      try {
        foreach ($e in $src.Entries) {
          if ($e.FullName -eq 'AndroidManifest.xml') { continue }
          if (-not $first -and $e.FullName -notlike 'jni/*') { continue }
          if ($e.FullName.EndsWith('/')) { if ($first) { [void]$dst.CreateEntry($e.FullName) }; continue }
          $in = $e.Open(); $o = $dst.CreateEntry($e.FullName, [IO.Compression.CompressionLevel]::Optimal).Open()
          try { $in.CopyTo($o) } finally { $o.Dispose(); $in.Dispose() }
        }
      } finally { $src.Dispose() }
      $first = $false
    }
    # The native code targets API 26 (-androidapi), but the apps go down to 23 and
    # only load it on 26+ (MeshTransport.supported). Declaring 21 here spares every
    # app manifest a tools:overrideLibrary.
    $w = New-Object IO.StreamWriter($dst.CreateEntry('AndroidManifest.xml').Open())
    try { $w.Write('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="go.mobile.gojni"><uses-sdk android:minSdkVersion="21"/></manifest>') } finally { $w.Dispose() }
  } finally { $dst.Dispose(); $fs.Dispose() }
}

$ErrorActionPreference = 'Stop'

# packages/mesh/scripts -> packages/mesh (Go module) and the repo root (vendor/).
$src = Split-Path -Parent $PSScriptRoot
$root = (Resolve-Path (Join-Path $src '..\..')).Path
$target = Join-Path $root 'vendor\android'
$aar = Join-Path $target 'wicaby-mesh.aar'

function First-Existing([string[]]$paths) { foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }; return $null }

$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = First-Existing @('C:\Program Files\Go\bin\go.exe') }
if (-not $go) { throw 'Go not found. Install it with: winget install -e --id GoLang.Go' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = First-Existing @($env:ANDROID_SDK_ROOT, 'C:\Android\Sdk', (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) }
if (-not $env:ANDROID_HOME) { throw 'Android SDK not found (set ANDROID_HOME)' }
if (-not $env:ANDROID_NDK_HOME) {
  $ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Name } | Select-Object -Last 1
  if (-not $ndk) { throw 'No NDK: sdkmanager --install "ndk/28.2.13676358"' }
  $env:ANDROID_NDK_HOME = $ndk.FullName
}
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = (Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue | Select-Object -Last 1).FullName }
if (-not $env:JAVA_HOME) { throw 'JDK not found (set JAVA_HOME)' }
$gobin = Join-Path $env:USERPROFILE 'go\bin'
$env:PATH = "$env:JAVA_HOME\bin;$(Split-Path $go);$gobin;$env:PATH"

# gomobile and gobind are pinned to the golang.org/x/mobile version in go.mod (the one
# its `tool` directive uses), so every machine binds with the same code. Installed into
# ~/go/bin, with gomobile init, when missing or built from another version.
$xmobile = (& $go -C $src list -m -f '{{.Version}}' golang.org/x/mobile)
if ($LASTEXITCODE -ne 0 -or -not $xmobile) { throw 'golang.org/x/mobile not found in packages/mesh/go.mod' }
$xmobile = $xmobile.Trim()
function Test-XMobile([string]$exe) {
  if (-not (Test-Path $exe)) { return $false }
  $info = & $go version -m $exe
  return [bool]($info | Where-Object { $_ -match "^\s+mod\s+golang\.org/x/mobile\s+$([regex]::Escape($xmobile))(\s|$)" })
}
$gomobile = Join-Path $gobin 'gomobile.exe'
if (-not ((Test-XMobile $gomobile) -and (Test-XMobile (Join-Path $gobin 'gobind.exe')))) {
  Write-Host "Installing gomobile and gobind $xmobile"
  $env:GOBIN = $gobin
  try { & $go install "golang.org/x/mobile/cmd/gomobile@$xmobile" "golang.org/x/mobile/cmd/gobind@$xmobile" } finally { Remove-Item Env:GOBIN }
  if ($LASTEXITCODE -ne 0) { throw "go install golang.org/x/mobile/cmd/{gomobile,gobind}@$xmobile failed" }
  & $gomobile init
  if ($LASTEXITCODE -ne 0) { throw 'gomobile init failed' }
}

# arm64 = phones and most TVs, arm = 32-bit TV sticks (Fire TV, Chromecast HD),
# amd64 = emulators only.
$targets = 'android/arm64,android/arm'
if ($Emulator) { $targets += ',android/amd64' }

Push-Location $src
try {
  Write-Host 'Testing the forwarder allow-list'
  & $go test ./mesh/
  if ($LASTEXITCODE -ne 0) { throw 'go test failed' }

  New-Item -ItemType Directory -Force -Path $target | Out-Null

  # NetBird's embed client runs its engine with an empty MobileDependency, and on
  # GOOS=android the engine calls DnsReadyListener.OnReady() unchecked: a nil
  # interface panic that would kill the app. Everything else on that path is
  # nil-safe in netstack mode (no VpnService, no socket protection). Go overlays
  # cannot touch GOMODCACHE, so the bind runs on a scratch copy of this module
  # whose go.mod replaces NetBird with a patched copy (the AGPL check below
  # covers what gets linked). Fail loudly if a NetBird upgrade moves the patched call.
  $work = Join-Path $env:TEMP "wicaby-mesh-aar-$PID"
  if (Test-Path $work) { Remove-Item -Recurse -Force $work }
  $nbSrc = (& $go list -m -f '{{.Dir}}' github.com/netbirdio/netbird).Trim()
  $nbDst = Join-Path $work 'netbird'
  & robocopy $nbSrc $nbDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'copying NetBird failed' }
  Get-ChildItem -Recurse -File $nbDst | ForEach-Object { $_.IsReadOnly = $false }
  $engine = Join-Path $nbDst 'client\internal\engine.go'
  $code = [IO.File]::ReadAllText($engine)
  $anchor = 'go e.mobileDep.DnsReadyListener.OnReady()'
  if (([regex]::Matches($code, [regex]::Escape($anchor))).Count -ne 1) { throw "NetBird patch anchor not found in $engine; re-check the Android nil-listener patch" }
  [IO.File]::WriteAllText($engine, $code.Replace($anchor, 'if l := e.mobileDep.DnsReadyListener; l != nil { go l.OnReady() }'))
  # encryption/ also holds the management server's Let's Encrypt helpers, which drag
  # certmagic, libdns/route53 and the whole AWS SDK into the client. Nothing in
  # client/ calls them; if that ever changes, the build fails here instead of linking.
  Remove-Item (Join-Path $nbDst 'encryption\letsencrypt.go'), (Join-Path $nbDst 'encryption\route53.go'), (Join-Path $nbDst 'encryption\route53_test.go')
  $tags = (& $go run tailscale.com/cmd/featuretags --min "--add=$tsKeep").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $tags) { throw 'tailscale.com/cmd/featuretags failed' }
  if ($TailscaleOnly) { $tags += ',wicaby_no_netbird' }
  $mod = Join-Path $work 'vpn-helper'
  New-Item -ItemType Directory -Path $mod | Out-Null
  Copy-Item (Join-Path $src 'go.mod'), (Join-Path $src 'go.sum') $mod
  Copy-Item -Recurse (Join-Path $src 'mesh'), (Join-Path $src 'mobile') $mod
  Push-Location $mod
  try {
    & $go mod edit -replace "github.com/netbirdio/netbird=$nbDst"
    Write-Host "Building $aar ($targets, NDK $(Split-Path -Leaf $env:ANDROID_NDK_HOME))"
    # -checklinkname=0: github.com/wlynxg/anet (NetBird's Android interface lister)
    # links to net internals; NetBird's own Android build sets the same flag.
    # One ABI per gomobile run (it builds all targets at once, which needs more
    # RAM than a busy PC has), then the jni/ libraries are merged into one AAR.
    if (-not $env:GOFLAGS) { $env:GOFLAGS = '-p=2' }
    $parts = @()
    foreach ($t in $targets -split ',') {
      $part = Join-Path $work ("mesh-" + ($t -replace '.*/', '') + ".aar")
      Write-Host "  $t"
      & $gomobile bind "-target=$t" -androidapi 26 -javapkg com.wika.wicaby.mesh -trimpath -tags $tags `
        -ldflags '-s -w -checklinkname=0' -o $part ./mobile
      if ($LASTEXITCODE -ne 0) { throw "gomobile bind failed for $t" }
      $parts += $part
    }
    Write-Aar $parts $aar

    # Licences: the exact build graph (patched NetBird, same tags), as in build-vpn-helper.mjs.
    $env:GOOS = 'android'; $env:GOARCH = 'arm64'; $env:CGO_ENABLED = '1'
    try {
      $fmt = '{{with .Module}}{{if .Replace}}{{.Path}} {{.Version}}|{{.Replace.Dir}}{{else}}{{.Path}} {{.Version}}|{{.Dir}}{{end}}{{end}}'
      $mods = & $go list -tags $tags -deps -f $fmt ./mobile | Where-Object { $_ -and -not $_.StartsWith('wicaby/') } | Sort-Object -Unique
      if ($LASTEXITCODE -ne 0) { throw 'go list failed for ./mobile' }
      # List first, filter second: a failing `go list` must stop the build, not read as "no hits".
      $deps = & $go list -tags $tags -deps ./mobile
      if ($LASTEXITCODE -ne 0 -or -not $deps) { throw 'go list returned no packages for ./mobile' }
      $nb = $deps | Select-String -Pattern 'github.com/netbirdio/netbird/(management|signal|relay|combined)(/|$)'
    } finally { Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED }
  } finally { Pop-Location }
  # NetBird keeps AGPL code in management/, signal/, relay/ and combined/; none may be linked here.
  if ($nb) { throw "AGPL NetBird packages linked: $($nb -join ', ')" }
  $goroot = (& $go env GOROOT).Trim()
  $out = New-Object System.Text.StringBuilder
  [void]$out.AppendLine("wicaby-mesh.aar is built from packages/mesh (Wicaby) and the following open source components.`r`n")
  [void]$out.AppendLine("==== Go standard library $((& $go env GOVERSION).Trim())`r`n")
  [void]$out.AppendLine((Get-Content -Raw -Encoding UTF8 (Join-Path $goroot 'LICENSE')))
  $missing = @()
  foreach ($m in $mods) {
    $name, $dir = $m -split '\|', 2
    $files = @()
    if ($dir -and (Test-Path $dir)) { $files = Get-ChildItem -Path $dir -File | Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|NOTICE|PATENTS)' } }
    if (-not $files) { $missing += $name; continue }
    [void]$out.AppendLine("==== $name`r`n")
    foreach ($f in $files) {
      $text = Get-Content -Raw -Encoding UTF8 $f.FullName
      $head = $text.Substring(0, [Math]::Min(400, $text.Length))
      if ($name -notlike 'github.com/netbirdio/netbird *' -and $head -match 'GNU (Affero |Lesser )?General Public License') { throw "$name is (A/L)GPL licensed" }
      [void]$out.AppendLine($text)
    }
  }
  Set-Content -Path (Join-Path $target 'wicaby-mesh-THIRD_PARTY_LICENSES.txt') -Value $out.ToString() -Encoding utf8
  if ($missing) { Write-Warning "No licence file found for: $($missing -join ', ')" }
  Remove-Item -Recurse -Force $work

  # Per-ABI size of the native library inside the AAR.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($aar)
  try {
    foreach ($e in $zip.Entries | Where-Object { $_.FullName -like 'jni/*' }) {
      Write-Host ("  {0,-32} {1,6:N1} MB ({2:N1} MB compressed)" -f $e.FullName, ($e.Length / 1MB), ($e.CompressedLength / 1MB))
    }
  } finally { $zip.Dispose() }
  Write-Host ("OK: $aar ({0:N1} MB), $($mods.Count) modules, no AGPL NetBird package" -f ((Get-Item $aar).Length / 1MB))
}
finally {
  Pop-Location
}
