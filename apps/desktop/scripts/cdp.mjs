// Dev helper: screenshot or evaluate JS in a running Wicaby started with
// --remote-debugging-port. Usage: CDP_PORT=9341 node apps/desktop/scripts/cdp.mjs <out.png|-> [js-expression]
// CDP_OSD=1 targets the playback OSD window instead of the main window.
const [, , out, expr] = process.argv;
const targets = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? 9333) + '/json')).json();
const want = process.env.CDP_OSD ? (t) => t.url.includes('osd=1') : (t) => !t.url.includes('osd=1');
const page = targets.find((t) => t.type === 'page' && want(t) && /^(app:|http:\/\/localhost)/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
if (expr) {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r));
}
if (out && out !== '-') {
  await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 11, g: 11, b: 13, a: 1 } });
  const r = await call('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('saved', out);
}
ws.close();
