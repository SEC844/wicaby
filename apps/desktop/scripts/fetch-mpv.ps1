# Downloads the pinned Windows build of mpv (shinchiro/mpv-winbuild-cmake) into vendor/mpv
# and checks its SHA-256. electron-builder bundles that folder as resources/mpv, and Wicaby
# also finds it there in development.
#
# Usage: npm run fetch-mpv   (or: powershell -File apps/desktop/scripts/fetch-mpv.ps1 [-Generic])
#   -Generic  take the baseline x86_64 build instead of x86-64-v3 (AVX2), for old CPUs.
#
# To move to a newer build: pick a release on
# https://github.com/shinchiro/mpv-winbuild-cmake/releases, then update the tag, the mpv
# commit (the "git-<hash>" in the asset names) and both SHA-256 values (the "sha256:" digest
# GitHub shows next to each asset). The release workflow reads $MpvTag and $MpvCommit from
# this file for the release notes and the mpv source archive, and THIRD_PARTY_NOTICES.md
# names the same release.

param([switch]$Generic)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$MpvTag = '20261011'
$MpvCommit = 'accb7b2821'
$Sha256 = @{
  'x86_64-v3' = 'e9c8b59884094d3e10d01d76dc869261b66686e4179be2f74df9825f550ae1b3'
  'x86_64'    = 'afdf8a0422510f0dd375196ef406607984d3861cf033fc9e74ed7997c8db4700'
}

# vendor/ sits at the repo root, three levels above apps/desktop/scripts.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$target = Join-Path $root 'vendor\mpv'
$arch = if ($Generic) { 'x86_64' } else { 'x86_64-v3' }
$name = "mpv-$arch-$MpvTag-git-$MpvCommit.7z"
$url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$MpvTag/$name"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("wicaby-mpv-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$archive = Join-Path $tmp $name

try {
  Write-Host "Downloading $url"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -Headers @{ 'User-Agent' = 'wicaby-fetch-mpv' }

  $hash = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash
  if ($hash -ne $Sha256[$arch]) { throw "SHA-256 mismatch for ${name}: got $hash, expected $($Sha256[$arch])" }
  Write-Host "SHA-256 OK: $hash"

  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Path $target | Out-Null

  # Windows 10 1803+ ships bsdtar, which reads 7z archives.
  Write-Host "Extracting to $target"
  & tar.exe -xf $archive -C $target
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE (install 7-Zip and extract $archive manually)" }

  # Some archives wrap everything in a top-level folder.
  if (-not (Test-Path (Join-Path $target 'mpv.exe'))) {
    $inner = Get-ChildItem -Path $target -Recurse -Filter 'mpv.exe' | Select-Object -First 1
    if ($inner) {
      Get-ChildItem -Path $inner.DirectoryName -Force | Move-Item -Destination $target -Force
    }
  }

  $exe = Join-Path $target 'mpv.exe'
  if (-not (Test-Path $exe)) { throw "mpv.exe not found after extraction" }

  $version = (& $exe --no-config --version | Select-Object -First 1)
  Write-Host "OK: $version (shinchiro $MpvTag)"
  Write-Host "mpv installed in $target"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
