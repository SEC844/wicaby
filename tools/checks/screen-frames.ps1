# Screen capture for player-exit-cdp.mjs: grabs a screen rectangle (physical pixels) as fast as GDI allows,
# about one frame every 16-33 ms, and reports per frame the mean luma, the share of near-white and near-black
# pixels and the mean difference from reference captures. Windows only, no dependency (System.Drawing).
#   -Mode single -Out ref.png                  one capture
#   -Mode seq -DurationMs 1500 -Out <dir> [-Refs page.png,desk.png]   prints READY <epoch ms>, then one JSON line per frame
#   -Mode backdrop                              an orange (255,128,0) borderless window, never activated, until killed:
#                                               put behind the app, any frame with orange in it shows what is behind
param([string]$Mode = 'seq', [int]$X, [int]$Y, [int]$W, [int]$H, [int]$DurationMs = 1500, [int]$IntervalMs = 16, [string]$Out, [string]$Refs = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class Backdrop : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}

public static class ScreenFrames {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long ft);
  static double Now() { long ft; GetSystemTimePreciseAsFileTime(out ft); return (ft - 116444736000000000L) / 10000.0; }

  public static void Dpi() { SetProcessDPIAware(); }

  static Bitmap Grab(int x, int y, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
    return b;
  }

  // Every 4th pixel of every 4th row, as RGB bytes.
  static byte[] Sample(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var row = new byte[d.Stride];
    var list = new List<byte>();
    for (int y = 0; y < b.Height; y += 4) {
      Marshal.Copy(d.Scan0 + y * d.Stride, row, 0, d.Stride);
      for (int x = 0; x < b.Width; x += 4) { list.Add(row[x * 4 + 2]); list.Add(row[x * 4 + 1]); list.Add(row[x * 4]); }
    }
    b.UnlockBits(d);
    return list.ToArray();
  }

  static void Save(Bitmap b, string file, int div) {
    using (var s = new Bitmap(b.Width / div, b.Height / div)) {
      using (var g = Graphics.FromImage(s)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(b, 0, 0, s.Width, s.Height); }
      s.Save(file, ImageFormat.Png);
    }
  }

  public static void Single(int x, int y, int w, int h, string file) {
    SetProcessDPIAware();
    using (var b = Grab(x, y, w, h)) b.Save(file, ImageFormat.Png);
  }

  public static void Seq(int x, int y, int w, int h, int dur, int every, string dir, string refs) {
    SetProcessDPIAware();
    timeBeginPeriod(1);
    var refSamples = new List<byte[]>();
    foreach (var r in refs.Split(',')) if (r.Length > 0) using (var b = new Bitmap(r)) refSamples.Add(Sample(b));
    var frames = new List<Bitmap>();
    var times = new List<double>();
    Grab(x, y, w, h).Dispose(); // warm up GDI
    var sw = Stopwatch.StartNew();
    Console.WriteLine("READY " + Now().ToString("F1", CultureInfo.InvariantCulture));
    Console.Out.Flush();
    double next = 0;
    while (sw.Elapsed.TotalMilliseconds < dur) {
      times.Add(Now());
      frames.Add(Grab(x, y, w, h));
      next += every;
      double wait = next - sw.Elapsed.TotalMilliseconds;
      if (wait >= 1) Thread.Sleep((int)wait); else next = sw.Elapsed.TotalMilliseconds;
    }
    for (int i = 0; i < frames.Count; i++) {
      var s = Sample(frames[i]);
      double luma = 0; int white = 0, black = 0, key = 0, n = s.Length / 3;
      for (int p = 0; p < s.Length; p += 3) {
        double l = 0.2126 * s[p] + 0.7152 * s[p + 1] + 0.0722 * s[p + 2];
        luma += l; if (l > 235) white++; if (l < 14) black++;
        // The backdrop's orange, even dimmed by a veil: G about half of R, next to no blue.
        if (s[p] > 40 && s[p + 1] > s[p] * 0.35 && s[p + 1] < s[p] * 0.65 && s[p + 2] < s[p] * 0.15) key++;
      }
      var mads = new List<string>();
      foreach (var r in refSamples) {
        long sum = 0; for (int p = 0; p < s.Length && p < r.Length; p++) sum += Math.Abs(s[p] - r[p]);
        mads.Add((sum / (double)s.Length).ToString("F1", CultureInfo.InvariantCulture));
      }
      string file = Path.Combine(dir, "f" + i.ToString("D3") + ".png");
      Save(frames[i], file, 2);
      frames[i].Dispose();
      Console.WriteLine("{\"i\":" + i + ",\"t\":" + times[i].ToString("F1", CultureInfo.InvariantCulture) + ",\"luma\":" + (luma / n).ToString("F1", CultureInfo.InvariantCulture)
        + ",\"white\":" + (white / (double)n).ToString("F3", CultureInfo.InvariantCulture) + ",\"black\":" + (black / (double)n).ToString("F3", CultureInfo.InvariantCulture)
        + ",\"key\":" + (key / (double)n).ToString("F3", CultureInfo.InvariantCulture) + ",\"mad\":[" + string.Join(",", mads.ToArray()) + "],\"file\":\"" + file.Replace("\\", "/") + "\"}");
    }
  }
}
'@
if ($Mode -eq 'backdrop') {
  [ScreenFrames]::Dpi()
  $f = New-Object Backdrop
  $f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'
  $f.BackColor = [System.Drawing.Color]::FromArgb(255, 128, 0)
  $f.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
  [System.Windows.Forms.Application]::Run($f)
}
elseif ($Mode -eq 'single') { [ScreenFrames]::Single($X, $Y, $W, $H, $Out) }
else { New-Item -ItemType Directory -Force $Out | Out-Null; [ScreenFrames]::Seq($X, $Y, $W, $H, $DurationMs, $IntervalMs, $Out, $Refs) }
