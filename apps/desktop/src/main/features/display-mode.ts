import { execFile } from 'node:child_process';
import { screen, type BaseWindow } from 'electron';
import { logger } from '../core/log';
import { locate } from '../vpn/vpn-clients';
import { linuxDisplayTool, matchLinuxRate } from './display-mode-linux';

const log = logger.scope('display-mode');

// Refresh-rate matching through user32!ChangeDisplaySettingsExW. The helper is
// compiled by PowerShell's Add-Type on demand, so Wicaby ships no native addon.
// Emby did the same with QueryDisplayConfig/SetDisplayConfig from C#.
const SCRIPT = String.raw`
param([int]$X, [int]$Y, [double]$Fps, [int]$Restore)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WicabyDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize; public int l, t, r, b; public int wl, wt, wr, wb; public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
}
"@
$pt = New-Object WicabyDisplay+POINT; $pt.x = $X; $pt.y = $Y
$mon = [WicabyDisplay]::MonitorFromPoint($pt, 2)
$mi = New-Object WicabyDisplay+MONITORINFOEX; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
[void][WicabyDisplay]::GetMonitorInfo($mon, [ref]$mi)
$dev = $mi.szDevice
$cur = New-Object WicabyDisplay+DEVMODE; $cur.dmSize = [Runtime.InteropServices.Marshal]::SizeOf($cur)
[void][WicabyDisplay]::EnumDisplaySettings($dev, -1, [ref]$cur)
$target = 0
if ($Restore -gt 0) { $target = $Restore } else {
  $rates = @()
  $i = 0
  $dm = New-Object WicabyDisplay+DEVMODE; $dm.dmSize = $cur.dmSize
  while ([WicabyDisplay]::EnumDisplaySettings($dev, $i, [ref]$dm)) {
    if ($dm.dmPelsWidth -eq $cur.dmPelsWidth -and $dm.dmPelsHeight -eq $cur.dmPelsHeight -and $dm.dmBitsPerPel -eq $cur.dmBitsPerPel) { $rates += $dm.dmDisplayFrequency }
    $i++
  }
  $rates = $rates | Sort-Object -Unique
  # B21: Windows lists the NTSC modes as 23, 29, 47, 59 and 119 Hz; they run at (r+1)/1.001 (23.976,
  # 59.94...). Same rule as pickRate (display-mode-linux.ts): an exact multiple (0.02 Hz) is kept or
  # preferred, so 23.976 fps takes 23 Hz over 24; a near one (0.6 Hz) only replaces a rate that is not near.
  function Eff([int]$r) { if (@(23, 29, 47, 59, 119) -contains $r) { ($r + 1) * 1000 / 1001 } else { [double]$r } }
  function Err([int]$r) { $m = [Math]::Round((Eff $r) / $Fps); if ($m -lt 1) { 1e9 } else { [Math]::Abs((Eff $r) - $Fps * $m) } }
  $curErr = Err $cur.dmDisplayFrequency
  if ($curErr -lt 0.02) { Write-Output "keep $($cur.dmDisplayFrequency)"; exit 0 }
  $tol = if ($curErr -lt 0.6) { 0.02 } else { 0.6 }
  $best = $null; $bestScore = 1e9
  foreach ($r in $rates) {
    $err = Err $r
    if ($err -lt $tol) { $score = $err * 10 - (Eff $r) / 1000; if ($score -lt $bestScore) { $best = $r; $bestScore = $score } }
  }
  if ($null -eq $best) { Write-Output "keep $($cur.dmDisplayFrequency)"; exit 0 }
  $target = $best
}
if ($target -eq $cur.dmDisplayFrequency) { Write-Output "keep $target"; exit 0 }
$prev = $cur.dmDisplayFrequency
$cur.dmDisplayFrequency = $target
$cur.dmFields = 0x400000
$rc = [WicabyDisplay]::ChangeDisplaySettingsEx($dev, [ref]$cur, [IntPtr]::Zero, 0, [IntPtr]::Zero)
if ($rc -ne 0) { Write-Output "fail $rc"; exit 1 }
Write-Output "set $prev $target"
`;

export function runPowerShell(script: string, args: string[]): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // -EncodedCommand cannot take parameters, so the script is wrapped in a scriptblock.
  const wrapper = `& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))) ${args.join(' ')}`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapper],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

export class DisplayModeSwitcher {
  private restore: { x: number; y: number; rate: number } | null = null;
  // Linux: puts the previous mode back (display-mode-linux.ts).
  private undo: (() => Promise<string>) | null = null;
  // A stop during a switch waits for it, so the rate it sets is put back.
  private pending: Promise<void> = Promise.resolve();

  matchContent(win: BaseWindow | null, fps: number | undefined): Promise<void> {
    this.pending = this.switchTo(win, fps).catch((err) => log.warn('refresh rate switch failed', err));
    return this.pending;
  }

  // Settings disables the toggle when false: Windows always, Linux where a tool can switch (display-mode-linux.ts).
  available(): boolean {
    if (process.platform === 'win32') return true;
    const tool = process.platform === 'linux' ? linuxDisplayTool(process.env) : null;
    return tool !== null && locate(tool, []) !== null;
  }

  private async switchTo(win: BaseWindow | null, fps: number | undefined): Promise<void> {
    if (process.platform === 'linux') return this.switchLinux(win, fps);
    if (process.platform !== 'win32' || !win || !fps || fps < 10) return;
    const b = win.getBounds();
    const center = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    try {
      const out = await runPowerShell(SCRIPT, [`-X ${center.x}`, `-Y ${center.y}`, `-Fps ${fps.toFixed(3)}`, '-Restore 0']);
      log.info(`content ${fps} fps: ${out}`);
      const m = /^set (\d+) (\d+)/.exec(out);
      if (m && !this.restore) this.restore = { x: center.x, y: center.y, rate: Number(m[1]) };
    } catch (err) {
      log.warn('refresh rate switch failed', err);
    }
  }

  private async switchLinux(win: BaseWindow | null, fps: number | undefined): Promise<void> {
    const tool = linuxDisplayTool(process.env);
    if (!tool || !win || !fps || fps < 10) return;
    const b = win.getBounds();
    const center = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    const r = await matchLinuxRate(tool, center, fps);
    log.info(`content ${fps} fps (${tool}): ${r.log}`);
    this.undo ??= r.undo;
  }

  async restoreIfChanged(): Promise<void> {
    await this.pending;
    const undo = this.undo;
    this.undo = null;
    if (undo) {
      try {
        log.info(`restored: ${(await undo()).trim() || 'ok'}`);
      } catch (err) {
        log.warn('refresh rate restore failed', err);
      }
    }
    const r = this.restore;
    if (!r) return;
    this.restore = null;
    try {
      const out = await runPowerShell(SCRIPT, [`-X ${r.x}`, `-Y ${r.y}`, '-Fps 0', `-Restore ${r.rate}`]);
      log.info(`restored: ${out}`);
    } catch (err) {
      log.warn('refresh rate restore failed', err);
    }
  }
}
