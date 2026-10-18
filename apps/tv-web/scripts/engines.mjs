// The web engines the TV app must run on, as pinned Chromium snapshot builds (chromium-browser-snapshots on Google
// Cloud Storage). These are open-source builds without H.264/AAC: playback itself is checked on the TVs.
import path from 'node:path';

// Snapshot positions per Chromium major, Windows x64.
export const ENGINES = {
  53: { position: 403380, why: 'LG webOS 4 (2018), the oldest supported engine' },
  56: { position: 433064, why: 'Samsung Tizen 4 (2018)' },
  69: { position: 576753, why: 'Samsung Tizen 5.5 (2020), LG webOS 5' },
};

// Downloads live in .dev/engines/<major>/ at the repo root (ignored by git).
const root = path.resolve(import.meta.dirname, '..', '..', '..');
export const engineDir = (major) => path.join(root, '.dev', 'engines', String(major));
export const engineExe = (major) => path.join(engineDir(major), 'chrome-win32', 'chrome.exe');
