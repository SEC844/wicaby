// Web TV app (docs/webtv.md): the desktop renderer (apps/desktop/src/renderer) over a browser bridge, for LG webOS 6+,
// Samsung Tizen 6.5+ (Chromium 79 to 85) and the GitHub Pages demo. Build: npm run build:webtv (root).
import fs from 'node:fs';
import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { legacyCss } from './scripts/legacy-css.mjs';

const here = import.meta.dirname;
const version = JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8')).version as string;

// --mode demo (GitHub Pages): the page carries dist/demo-public/ (scripts/demo-data.mjs) and offers the demo server.
export default defineConfig(({ mode }) => ({
  root: here,
  base: './',
  // The desktop's svelte.config.js (vitePreprocess) applies to its .svelte files.
  plugins: [
    svelte({ configFile: path.join(here, '../desktop/svelte.config.js') }),
    // TV packages load index.html from file://, where Chromium refuses module scripts (origin null): one classic,
    // deferred script instead.
    {
      name: 'wicaby-classic-script',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: (html) => html.replace(/<script type="module" crossorigin/g, '<script defer').replace(/<link rel="stylesheet" crossorigin/g, '<link rel="stylesheet"'),
      },
    },
  ],
  // Chromium 79-85 selector fixes (scripts/legacy-css.mjs); the desktop build never sees them.
  css: { postcss: { plugins: [legacyCss()] } },
  publicDir: mode === 'demo' ? 'dist/demo-public' : false,
  define: {
    // lib/platform.ts `web`, and the version the server sees in the auth header.
    'import.meta.env.VITE_WICABY_WEB': JSON.stringify('1'),
    'import.meta.env.VITE_WICABY_VERSION': JSON.stringify(version),
    'import.meta.env.VITE_WICABY_DEMO': JSON.stringify(mode === 'demo' ? '1' : '0'),
  },
  build: {
    outDir: mode === 'demo' ? 'dist/demo' : 'dist/tv',
    emptyOutDir: true,
    // webOS 6 runs Chromium 79, Tizen 6.5 Chromium 85: syntax and CSS are lowered to the oldest.
    target: 'chrome79',
    cssTarget: 'chrome79',
    // One script: TV packages load from file://, where module chunks and preloads are less predictable.
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      output: { format: 'iife', inlineDynamicImports: true },
      // The preload helper and lazy globs mention import.meta; with every import inlined it is never read.
      onLog(level, log, handler) {
        if (log.code !== 'EMPTY_IMPORT_META') handler(level, log);
      },
    },
  },
  server: { port: 5299, strictPort: true, host: '127.0.0.1' },
}));
