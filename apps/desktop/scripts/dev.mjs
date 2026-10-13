// Development loop: Vite serves the renderer with HMR, esbuild watches the
// main process and restarts Electron when it changes.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { watchMain } from './build-main.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

// WICABY_DEV_PORT and extra CLI args (e.g. --user-data-dir, --remote-debugging-port)
// let several dev instances run side by side.
const port = Number(process.env.WICABY_DEV_PORT) || undefined;
const server = await createServer({ configFile: 'vite.config.ts', server: port ? { port, strictPort: true } : {} });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
console.log(`renderer at ${url}`);

let child = null;
let restarting = false;
let timer = null;

function start() {
  child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, WICABY_DEV_URL: url } });
  child.on('exit', () => {
    if (restarting) return;
    server.close();
    process.exit(0);
  });
}

function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!child) return start();
    restarting = true;
    child.once('exit', () => {
      restarting = false;
      start();
    });
    child.kill();
  }, 200);
}

await watchMain(restart);
