// Bundles the main process and the preload script with esbuild.
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
];

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
