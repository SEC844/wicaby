import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import androidStrings from './scripts/android-strings.mjs';
import csp from './scripts/csp.mjs';
import serviceWorker from './scripts/service-worker.mjs';
// The repository's version (the release tag), shared by every app.
import pkg from '../../package.json' with { type: 'json' };

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TV_SRC = here('../tv-web/src');

// The oldest engine: Safari 17 (iOS 17), the first with ManagedMediaSource, the switch haptic (17.4) and every web
// app API the shell uses (Push, Badging, Screen Wake Lock, View Transitions arrive in 18 and are optional).
export const ENGINE = 'safari17';

// The TV web app's platform-neutral logic (API client, sessions, playback, music, Live TV, photos…) is reused as is.
// Its few seams with the TV shell (the focus-driven screen stack, the dialog layer, the dp scale and the TV platform)
// resolve to this app's own modules, which keep the same exports: the TV code needs no fork and no change.
const SEAMS: Record<string, string> = {
  'lib/nav.svelte': here('src/lib/nav.svelte.ts'),
  'lib/overlay.svelte': here('src/lib/overlay.svelte.ts'),
  'lib/screen': here('src/lib/screen.ts'),
  // Safari's own rules (HEVC only in MP4/fMP4, no MKV, AC3/EAC3 in HLS): an iPhone profile, not the TV's.
  'lib/device-profile': here('src/lib/device-profile.ts'),
  'lib/identity': here('src/lib/identity.ts'),
  platform: here('src/platform/index.ts'),
  'platform/index': here('src/platform/index.ts'),
  'platform/caps': here('src/platform/caps.ts'),
};

const tvSeams: Plugin = {
  name: 'wicaby-tv-seams',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null;
    const from = path.resolve(path.dirname(importer.split('?')[0]), source);
    if (!from.startsWith(TV_SRC)) return null;
    const key = path.relative(TV_SRC, from).split(path.sep).join('/').replace(/\.ts$/, '');
    return SEAMS[key] ?? null;
  },
};

export default defineConfig({
  root: 'src',
  // Relative: the app is served from a sub-path (GitHub Pages /wicaby/) as well as from a root.
  base: './',
  publicDir: '../public',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [tvSeams, svelte(), androidStrings(), csp(), serviceWorker()],
  resolve: {
    alias: {
      $shared: here('../desktop/src/shared'),
      $desktop: here('../desktop/src/renderer/lib'),
      $android: here('../android'),
      $tv: here('../tv-web/src/lib'),
      $tvplatform: here('../tv-web/src/platform'),
      // The desktop's scrobble client signs Last.fm calls with node:crypto's MD5: the TV app's pure one.
      'node:crypto': here('../tv-web/src/platform/node-crypto.ts'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ENGINE,
    cssTarget: ENGINE,
    assetsInlineLimit: 0,
    // Screens past the first load on demand; the service worker precaches every chunk, so a later visit opens offline.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5399,
    strictPort: true,
    fs: { allow: [here('../..')] },
  },
});
