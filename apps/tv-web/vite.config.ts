import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import androidStrings from './scripts/android-strings.mjs';
import pkg from './package.json' with { type: 'json' };

// The oldest web engine this app supports: TVs from 2018 on, LG webOS 4 (Chromium 53) and Samsung Tizen 4
// (Chromium 56). The build lowers syntax to it; src/polyfills.ts fills in the missing APIs. CSS must stay within it
// too: no grid, no flexbox `gap`, no backdrop-filter (see src/styles).
export const ENGINE = 'chrome53';

// `npm run dev` proxies the mock server (or a real one: WICABY_DEV_SERVER), so the browser build is same-origin and
// needs no CORS preflight.
const devServer = process.env.WICABY_DEV_SERVER ?? 'http://127.0.0.1:8096';

// Packaged TV apps load from a local origin where old runtimes refuse module scripts: ship one classic, deferred
// script (the bundle is a single IIFE chunk).
const classicScript: Plugin = {
  name: 'wicaby-classic-script',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(/<script type="module" crossorigin/g, '<script defer').replace(/ crossorigin/g, ''),
};

export default defineConfig({
  root: 'src',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  plugins: [svelte(), androidStrings(), classicScript],
  resolve: {
    // Platform-neutral code shared with the desktop app (models, markers, HDR, track selection…).
    alias: { $shared: fileURLToPath(new URL('../desktop/src/shared', import.meta.url)) },
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
    strictPort: true,
    proxy: { '/dev-server': { target: devServer, changeOrigin: true, rewrite: (p) => p.replace(/^\/dev-server/, '') } },
  },
});
