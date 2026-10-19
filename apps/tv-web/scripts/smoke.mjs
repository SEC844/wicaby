// Smoke test of the built app (dist/) on each pinned engine (scripts/engines.mjs), through the DevTools protocol.
// Loads dist/index.html from file://, like a packaged TV app, sends remote keys, saves screenshots to
// .dev/smoke/<major>/ and fails on any console error or uncaught exception.
// Usage: npm run smoke [-- --engine 53 --steps 39,38,13,text:wicaby,wait:2000 --wait 1500 --port 9300]
// --port: the first DevTools port (one per engine from there), so parallel runs do not collide.
// --probe <js>: an expression evaluated at the end, printed (debugging).
// Steps: a keyCode (sends the key), text:<chars> (types into the focused field; no commas), wait:<ms>.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ENGINES, engineExe } from './engines.mjs';

const { values: opts } = parseArgs({
  options: { engine: { type: 'string', multiple: true }, steps: { type: 'string', default: '' }, probe: { type: 'string' }, wait: { type: 'string', default: '1500' }, port: { type: 'string', default: '9300' } },
});
const app = path.resolve(import.meta.dirname, '..');
const index = path.join(app, 'dist', 'index.html');
if (!fs.existsSync(index)) throw new Error('dist/index.html missing: run npm run build first');
const steps = opts.steps.split(',').filter(Boolean);
// The built CSS, for the dropped-rules check.
const assets = path.join(app, 'dist', 'assets');
const cssText = fs.readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
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
    '--no-first-run', '--allow-file-access-from-files', '--remote-allow-origins=*',
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target;
    // Up to 30 s: a fresh profile on an old engine sometimes takes over 10 s (first run, antivirus scan).
    for (let i = 0; i < 150 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
    }
    if (!target) throw new Error(`Chromium ${major} did not start`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Chromium ${major}: DevTools connection refused`));
      setTimeout(() => reject(new Error(`Chromium ${major}: DevTools connection timed out`)), 10_000);
    });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) return pending.get(msg.id)?.(msg.result);
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    };
    // Every command gives up after 15 s (undefined): current headless Chromium never answers Page.navigate to a
    // file:// URL, though the page loads.
    const send = (method, params = {}) =>
      new Promise((r) => {
        const n = ++id;
        pending.set(n, r);
        setTimeout(() => pending.delete(n) && r(undefined), 15_000);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    // The reference engine only parses the CSS (below), on its blank page: current Chromium neither navigates to
    // file:// through DevTools nor answers it reliably once an app runs.
    const reference = ENGINES[major].reference === true;
    // Chromium 53 reports neither Runtime.exceptionThrown nor console errors over DevTools: the page also collects
    // them itself (uncaught errors, rejections, console.error), read back at the end. The script is added before the
    // app loads (addScriptToEvaluateOnLoad on engines older than addScriptToEvaluateOnNewDocument).
    const collector = `window.__smokeErrors = [];
      window.addEventListener('error', function (e) { __smokeErrors.push(String((e.error && e.error.stack) || e.message)); });
      window.addEventListener('unhandledrejection', function (e) { __smokeErrors.push(String((e.reason && e.reason.stack) || e.reason)); });
      var ce = console.error; console.error = function () { __smokeErrors.push([].join.call(arguments, ' ')); return ce.apply(console, arguments); };`;
    if (!reference && !(await send('Page.addScriptToEvaluateOnNewDocument', { source: collector }))) await send('Page.addScriptToEvaluateOnLoad', { scriptSource: collector });
    if (!reference) void send('Page.navigate', { url: pathToFileURL(index).href });
    if (!reference) await sleep(Number(opts.wait));
    const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    if (!reference) await shot('00-start');
    for (const [i, step] of (reference ? [] : steps).entries()) {
      const name = String(i + 1).padStart(2, '0');
      if (step.startsWith('wait:')) { await sleep(Number(step.slice(5))); continue; }
      // Typed key by key: Input.insertText does not exist in the protocol of the old engines.
      if (step.startsWith('text:')) for (const ch of step.slice(5)) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
      else for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: Number(step), nativeVirtualKeyCode: Number(step) });
      await sleep(300);
      await shot(`${name}-${step.replace(/[^\w]+/g, '_')}`);
    }
    if (opts.probe && !reference) {
      // awaitPromise is unknown to the oldest engines' protocol (error, no result): evaluate plainly there.
      const r =
        (await send('Runtime.evaluate', { expression: opts.probe, returnByValue: true, awaitPromise: true })) ??
        (await send('Runtime.evaluate', { expression: opts.probe, returnByValue: true }));
      console.log(`Chromium ${major} probe: ${JSON.stringify(r?.result?.value ?? r?.exceptionDetails?.text)}`);
    }
    if (!reference) {
      const page = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__smokeErrors || [])', returnByValue: true });
      // An error both channels saw counts once (compared on its first line).
      const first = (e) => String(e).split('\n')[0];
      const seen = new Set(errors.map(first));
      for (const e of JSON.parse(page?.result?.value ?? '[]')) if (!seen.has(first(e))) errors.push(e);
    }
    // The selectors this engine kept from the built CSS: a rule it cannot parse is dropped silently (see the CSS check
    // below). The text goes through an inline <style>: a file:// stylesheet's rules are unreadable on current engines.
    const text = JSON.stringify(cssText);
    const css = await send('Runtime.evaluate', {
      expression: `(function () { var s = document.createElement('style'); s.textContent = ${text}; document.head.appendChild(s);
        var out = [].map.call(s.sheet.cssRules, function (r) { return r.selectorText || r.cssText.slice(0, 60); });
        s.parentNode.removeChild(s); return JSON.stringify(out); })()`,
      returnByValue: true,
    });
    ws.close();
    const rules = JSON.parse(css?.result?.value ?? '[]');
    fs.writeFileSync(path.join(out, 'css-rules.json'), JSON.stringify(rules, null, 1));
    return { errors, rules };
  } finally {
    proc.kill();
  }
}

// CSS rules the newest engine keeps but an older one drops: syntax too new for the support floor (:where(), :has(),
// flex gap...). Only deliberate fallbacks may differ.
const EXPECTED_DROPS = [/::placeholder/];

let failed = false;
const majors = opts.engine?.map(Number) ?? Object.keys(ENGINES).map(Number);
const kept = new Map();
for (const [i, major] of majors.entries()) {
  const { errors, rules } = await run(major, Number(opts.port) + i);
  kept.set(major, rules);
  failed ||= errors.length > 0;
  console.log(`Chromium ${major} (${ENGINES[major].why}, ${rules.length} CSS rules): ${errors.length ? `FAIL\n  ${errors.join('\n  ')}` : 'ok'}`);
}
const newest = Math.max(...kept.keys());
for (const [major, rules] of kept) {
  if (major === newest) continue;
  const have = new Set(rules);
  const dropped = kept.get(newest).filter((r) => !have.has(r) && !EXPECTED_DROPS.some((re) => re.test(r)));
  if (dropped.length) {
    failed = true;
    console.log(`Chromium ${major}: FAIL, CSS rules dropped (newer than the engine)\n  ${dropped.join('\n  ')}`);
  }
}
process.exitCode = failed ? 1 : 0;
