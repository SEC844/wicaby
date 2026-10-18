// Bundles the main process and the preload script with esbuild.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
};

const targets = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'out/main/index.cjs' },
  // Sandboxed preloads can only require('electron'); everything else is inlined.
  { ...common, entryPoints: ['src/preload/index.ts'], outfile: 'out/preload/index.cjs' },
  // Comic archives (RAR, 7z, tar) are read in a worker thread; ComicService starts it from this file.
  { ...common, entryPoints: ['src/main/comics/archive-worker.ts'], outfile: 'out/main/archive-worker.cjs' },
];

// libarchive's WebAssembly, handed to the worker by ComicService.
fs.mkdirSync('out/main', { recursive: true });
fs.copyFileSync(createRequire(import.meta.url).resolve('libarchive-wasm/dist/libarchive.wasm'), 'out/main/libarchive.wasm');

export async function watchMain(onRebuild) {
  const plugin = { name: 'notify', setup: (b) => b.onEnd((r) => r.errors.length === 0 && onRebuild?.()) };
  const contexts = await Promise.all(targets.map((t) => context({ ...t, plugins: [plugin] })));
  await Promise.all(contexts.map((c) => c.watch()));
  return contexts;
}

if (process.argv[1]?.endsWith('build-main.mjs')) {
  if (watch) await watchMain();
  else await Promise.all(targets.map((t) => build(t)));
}
