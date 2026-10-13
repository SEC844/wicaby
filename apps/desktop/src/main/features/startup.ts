import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';

const log = logger.scope('startup');

// Passed by the login item: start in the notification area, no window.
export const HIDDEN_ARG = '--hidden';

export function startedHidden(argv: string[]): boolean {
  return argv.includes(HIDDEN_ARG);
}

// A dev build gets its own Run value so it never rewrites the installed app's entry.
const NAME = app.isPackaged ? 'Wicaby' : 'Wicaby (dev)';

function loginItem(): { path: string; args: string[]; name: string } {
  // In development the exe is electron.exe and needs the app path first.
  // Electron quotes each argument itself when it writes the Run value.
  const args = app.isPackaged ? [HIDDEN_ARG] : [app.getAppPath(), HIDDEN_ARG];
  return { path: process.execPath, args, name: NAME };
}

// ---- Linux: an XDG autostart entry, ~/.config/autostart/com.wika.wicaby.desktop ----

function autostartFile(): string {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', app.isPackaged ? 'com.wika.wicaby.desktop' : 'com.wika.wicaby-dev.desktop');
}

// Desktop Entry Exec field: every argument double-quoted with " ` $ \ escaped and % doubled, then the
// string-value escape doubles each backslash again (spec: "Exec key").
export function desktopExec(argv: string[]): string {
  return argv
    .map((a) => `"${a.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%')}"`)
    .join(' ')
    .replace(/\\/g, '\\\\');
}

// An AppImage runs from a temporary mount: $APPIMAGE is the file to start at the next login, with the
// --no-sandbox its own desktop entry passes (electron-builder.yml; its chrome-sandbox cannot be setuid).
export function autostartEntry(name: string, execPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const argv = env.APPIMAGE ? [env.APPIMAGE, '--no-sandbox', ...args] : [execPath, ...args];
  return ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${desktopExec(argv)}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

// Present and not switched off by the desktop's startup settings (Hidden=true, GNOME's enabled=false).
export function autostartEnabled(text: string | null): boolean {
  return text !== null && !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
}

function readAutostart(): string | null {
  try {
    return fs.readFileSync(autostartFile(), 'utf8');
  } catch {
    return null;
  }
}

function setAutostart(on: boolean): void {
  const file = autostartFile();
  if (!on) return fs.rmSync(file, { force: true });
  const { path: exe, args, name } = loginItem();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartEntry(name, exe, args));
}

// True when our Run value exists and is enabled (Task Manager can disable it).
export function launchAtStartupActive(): boolean {
  if (process.platform === 'linux') return autostartEnabled(readAutostart());
  const { path, args } = loginItem();
  return app.getLoginItemSettings({ path, args }).launchItems.some((i) => i.name === NAME && i.enabled);
}

export function setLaunchAtStartup(on: boolean): void {
  if (process.platform === 'linux') return setAutostart(on);
  app.setLoginItemSettings({ openAtLogin: on, enabled: on, ...loginItem() });
}

// settings.windows.launchAtStartup mirrors the HKCU Run entry (Linux: the autostart entry): read it
// at boot (the user may have changed it in Task Manager), write it when the toggle moves.
export function installLoginItem(settings: SettingsService): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  let current = launchAtStartupActive();
  if (settings.value.windows.launchAtStartup !== current) settings.update({ windows: { launchAtStartup: current } });
  settings.on('change', () => {
    const want = settings.value.windows.launchAtStartup;
    if (want === current) return;
    current = want;
    try {
      setLaunchAtStartup(want);
      log.info(`launch at startup ${want ? 'on' : 'off'}`);
    } catch (err) {
      log.warn('login item update failed', err);
    }
  });
}
