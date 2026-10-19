import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import androidIcons from './scripts/android-icons.mjs';
import androidStrings from './scripts/android-strings.mjs';
import tokens from './scripts/tokens.mjs';
// The repository's version (the release tag), shared by every app.
import pkg from '../../package.json' with { type: 'json' };

// The oldest web engine this app supports: TVs from 2018 on, LG webOS 4 (Chromium 53) and Samsung Tizen 4
// (Chromium 56). The build lowers syntax to it; src/polyfills.ts fills in the missing APIs. CSS must stay within it
// too: no grid, no flexbox `gap`, no backdrop-filter (see src/styles).
export const ENGINE = 'chrome53';

// `npm run dev` proxies the mock server (or a real one: WICABY_DEV_SERVER), so the dev build is same-origin and
// needs no CORS preflight.
const devServer = process.env.WICABY_DEV_SERVER ?? 'http://127.0.0.1:8096';

// Packaged TV apps load from a local origin where old runtimes refuse module scripts: ship one classic, deferred
// script (the bundle is a single IIFE chunk).
const classicScript: Plugin = {
  name: 'wicaby-classic-script',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(/<script type="module" crossorigin/g, '<script defer').replace(/ crossorigin/g, ''),
};

// Svelte 5 wraps some scoping classes in :where() to keep specificity flat, but :where() arrived in Chromium 88:
// older engines drop every rule that contains it. The plain class scopes the same element; the only change is one
// more class of specificity, which never crosses component boundaries since scoping classes are per component.
const plainScoping: Plugin = {
  name: 'wicaby-plain-scoping',
  apply: 'build',
  enforce: 'post',
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'asset' && file.fileName.endsWith('.css') && typeof file.source === 'string') {
        file.source = file.source.replace(/:where\((\.svelte-[a-z0-9]+)\)/g, '$1');
        if (file.source.includes(':where(')) this.error(`${file.fileName}: :where() left that Chromium < 88 cannot parse`);
      }
    }
  },
};

export default defineConfig({
  root: 'src',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  plugins: [svelte(), androidStrings(), androidIcons(), tokens(), classicScript, plainScoping],
  resolve: {
    // Platform-neutral code shared with the desktop app (models, markers, HDR, track selection…).
    alias: {
      $shared: fileURLToPath(new URL('../desktop/src/shared', import.meta.url)),
      // Pure renderer helpers of the desktop app (items, continue watching): no IPC, no runes.
      $desktop: fileURLToPath(new URL('../desktop/src/renderer/lib', import.meta.url)),
      // Assets shared with the Android TV app (the Geist fonts).
      $android: fileURLToPath(new URL('../android', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ENGINE,
    // TVs load from local storage; one bundle avoids extra parse and request overhead.
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: {
    port: 5299,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    strictPort: true,
    proxy: { '/dev-server': { target: devServer, changeOrigin: true, rewrite: (p) => p.replace(/^\/dev-server/, '') } },
  },
});
