import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { session } from 'electron';
import type { AudioDevice, StorageUsage } from '../../shared/contract';
import type { MpvPlayer } from '../playback/mpv-player';
import { logger } from './log';
import { isSafeMpvPath } from './settings';

const log = logger.scope('settings');

// Backs the Audio and "Confidentialité et stockage" panes.
export interface SettingsExtras {
  audioDevices(): Promise<AudioDevice[]>;
  storage(): Promise<StorageUsage>;
  clearStorage(kind: 'http' | 'logs'): Promise<StorageUsage>;
}

// `mpv --audio-device=help` lists the outputs and exits without opening any of them.
function listWithHelp(exe: string): Promise<AudioDevice[]> {
  return new Promise((resolve) => {
    // Linux: the same outputs mpv plays through (mpv-args.ts mpvOutputArgs), names prefixed pipewire/, pulse/, alsa/.
    execFile(exe, ['--no-config', process.platform === 'win32' ? '--ao=wasapi' : '--ao=pipewire,pulse,alsa', '--audio-device=help'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) {
        log.warn('audio device list failed', err);
        return resolve([]);
      }
      const out: AudioDevice[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s*'([^']+)'\s+\((.*)\)\s*$/.exec(line);
        if (m) out.push({ name: m[1], description: m[2] });
      }
      resolve(out);
    });
  });
}

function dirSize(dir: string, filter: (name: string) => boolean = () => true): number {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && filter(e.name))
      .reduce((n, e) => n + fs.statSync(path.join(dir, e.name)).size, 0);
  } catch {
    return 0;
  }
}

export function createSettingsExtras(opts: { mpvExe: () => string | null; runningMpv: () => MpvPlayer | null; comicsDir: string; logDir: string; currentLog: () => string }): SettingsExtras {
  const storage = async (): Promise<StorageUsage> => ({
    http: await session.defaultSession.getCacheSize().catch(() => 0),
    comics: dirSize(opts.comicsDir, (f) => f.endsWith('.cbz')),
    logs: dirSize(opts.logDir),
  });
  return {
    async audioDevices() {
      const running = opts.runningMpv();
      const live = running ? await running.audioDevices().catch(() => null) : null;
      if (live?.length) return live.map((d) => ({ name: String(d.name), description: String(d.description) }));
      // Only an mpv.exe validated like the settings value is ever executed.
      const exe = opts.mpvExe();
      return isSafeMpvPath(exe) ? listWithHelp(exe) : [];
    },
    storage,
    async clearStorage(kind) {
      if (kind === 'http') await session.defaultSession.clearCache();
      else {
        // Today's file stays open for writing; every older one goes.
        const keep = path.resolve(opts.currentLog());
        for (const f of fs.readdirSync(opts.logDir)) {
          const file = path.resolve(opts.logDir, f);
          if (file !== keep) fs.rmSync(file, { force: true });
        }
      }
      return storage();
    },
  };
}
