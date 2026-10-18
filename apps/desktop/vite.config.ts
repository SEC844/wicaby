import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [svelte()],
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    target: 'chrome152',
    chunkSizeWarningLimit: 1200,
    // pdf.html: the hidden page that draws PDF comic pages (src/main/comics/pdf-pages.ts).
    rolldownOptions: { input: { index: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)), pdf: fileURLToPath(new URL('src/renderer/pdf.html', import.meta.url)) } },
  },
  server: { port: 5199, strictPort: true },
});
