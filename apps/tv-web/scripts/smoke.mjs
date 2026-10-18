// Smoke test of the built app (dist/) on each pinned engine (scripts/engines.mjs), through the DevTools protocol.
// Loads dist/index.html from file://, like a packaged TV app, sends remote keys, saves screenshots to
// .dev/smoke/<major>/ and fails on any console error or uncaught exception.
// Usage: npm run smoke [-- --engine 53 --keys 39,38,13 --wait 1500]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ENGINES, engineExe } from './engines.mjs';

const { values: opts } = parseArgs({
  options: { engine: { type: 'string', multiple: true }, keys: { type: 'string', default: '' }, wait: { type: 'string', default: '1500' } },
});
const app = path.resolve(import.meta.dirname, '..');
const index = path.join(app, 'dist', 'index.html');
if (!fs.existsSync(index)) throw new Error('dist/index.html missing: run npm run build first');
const keys = opts.keys.split(',').filter(Boolean).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(major, port) {
  const exe = engineExe(major);
  if (!fs.existsSync(exe)) throw new Error(`Chromium ${major} missing: run npm run engines`);
  const out = path.resolve(app, '..', '..', '.dev', 'smoke', String(major));
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${major}-`));
  // --headless only exists from Chromium 59; older ones open a window for the run.
  const proc = spawn(exe, [
    ...(major >= 59 ? ['--headless', '--disable-gpu'] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1920,1080',
    '--no-first-run', '--allow-file-access-from-files', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
    }
    if (!target) throw new Error(`Chromium ${major} did not start`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) return pending.get(msg.id)?.(msg.result);
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(index).href });
    await sleep(Number(opts.wait));
    const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await shot('00-start');
    for (const [i, keyCode] of keys.entries()) {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await sleep(300);
      await shot(`${String(i + 1).padStart(2, '0')}-key-${keyCode}`);
    }
    ws.close();
    return errors;
  } finally {
    proc.kill();
  }
}

let failed = false;
const majors = opts.engine?.map(Number) ?? Object.keys(ENGINES).map(Number);
for (const [i, major] of majors.entries()) {
  const errors = await run(major, 9300 + i);
  failed ||= errors.length > 0;
  console.log(`Chromium ${major} (${ENGINES[major].why}): ${errors.length ? `FAIL\n  ${errors.join('\n  ')}` : 'ok'}`);
}
process.exitCode = failed ? 1 : 0;
