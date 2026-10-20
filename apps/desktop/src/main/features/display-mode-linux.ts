import { execFile } from 'node:child_process';

// Refresh-rate matching on Linux. X11 sessions switch with xrandr; KDE Plasma on Wayland with
// kscreen-doctor. Elsewhere (GNOME or another compositor on Wayland) there is no tool: Wicaby itself
// runs under XWayland by default (index.ts), whose xrandr cannot change the real output.

export type LinuxDisplayTool = 'xrandr' | 'kscreen-doctor';

export function linuxDisplayTool(env: NodeJS.ProcessEnv): LinuxDisplayTool | null {
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!env.XDG_SESSION_TYPE && Boolean(env.WAYLAND_DISPLAY));
  if (!wayland) return env.DISPLAY ? 'xrandr' : null;
  return (env.XDG_CURRENT_DESKTOP ?? '').split(':').some((d) => d.toUpperCase() === 'KDE') ? 'kscreen-doctor' : null;
}

// Electron's display backend, from WICABY_OZONE (x11 | wayland | auto). Default X11, which mpv's --wid
// embedding needs (XWayland in a Wayland session); native Wayland only when there is no X server at all.
export function ozonePlatform(env: NodeJS.ProcessEnv): 'x11' | 'wayland' | 'auto' {
  const v = env.WICABY_OZONE?.trim().toLowerCase();
  if (v === 'x11' || v === 'wayland' || v === 'auto') return v;
  return !env.DISPLAY && env.WAYLAND_DISPLAY ? 'wayland' : 'x11';
}

// Whether Electron's windows end up native Wayland ones ('auto': Chromium picks Wayland in a Wayland session).
export function nativeWayland(env: NodeJS.ProcessEnv, ozone: 'x11' | 'wayland' | 'auto'): boolean {
  return ozone === 'wayland' || (ozone === 'auto' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)));
}

// One output, in screen pixels, with the modes at its current resolution and the tool arguments
// that select each of them.
export interface DisplayOutput {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rate: number;
  restore: string[];
  modes: { rate: number; args: string[] }[];
}

// `xrandr --current`: "HDMI-1 connected primary 1920x1080+0+0 (…)" then indented mode lines,
// "   1920x1080     60.00*+  50.00    23.98  " where * marks the current rate.
export function parseXrandr(text: string): DisplayOutput[] {
  const outs: DisplayOutput[] = [];
  let head: { name: string; x: number; y: number; width: number; height: number } | null = null;
  let lines: { mode: string; rates: { text: string; current: boolean }[] }[] = [];
  const flush = () => {
    const cur = lines.flatMap((l) => l.rates.filter((r) => r.current).map((r) => ({ mode: l.mode, rate: r.text })))[0];
    if (head && cur) {
      const args = (mode: string, rate: string) => ['--output', head!.name, '--mode', mode, '--rate', rate];
      const same = lines.filter((l) => l.mode === cur.mode).flatMap((l) => l.rates);
      outs.push({ ...head, rate: Number(cur.rate), restore: args(cur.mode, cur.rate), modes: same.map((r) => ({ rate: Number(r.text), args: args(cur.mode, r.text) })) });
    }
    head = null;
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s/.test(line)) {
      flush();
      const m = /^(\S+) connected (?:primary )?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line);
      if (m) head = { name: m[1], width: Number(m[2]), height: Number(m[3]), x: Number(m[4]), y: Number(m[5]) };
      continue;
    }
    const mode = /^\s+(\d+x\d+)(\s.*)$/.exec(line);
    if (!head || !mode) continue;
    const rates = [...mode[2].matchAll(/(\d+\.\d+)(\*?)/g)].map((r) => ({ text: r[1], current: r[2] === '*' }));
    lines.push({ mode: mode[1], rates });
  }
  flush();
  return outs;
}

interface KscreenMode {
  id: string | number;
  refreshRate: number;
  size?: { width: number; height: number };
}
interface KscreenOutput {
  name: string;
  enabled?: boolean;
  connected?: boolean;
  currentModeId?: string | number;
  scale?: number;
  pos?: { x: number; y: number };
  modes?: KscreenMode[];
}

// `kscreen-doctor -j` (libkscreen JSON). Positions are logical, so the size is divided by the scale.
export function parseKscreen(text: string): DisplayOutput[] {
  const start = text.indexOf('{');
  const outputs = start < 0 ? [] : ((JSON.parse(text.slice(start)) as { outputs?: KscreenOutput[] }).outputs ?? []);
  return outputs.flatMap((o) => {
    const cur = o.modes?.find((m) => String(m.id) === String(o.currentModeId));
    if (!o.enabled || !o.connected || !cur?.size) return [];
    const scale = o.scale || 1;
    const args = (m: KscreenMode) => [`output.${o.name}.mode.${m.id}`];
    const same = o.modes!.filter((m) => m.size?.width === cur.size!.width && m.size?.height === cur.size!.height);
    return [
      {
        name: o.name,
        x: o.pos?.x ?? 0,
        y: o.pos?.y ?? 0,
        width: Math.round(cur.size.width / scale),
        height: Math.round(cur.size.height / scale),
        rate: cur.refreshRate,
        restore: args(cur),
        modes: same.map((m) => ({ rate: m.refreshRate, args: args(m) })),
      },
    ];
  });
}

// shortcut: under XWayland the window's position may be scaled differently from the compositor's
// layout, so a point outside every output falls back to the only output; upgrade if multi-monitor
// KDE setups pick the wrong screen.
export function outputAt(outs: DisplayOutput[], p: { x: number; y: number }): DisplayOutput | null {
  return outs.find((o) => p.x >= o.x && p.x < o.x + o.width && p.y >= o.y && p.y < o.y + o.height) ?? (outs.length === 1 ? outs[0] : null);
}

// The Windows script's choice (display-mode.ts): keep a rate already an exact multiple of the content
// (0.02 Hz), else the closest multiple, the higher rate breaking near-ties. A near multiple (0.6 Hz)
// only replaces a rate that is not near itself, so 60 Hz stays for 29.97 fps without 59.94, but
// 24 Hz gives way to 23.98 for 23.976 fps (B21). null keeps the rate.
const EXACT = 0.02;
const NEAR = 0.6;
export function pickRate(current: number, rates: number[], fps: number): number | null {
  const err = (r: number) => {
    const m = Math.round(r / fps);
    return m >= 1 ? Math.abs(r - fps * m) : Infinity;
  };
  if (err(current) < EXACT) return null;
  const tol = err(current) < NEAR ? EXACT : NEAR;
  let best: number | null = null;
  let bestScore = Infinity;
  for (const r of rates) {
    const score = err(r) * 10 - r / 1000;
    if (err(r) < tol && score < bestScore) [best, bestScore] = [r, score];
  }
  return best === current ? null : best;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(String(stdout))));
  });
}

// Switches the output under `point` (screen pixels) to a rate matching fps. Returns what happened
// for the log and the call that puts the previous mode back, or null when nothing changed.
export async function matchLinuxRate(tool: LinuxDisplayTool, point: { x: number; y: number }, fps: number): Promise<{ log: string; undo: (() => Promise<string>) | null }> {
  const outs = tool === 'xrandr' ? parseXrandr(await run('xrandr', ['--current'])) : parseKscreen(await run('kscreen-doctor', ['-j']));
  const o = outputAt(outs, point);
  if (!o) return { log: 'no output under the window', undo: null };
  const target = pickRate(o.rate, o.modes.map((m) => m.rate), fps);
  const mode = o.modes.find((m) => m.rate === target);
  if (!mode) return { log: `keep ${o.name} ${o.rate}`, undo: null };
  await run(tool, mode.args);
  return { log: `set ${o.name} ${o.rate} ${mode.rate}`, undo: () => run(tool, o.restore) };
}
