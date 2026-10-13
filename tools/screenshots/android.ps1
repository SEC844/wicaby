<#
.SYNOPSIS
  Captures the Android README screenshots on emulators, against the demo mock server.

.DESCRIPTION
  Writes to docs/screenshots/ (optimised palette PNGs, the names README.md expects):
    tv-home.png        Android TV home (French UI)
    tv-detail.png      Android TV detail: Big Buck Bunny, "2 versions", Dolby Vision badges, Version picker
    tv-detail-en.png   Android TV detail in English: Charge (Dolby Vision)
    mobile-home.png    phone home (French UI)
    mobile-player.png  phone player, paused, controls shown (Coffee Run)
    tv-livetv-guide.png Android TV Live TV guide grid (IPTV mock lineup)
    mobile-livetv.png  phone Live TV, Guide tab

  What it does:
    1. builds the debug APKs if they are missing (or with -Build);
    2. boots two read-only emulators (AVDs wicaby_tv and wicaby_phone, no window, no audio)
       unless they are already running on the given ports;
    3. renders a silent still-image video (Coffee Run backdrop) for the player shot, with Electron;
    4. starts tools/mock-server/mock-emby.mjs with MOCK_DATASET=demo and MOCK_LIVETV=iptv (French, then
       English) on -Port;
    5. signs in as Wika / wicaby at 10.0.2.2:<Port>, walks to each screen and runs
       `adb exec-out screencap -p`;
    6. downscales and palette-quantises the captures (no external tool), then stops the mock and the
       emulators it started.

  Nothing here talks to a real server or device: only the emulators and the local mock.
  The debug APKs carry arm64/armv7 native code only for the mesh library; the x86_64 Android 16
  images run them through their ARM translation, so no extra build variant is needed.

.EXAMPLE
  pwsh tools/screenshots/android.ps1
.EXAMPLE
  powershell -File tools/screenshots/android.ps1 -Build -KeepEmulators
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [int]$Port = 8900,
  [string]$TvAvd = 'wicaby_tv',
  [string]$PhoneAvd = 'wicaby_phone',
  [int]$TvPort = 5620,
  [int]$PhonePort = 5622,
  [switch]$Build,
  [switch]$KeepEmulators
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $Root 'docs\screenshots' }
$Sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'), 'C:\Android\Sdk') |
  Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools\adb.exe')) } | Select-Object -First 1
if (-not $Sdk) { throw 'Android SDK not found: set ANDROID_HOME' }
$AdbExe = Join-Path $Sdk 'platform-tools\adb.exe'
$EmuExe = Join-Path $Sdk 'emulator\emulator.exe'
$Tv = "emulator-$TvPort"
$Phone = "emulator-$PhonePort"
$Work = Join-Path ([IO.Path]::GetTempPath()) "wicaby-android-shots-$PID"
$Raw = Join-Path $Work 'raw'
New-Item -ItemType Directory -Force -Path $Raw, $OutDir | Out-Null
$Started = @()
$Mock = $null

# Per-language labels the script taps (they come from the apps' strings.xml and the demo dataset).
$L = @{
  fr = @{ Films = 'Films'; Home = 'Accueil'; Libraries = "Biblioth$([char]0xE8)ques"; Play = 'Lire'; Continue = 'Continuer'; LiveTv = 'TV en direct'; Guide = 'Guide' }
  en = @{ Films = 'Movies'; Home = 'Home'; Libraries = 'Libraries'; Play = 'Play'; Continue = 'Continue Watching'; LiveTv = 'TV en direct'; Guide = 'Guide' }
}

# --- helpers ---------------------------------------------------------------------------------

function Adb([string]$Serial) { & $AdbExe -s $Serial @args }
function Sh([string]$Serial, [string]$Cmd) { & $AdbExe -s $Serial shell $Cmd }
function Pause-For([double]$Seconds) { Start-Sleep -Milliseconds ([int]($Seconds * 1000)) }

function Wait-Boot([string]$Serial, [int]$Timeout = 420) {
  $ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns adb's stderr into a terminating error under 'Stop'
  $deadline = (Get-Date).AddSeconds($Timeout)
  while ((Get-Date) -lt $deadline) {
    $v = (& $AdbExe -s $Serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($v -eq '1') { return }
    Pause-For 3
  }
  throw "$Serial did not boot in $Timeout s"
}

function Start-Emulator([string]$Avd, [int]$EmuPort) {
  $ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns adb's stderr into a terminating error under 'Stop'
  $serial = "emulator-$EmuPort"
  $state = (& $AdbExe -s $serial get-state 2>$null | Out-String).Trim()
  if ($state -eq 'device') { Write-Host "$serial already running"; return }
  Write-Host "Starting $Avd on $serial (read-only, no window, no audio, software GPU)"
  Start-Process -FilePath $EmuExe -WindowStyle Hidden -ArgumentList @('-avd', $Avd, '-read-only', '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-port', $EmuPort) | Out-Null
  $script:Started += $serial
}

# UI nodes from uiautomator (Compose exposes its text and content descriptions).
function Get-Nodes([string]$Serial) {
  $ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns adb's stderr into a terminating error under 'Stop'
  & $AdbExe -s $Serial shell uiautomator dump /sdcard/wicaby-ui.xml 2>$null | Out-Null
  $xml = (& $AdbExe -s $Serial exec-out cat /sdcard/wicaby-ui.xml | Out-String)
  foreach ($m in [regex]::Matches($xml, '<node [^>]*>')) {
    $n = $m.Value
    $b = [regex]::Match($n, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if (-not $b.Success) { continue }
    [pscustomobject]@{
      Text  = [Net.WebUtility]::HtmlDecode([regex]::Match($n, ' text="([^"]*)"').Groups[1].Value)
      Desc  = [Net.WebUtility]::HtmlDecode([regex]::Match($n, 'content-desc="([^"]*)"').Groups[1].Value)
      Class = [regex]::Match($n, 'class="([^"]*)"').Groups[1].Value
      X     = [int](([int]$b.Groups[1].Value + [int]$b.Groups[3].Value) / 2)
      Y     = [int](([int]$b.Groups[2].Value + [int]$b.Groups[4].Value) / 2)
    }
  }
}

function Find-Node([string]$Serial, [scriptblock]$Match, [string]$What, [int]$Timeout = 30) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  while ((Get-Date) -lt $deadline) {
    $node = Get-Nodes $Serial | Where-Object $Match | Select-Object -First 1
    if ($node) { return $node }
    Pause-For 1
  }
  throw "$Serial`: '$What' not found on screen"
}

function Tap([string]$Serial, [int]$X, [int]$Y) { Sh $Serial "input tap $X $Y" | Out-Null }
function Tap-Text([string]$Serial, [string]$Text, [int]$Timeout = 30, [int]$DY = 0) {
  $n = Find-Node $Serial { $_.Text -eq $Text -or $_.Desc -eq $Text } $Text $Timeout
  Tap $Serial $n.X ($n.Y + $DY)
}
# Also matches a longer label that starts with the text ("Continuer" / "Continuer a regarder").
function Wait-Text([string]$Serial, [string]$Text, [int]$Timeout = 30) { Find-Node $Serial { $_.Text -eq $Text -or $_.Text -like "$Text *" } $Text $Timeout | Out-Null }
function Type-Into-Field([string]$Serial, [string]$Value) {
  $f = Find-Node $Serial { $_.Class -eq 'android.widget.EditText' } 'text field'
  Tap $Serial $f.X $f.Y; Pause-For 1
  Sh $Serial "input text '$Value'" | Out-Null; Pause-For 0.5
  Sh $Serial 'input keyevent 66' | Out-Null   # IME action: connect / sign in
}

function Shot([string]$Serial, [string]$Name) {
  $file = Join-Path $Raw "$Name.png"
  # cmd's redirection keeps the PNG bytes intact (Windows PowerShell's '>' would re-encode them).
  cmd /c "`"$AdbExe`" -s $Serial exec-out screencap -p > `"$file`""
  if ((Get-Item $file).Length -lt 10000) { throw "screencap of $Name failed" }
  Write-Host "captured $Name"
}

function Start-Mock([string]$Lang, [string]$Video) {
  $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($busy) { throw "port $Port is already in use" }
  $env:MOCK_DATASET = 'demo'; $env:MOCK_DEMO_LANG = $Lang; $env:MOCK_LIVETV = 'iptv'
  $p = Start-Process -FilePath 'node' -WindowStyle Hidden -PassThru `
    -ArgumentList @("`"$(Join-Path $Root 'tools\mock-server\mock-emby.mjs')`"", $Port, "`"$Video`"") `
    -RedirectStandardOutput (Join-Path $Work "mock-$Lang.log") -RedirectStandardError (Join-Path $Work "mock-$Lang.err")
  Remove-Item Env:MOCK_DATASET, Env:MOCK_DEMO_LANG, Env:MOCK_LIVETV
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/emby/System/Info/Public" -TimeoutSec 2 | Out-Null; return $p } catch { Pause-For 0.5 }
  }
  throw 'mock server did not start'
}
function Stop-Mock { if ($script:Mock -and -not $script:Mock.HasExited) { Stop-Process -Id $script:Mock.Id -Force }; $script:Mock = $null }

# Fresh app state, app language, then server -> user -> password. The mock forgets tokens on restart.
function Sign-In([string]$Serial, [string]$Package, [string]$Activity, [string]$Locale) {
  Sh $Serial "pm clear $Package" | Out-Null
  Sh $Serial "cmd locale set-app-locales $Package --locales $Locale" | Out-Null
  Sh $Serial "am start -n $Package/$Activity" | Out-Null
  Pause-For 3
  Type-Into-Field $Serial "10.0.2.2:$Port"
  Tap-Text $Serial 'Wika' -DY -150   # the avatar above the name
  Pause-For 1.5
  Type-Into-Field $Serial 'wicaby'
}

# --- embedded helpers (written to the temp folder) -------------------------------------------

$StillVideo = Join-Path $Work 'still-video.cjs'
$StillVideoJs = @'
// electron still-video.cjs <image.jpg> <out.webm> <recordSeconds> <declaredDurationSeconds>
// Records a silent VP8 WebM of a still image (MediaRecorder), then writes the declared
// duration into Segment/Info so the player's OSD shows the film's real length.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const [img, out, rec, declared] = process.argv.slice(-4);
function vint(buf, pos) {
  const first = buf[pos]; let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let value = first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { len, value };
}
function withDuration(buf, ms) {
  const at = buf.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66])); // Segment/Info
  if (at < 0) throw new Error('no Info element');
  const size = vint(buf, at + 4), bodyStart = at + 4 + size.len, body = buf.subarray(bodyStart, bodyStart + size.value);
  const dur = Buffer.alloc(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; dur.writeDoubleBE(ms, 3); // Duration (ms)
  const newSize = Buffer.alloc(8); newSize[0] = 0x01; newSize.writeUIntBE(body.length + dur.length, 2, 6);
  return Buffer.concat([buf.subarray(0, at + 4), newSize, body, dur, buf.subarray(bodyStart + size.value)]);
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  const b64 = fs.readFileSync(img).toString('base64');
  const data = await win.webContents.executeJavaScript(`(async () => {
    const im = new Image(); im.src = 'data:image/jpeg;base64,${b64}'; await im.decode();
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const g = c.getContext('2d'); const draw = () => g.drawImage(im, 0, 0, 1920, 1080); draw();
    const r = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 12e6 });
    const chunks = []; r.ondataavailable = (e) => chunks.push(e.data);
    const t = setInterval(draw, 1000 / 24); r.start(500);
    await new Promise((ok) => setTimeout(ok, ${Number(rec) * 1000}));
    const stopped = new Promise((ok) => (r.onstop = ok)); r.stop(); await stopped; clearInterval(t);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  fs.writeFileSync(out, withDuration(Buffer.from(data, 'base64'), Number(declared) * 1000));
  app.quit();
});
'@
[IO.File]::WriteAllText($StillVideo, $StillVideoJs, (New-Object Text.UTF8Encoding $false))

$Optimize = Join-Path $Work 'optimize-png.mjs'
$OptimizeJs = @'
// node optimize-png.mjs <in.png> <out.png> <maxWidth> [colours=256]
// Dependency-free: decodes an 8-bit PNG (adb screencap), downscales by area averaging,
// quantises to a palette (median cut + light Floyd-Steinberg) and writes a palette PNG with the
// best per-row filter; keeps truecolour if that happens to be smaller.
import fs from 'node:fs';
import zlib from 'node:zlib';
const [inPath, outPath, maxW, colorsArg] = process.argv.slice(2);
const COLORS = Number(colorsArg ?? 256);
function decode(buf) {
  let pos = 8, w, h, depth, type; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('interlaced'); }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG depth ${depth} type ${type}`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 3), prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    cur.copy(prev);
  }
  return { w, h, px: out };
}
function resize({ w, h, px }, W) {
  if (W >= w) return { w, h, px };
  const H = Math.round((h * W) / w), sx = w / W, sy = h / H, out = Buffer.alloc(W * H * 3);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy, y1 = y0 + sy;
    for (let X = 0; X < W; X++) {
      const x0 = X * sx, x1 = x0 + sx; let r = 0, g = 0, b = 0, t = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0), f = wx * wy, i = (y * w + x) * 3;
          r += px[i] * f; g += px[i + 1] * f; b += px[i + 2] * f; t += f;
        }
      }
      const o = (Y * W + X) * 3; out[o] = Math.round(r / t); out[o + 1] = Math.round(g / t); out[o + 2] = Math.round(b / t);
    }
  }
  return { w: W, h: H, px: out };
}
function medianCut(px, n) {
  const hist = new Map();
  for (let i = 0; i < px.length; i += 3) { const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]; hist.set(k, (hist.get(k) ?? 0) + 1); }
  const boxes = [[...hist.entries()]];
  const range = (box) => { const lo = [255, 255, 255], hi = [0, 0, 0]; for (const [k] of box) { const c = [k >> 16, (k >> 8) & 255, k & 255]; for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], c[j]); hi[j] = Math.max(hi[j], c[j]); } } return hi.map((v, j) => v - lo[j]); };
  const weight = (box) => box.reduce((s, [, c]) => s + c, 0);
  while (boxes.length < n) {
    let best = -1, score = 0;
    boxes.forEach((b, i) => { if (b.length < 2) return; const s = Math.max(...range(b)) * Math.sqrt(weight(b)); if (s > score) { score = s; best = i; } });
    if (best < 0) break;
    const box = boxes[best], r = range(box), shift = [16, 8, 0][r.indexOf(Math.max(...r))];
    box.sort((a, b) => ((a[0] >> shift) & 255) - ((b[0] >> shift) & 255));
    const total = weight(box); let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { acc += box[i][1]; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => { let r = 0, g = 0, b = 0, t = 0; for (const [k, c] of box) { r += (k >> 16) * c; g += ((k >> 8) & 255) * c; b += (k & 255) * c; t += c; } return [Math.round(r / t), Math.round(g / t), Math.round(b / t)]; });
}
function quantize({ w, h, px }, n) {
  const pal = medianCut(px, n), cache = new Int16Array(1 << 18).fill(-1), idx = Buffer.alloc(w * h);
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (cache[key] >= 0) return cache[key];
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b, d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; if (d < bd) { bd = d; best = i; } }
    return (cache[key] = best);
  };
  const err = new Float32Array((w + 2) * 3 * 2);
  for (let y = 0; y < h; y++) {
    const cur = (y & 1) * (w + 2) * 3, nxt = ((y + 1) & 1) * (w + 2) * 3;
    err.fill(0, nxt, nxt + (w + 2) * 3);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, e = cur + (x + 1) * 3, c = [0, 1, 2].map((k) => Math.max(0, Math.min(255, Math.round(px[i + k] + err[e + k] * 0.75))));
      const p = nearest(c[0], c[1], c[2]); idx[y * w + x] = p;
      for (let k = 0; k < 3; k++) {
        const d = c[k] - pal[p][k];
        err[e + 3 + k] += (d * 7) / 16; err[nxt + x * 3 + k] += (d * 3) / 16; err[nxt + (x + 1) * 3 + k] += (d * 5) / 16; err[nxt + (x + 2) * 3 + k] += d / 16;
      }
    }
  }
  return { pal, idx };
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (kind, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
function encode(w, h, rows, bpp, type, plte) {
  const stride = w * bpp, out = Buffer.alloc((stride + 1) * h), prev = Buffer.alloc(stride), tmp = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride); let bestF = 0, bestSum = Infinity, best = null;
    for (let f = 0; f < (bpp === 1 ? 1 : 5); f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let p = 0; if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1; else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[i] - p) & 255; tmp[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; bestF = f; best = Buffer.from(tmp); }
    }
    out[y * (stride + 1)] = bestF; best.copy(out, y * (stride + 1) + 1); row.copy(prev);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = type;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(plte ? [chunk('PLTE', plte)] : []), chunk('IDAT', zlib.deflateSync(out, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const img = resize(decode(fs.readFileSync(inPath)), Number(maxW));
const { pal, idx } = quantize(img, COLORS);
const palette = encode(img.w, img.h, idx, 1, 3, Buffer.from(pal.flat()));
const truecolor = encode(img.w, img.h, img.px, 3, 2);
const best = palette.length < truecolor.length ? palette : truecolor;
fs.writeFileSync(outPath, best);
console.log(`${outPath}: ${img.w}x${img.h}, ${(best.length / 1024).toFixed(0)} KB`);
'@
[IO.File]::WriteAllText($Optimize, $OptimizeJs, (New-Object Text.UTF8Encoding $false))

# --- run -------------------------------------------------------------------------------------

try {
  # 1. APKs
  $TvApk = Join-Path $Root 'apps\android\tv\build\outputs\apk\debug\tv-universal-debug.apk'
  $PhoneApk = Join-Path $Root 'apps\android\mobile\build\outputs\apk\debug\mobile-arm64-v8a-debug.apk'
  if ($Build -or -not (Test-Path $TvApk) -or -not (Test-Path $PhoneApk)) {
    Push-Location (Join-Path $Root 'apps\android')
    try { & .\gradlew.bat :tv:assembleDebug :mobile:assembleDebug; if ($LASTEXITCODE) { throw 'gradle build failed' } } finally { Pop-Location }
  }

  # 2. Emulators (boot while the video renders)
  Start-Emulator $TvAvd $TvPort
  Start-Emulator $PhoneAvd $PhonePort

  # 3. Still video for the player: the Coffee Run backdrop, declared as the film's 3 min 4 s
  $Video = Join-Path $Work 'coffee-run.webm'
  $Electron = Join-Path $Root 'node_modules\.bin\electron.cmd'
  & { $ErrorActionPreference = 'Continue'; & $Electron $StillVideo (Join-Path $Root 'tools\mock-server\demo\coffee-run\backdrop.jpg') $Video 20 184 2>$null | Out-Null }
  if (-not (Test-Path $Video)) { throw 'could not render the still video' }

  Wait-Boot $Tv; Wait-Boot $Phone
  Adb $Tv install -r $TvApk | Out-Null
  Adb $Phone install -r $PhoneApk | Out-Null

  # Clean frames: a 16:9 TV, and the phone's status bar in demo mode (fixed clock, full battery, Wi-Fi only).
  Sh $Tv 'wm size reset' | Out-Null
  Sh $Phone 'settings put global sysui_demo_allowed 1' | Out-Null
  $demo = 'am broadcast -a com.android.systemui.demo -e command'
  foreach ($c in @('enter', 'clock -e hhmm 1030', 'battery -e level 100 -e plugged false', 'network -e wifi show -e level 4 -e fully true',
      'network -e mobile hide', 'notifications -e visible false', 'status -e volume hide -e bluetooth hide -e location hide -e alarm hide')) {
    Sh $Phone "$demo $c" | Out-Null
  }

  # 4-5. French UI and catalogue
  $script:Mock = Start-Mock 'fr' $Video
  $t = $L.fr

  Sign-In $Tv 'com.wika.wicaby.tv' '.MainActivity' 'fr-FR'
  Wait-Text $Tv $t.Continue; Pause-For 4
  Shot $Tv 'tv-home'
  Tap-Text $Tv $t.Films; Pause-For 3
  Tap-Text $Tv 'Big Buck Bunny'
  Wait-Text $Tv 'Version'; Pause-For 4
  Shot $Tv 'tv-detail'
  # Live TV guide: restart the app (still signed in) on its home, then the Live TV tab and its Guide.
  Sh $Tv 'am force-stop com.wika.wicaby.tv' | Out-Null
  Sh $Tv 'am start -n com.wika.wicaby.tv/.MainActivity' | Out-Null
  Wait-Text $Tv $t.Continue; Pause-For 2
  Tap-Text $Tv $t.LiveTv; Pause-For 3
  Tap-Text $Tv $t.Guide; Pause-For 6
  Shot $Tv 'tv-livetv-guide'

  Sign-In $Phone 'com.wika.wicaby' '.mobile.MainActivity' 'fr-FR'
  Wait-Text $Phone $t.Continue; Pause-For 4
  Shot $Phone 'mobile-home'
  Tap-Text $Phone $t.Libraries; Pause-For 2
  Tap-Text $Phone $t.Films; Pause-For 3
  Tap-Text $Phone 'Coffee Run'; Pause-For 3
  Tap-Text $Phone $t.Play
  Pause-For 9                       # plays a few seconds (the video is silent and the emulator has no audio)
  Tap $Phone 1200 300; Pause-For 0.6  # show the controls
  Tap $Phone 1200 540; Pause-For 1    # pause (centre button); the controls stay while paused
  $f = Find-Node $Phone { $_.Desc -like "Format de l*" } 'picture format button'   # the top bar gained buttons (X-02, X-04): find it
  Tap $Phone $f.X $f.Y; Pause-For 3   # picture format: Ajuster -> Remplir l'ecran, wait for its label to fade
  Shot $Phone 'mobile-player'
  Sh $Phone 'input keyevent 4' | Out-Null
  Sh $Phone 'am force-stop com.wika.wicaby' | Out-Null
  Sh $Phone 'am start -n com.wika.wicaby/.mobile.MainActivity' | Out-Null
  Wait-Text $Phone $t.Continue; Pause-For 2
  Tap-Text $Phone $t.Libraries; Pause-For 2
  Tap-Text $Phone $t.LiveTv; Pause-For 3
  Tap-Text $Phone $t.Guide; Pause-For 5
  Shot $Phone 'mobile-livetv'
  Stop-Mock

  # English: one TV detail page
  $script:Mock = Start-Mock 'en' $Video
  $t = $L.en
  Sign-In $Tv 'com.wika.wicaby.tv' '.MainActivity' 'en-US'
  Wait-Text $Tv $t.Continue; Pause-For 2
  Tap-Text $Tv $t.Films; Pause-For 3
  Tap-Text $Tv 'Charge'
  Wait-Text $Tv 'Charge'; Pause-For 4
  Shot $Tv 'tv-detail-en'
  Stop-Mock

  # 6. Optimise into docs/screenshots
  $widths = @{ 'tv-home' = 1280; 'tv-detail' = 1280; 'tv-detail-en' = 1280; 'mobile-home' = 540; 'mobile-player' = 1200; 'tv-livetv-guide' = 1280; 'mobile-livetv' = 540 }
  foreach ($name in $widths.Keys) {
    & node $Optimize (Join-Path $Raw "$name.png") (Join-Path $OutDir "$name.png") $widths[$name]
    if ($LASTEXITCODE) { throw "optimising $name failed" }
  }
}
finally {
  Stop-Mock
  $ErrorActionPreference = 'Continue'
  if (-not $KeepEmulators) {
    foreach ($s in $Started) { & $AdbExe -s $s emu kill 2>$null | Out-Null }
  }
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
