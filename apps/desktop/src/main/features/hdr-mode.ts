import fs from 'node:fs';
import path from 'node:path';
import { screen, type Rectangle } from 'electron';
import { logger } from '../core/log';
import { isDisplayDevice, markerDevices, parseHdrReply, psQuote, type HdrReply } from '../playback/hdr';
import { runPowerShell } from './display-mode';

const log = logger.scope('hdr-mode');

// Windows HDR on/off through user32!DisplayConfigGetDeviceInfo/SetDeviceInfo, compiled
// on demand by PowerShell's Add-Type like display-mode.ts (no native addon).
// Windows 11 24H2 split HDR from Advanced Color: GET_ADVANCED_COLOR_INFO_2 (15) and
// SET_HDR_STATE (16) are tried first; older builds reject them, then 9/10 are used.
// Output: "<state|keep|set|dry|fail> <\\.\DISPLAYn> <hdr supported 0/1> <hdr on 0/1>".
const SCRIPT = String.raw`
param([string]$Device, [int]$X, [int]$Y, [string]$Action, [int]$DryRun)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class WicabyHdr {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH {
    public LUID srcAdapter; public uint srcId; public uint srcMode; public uint srcFlags;
    public LUID tgtAdapter; public uint tgtId; public uint tgtMode; public int tech; public int rotation; public int scaling;
    public uint rateNum; public uint rateDen; public int scanline; public int available; public uint tgtFlags;
    public uint flags;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HEADER { public int type; public int size; public LUID adapter; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct SOURCE_NAME {
    public HEADER h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string gdi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct COLOR { public HEADER h; public uint bits; public int encoding; public int bpc; public int mode; }
  [StructLayout(LayoutKind.Sequential)] public struct SETSTATE { public HEADER h; public uint bits; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DEVMODE {
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public int l, t, r, b; public int wl, wt, wr, wb; public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, [Out] PATH[] paths, ref uint nm, IntPtr modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME req);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref COLOR req);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref SETSTATE req);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX info);

  static HEADER Head(int type, int size, LUID adapter, uint id) {
    HEADER h = new HEADER(); h.type = type; h.size = size; h.adapter = adapter; h.id = id; return h;
  }

  public static string DeviceAt(int x, int y) {
    POINT pt = new POINT(); pt.x = x; pt.y = y;
    MONITORINFOEX mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
    GetMonitorInfo(MonitorFromPoint(pt, 2), ref mi);
    return mi.szDevice;
  }

  static int Rate(string device) {
    DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return EnumDisplaySettings(device, -1, ref dm) ? dm.dmDisplayFrequency : 0;
  }

  public static string Run(string device, string action, bool dry) {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return "fail " + device + " 0 0";
    PATH[] paths = new PATH[np];
    IntPtr modes = Marshal.AllocHGlobal((int)Math.Max(nm, 1) * 64);
    try {
      int q = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero);
      if (q != 0) return "fail " + device + " 0 0";
    } finally { Marshal.FreeHGlobal(modes); }
    for (int i = 0; i < np; i++) {
      SOURCE_NAME sn = new SOURCE_NAME(); sn.h = Head(1, Marshal.SizeOf(typeof(SOURCE_NAME)), paths[i].srcAdapter, paths[i].srcId);
      if (DisplayConfigGetDeviceInfo(ref sn) != 0 || !string.Equals(sn.gdi, device, StringComparison.OrdinalIgnoreCase)) continue;
      LUID a = paths[i].tgtAdapter; uint id = paths[i].tgtId;
      COLOR c = new COLOR(); c.h = Head(15, 36, a, id);
      bool v2 = DisplayConfigGetDeviceInfo(ref c) == 0;
      if (!v2) { c = new COLOR(); c.h = Head(9, 32, a, id); if (DisplayConfigGetDeviceInfo(ref c) != 0) return "fail " + device + " 0 0"; }
      // v2: bit4 highDynamicRangeSupported, bit5 highDynamicRangeUserEnabled.
      // v1: bit0 advancedColorSupported, bit1 enabled, bit2 wideColorEnforced (SDR panel), bit3 forceDisabled.
      bool supported = v2 ? (c.bits & 0x10) != 0 : (c.bits & 1) != 0 && (c.bits & 0xC) == 0;
      bool on = v2 ? (c.bits & 0x20) != 0 : (c.bits & 2) != 0;
      string tail = " " + device + " " + (supported ? 1 : 0) + " " + (on ? 1 : 0);
      if (action == "query") return "state" + tail;
      bool want = action == "on";
      if (!supported || on == want) return "keep" + tail;
      if (dry) return "dry" + tail;
      int before = Rate(device);
      SETSTATE s = new SETSTATE(); s.h = Head(v2 ? 16 : 10, 24, a, id); s.bits = want ? 1u : 0u;
      int r = DisplayConfigSetDeviceInfo(ref s);
      if (r != 0) return "fail" + tail;
      // Kodi does the same: the HDR toggle may pick another refresh rate, put the previous one back.
      Thread.Sleep(500);
      if (before > 0 && Rate(device) != before) {
        DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (EnumDisplaySettings(device, -1, ref dm)) { dm.dmDisplayFrequency = before; dm.dmFields = 0x400000; ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0, IntPtr.Zero); }
      }
      return "set " + device + " 1 " + (want ? 1 : 0);
    }
    return "fail " + device + " 0 0";
  }
}
"@
if (-not $Device) { $Device = [WicabyHdr]::DeviceAt($X, $Y) }
Write-Output ([WicabyHdr]::Run($Device, $Action, $DryRun -gt 0))
`;

// WICABY_HDR_DRYRUN=1 reports what would be switched without touching the display.
const DRY = process.env.WICABY_HDR_DRYRUN === '1';

export class HdrModeSwitcher {
  private readonly marker: string;
  // Every display Wicaby turned HDR on for, until it is turned back off.
  private readonly enabledOn = new Set<string>();
  // A stop during enableFor waits for it, so the display it switches is switched back.
  private pending: Promise<boolean> = Promise.resolve(false);

  constructor(userData: string) {
    // Restore token: survives a crash so the next start can turn HDR back off.
    this.marker = path.join(userData, 'hdr-restore.json');
  }

  private async run(args: string[]): Promise<HdrReply | null> {
    if (process.platform !== 'win32') return null;
    try {
      const out = await runPowerShell(SCRIPT, [...args, `-DryRun ${DRY ? 1 : 0}`]);
      const reply = parseHdrReply(out);
      if (!reply) log.warn(`unexpected reply: ${out}`);
      return reply;
    } catch (err) {
      log.warn('HDR helper failed', err);
      return null;
    }
  }

  private saveMarker(): void {
    try {
      if (this.enabledOn.size) fs.writeFileSync(this.marker, JSON.stringify({ devices: [...this.enabledOn] }));
      else fs.rmSync(this.marker, { force: true });
    } catch (err) {
      log.warn('cannot write HDR restore token', err);
    }
  }

  // Turns HDR on for the display under `bounds`. True when the display changed.
  enableFor(bounds: Rectangle): Promise<boolean> {
    this.pending = this.switchOn(bounds).catch((err) => {
      log.warn('HDR switch failed', err);
      return false;
    });
    return this.pending;
  }

  private async switchOn(bounds: Rectangle): Promise<boolean> {
    const c = screen.dipToScreenPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) });
    const r = await this.run([`-X ${Math.trunc(c.x)}`, `-Y ${Math.trunc(c.y)}`, '-Action on']);
    if (!r) return false;
    log.info(`enable: ${r.verb} ${r.device} supported=${r.supported} on=${r.on}`);
    if (r.verb !== 'set') return false;
    if (isDisplayDevice(r.device) && !this.enabledOn.has(r.device)) {
      this.enabledOn.add(r.device);
      this.saveMarker();
    }
    // DXGI reports the new colour space a moment after the mode set; mpv reads it at startup.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return true;
  }

  async restore(): Promise<void> {
    await this.pending;
    if (!this.enabledOn.size) return;
    const devices = [...this.enabledOn];
    this.enabledOn.clear();
    for (const device of devices) {
      // The name goes into a PowerShell command line: only \\.\DISPLAYn, quoted.
      if (!isDisplayDevice(device)) {
        log.warn('refusing to restore an unexpected display name');
        continue;
      }
      const r = await this.run([`-Device ${psQuote(device)}`, '-Action off']);
      log.info(`restore: ${r ? `${r.verb} ${r.device}` : 'failed'}`);
      // Kept (and in the token) when the helper failed: the next stop or start tries again.
      if (!r || r.verb === 'fail') this.enabledOn.add(device);
    }
    this.saveMarker();
  }

  // A token left by a crash means HDR is still on because of Wicaby.
  async restoreAfterCrash(): Promise<void> {
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
    } catch {
      return;
    }
    for (const device of markerDevices(doc)) this.enabledOn.add(device);
    if (this.enabledOn.size) await this.restore();
    else this.saveMarker();
  }
}
