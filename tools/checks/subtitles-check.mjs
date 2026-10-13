// X-03 subtitle search: the pure rules (apps/desktop/src/shared/subtitles.ts) against the vectors shared
// with SubtitleSearchTest.kt (fixtures/subtitles/subtitles.json), then the mock routes: both result shapes,
// no provider (404), no right (403), and a download that adds an external stream to PlaybackInfo.
// Run: node tools/checks/subtitles-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const S = await import(pathToFileURL(path.join(root, 'apps/desktop/src/shared/subtitles.ts')).href);
const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'subtitles', 'subtitles.json'), 'utf8'));

let failures = 0;
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
};

for (const c of fx.flags) await check(`flags: ${c.name}`, () => assert.deepEqual(S.subtitleFlags(c.in), c.out));
for (const c of fx.language) await check(`language ${JSON.stringify(c)}`, () => assert.equal(S.searchLanguage(c.last, c.preferred, c.ui), c.out));
for (const c of fx.failure) await check(`failure ${c.status}`, () => assert.equal(S.subtitleFailure(new Error(c.status ? `Not found (HTTP ${c.status})` : 'offline')), c.out));
for (const c of fx.policy) await check(`policy ${JSON.stringify(c)}`, () => assert.equal(S.canDownloadSubtitles(c.policy ?? undefined, c.jellyfin), c.out));
for (const c of fx.added) await check(`added: ${c.name}`, () => assert.equal(S.addedSubtitle(c.before, c.after)?.Index ?? null, c.out));

// ---- Mock routes (in process; MOCK_SUBS and MOCK_SUB_POLICY are read per request) ----
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};
const logged = console.log;
console.log = () => {}; // the admin module logs each download
const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
const login = await fetch(`${base}/Users/AuthenticateByName`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="subtitles-check", Version="1"' },
  body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
}).then((r) => r.json());
const H = { 'X-Emby-Token': login.AccessToken, 'Content-Type': 'application/json' };
const api = (method, p, extra = {}) => fetch(`${base}${p}`, { method, headers: { ...H, ...extra } });
const subStreams = async (id) => (await (await api('POST', `/Items/${id}/PlaybackInfo?UserId=${login.User.Id}`)).json()).MediaSources[0].MediaStreams.filter((s) => s.Type === 'Subtitle');

await check('emby shape: IsForced / IsHearingImpaired, no MediaSourceId needed', async () => {
  const r = await (await api('GET', '/Items/ep-1-1/RemoteSearch/Subtitles/fre')).json();
  assert.ok(r.length >= 3 && r.every((x) => x.ProviderName && x.Id));
  assert.ok(r.some((x) => S.subtitleFlags(x).forced) && r.some((x) => S.subtitleFlags(x).sdh) && r.some((x) => x.IsHashMatch));
});
await check('jellyfin shape: Forced / HearingImpaired / MachineTranslated', async () => {
  const r = await (await api('GET', '/Items/ep-1-1/RemoteSearch/Subtitles/fre', { 'x-mock-flavour': 'jellyfin' })).json();
  assert.ok(r.every((x) => x.IsForced === undefined && typeof x.Forced === 'boolean'));
  assert.ok(r.some((x) => S.subtitleFlags(x).forced) && r.some((x) => S.subtitleFlags(x).sdh) && r.some((x) => S.subtitleFlags(x).machine));
});
await check('no provider: 404 maps to noProvider', async () => {
  process.env.MOCK_SUBS = 'none';
  const res = await api('GET', '/Items/ep-1-1/RemoteSearch/Subtitles/fre');
  delete process.env.MOCK_SUBS;
  assert.equal(S.subtitleFailure(new Error(`Not found (HTTP ${res.status})`)), 'noProvider');
});
await check('no right: 403 maps to forbidden', async () => {
  process.env.MOCK_SUB_POLICY = 'deny';
  const res = await api('POST', '/Items/ep-1-1/RemoteSearch/Subtitles/os-fre-1');
  delete process.env.MOCK_SUB_POLICY;
  assert.equal(S.subtitleFailure(new Error(`Forbidden (HTTP ${res.status})`)), 'forbidden');
});
await check('download adds a selectable external stream', async () => {
  const before = await subStreams('ep-1-1');
  assert.equal((await api('POST', '/Items/ep-1-1/RemoteSearch/Subtitles/os-fre-1')).status, 204);
  const after = await subStreams('ep-1-1');
  const added = S.addedSubtitle(before, after);
  assert.ok(added && added.IsExternal && added.DeliveryMethod === 'External' && added.Language === 'fre');
  const file = await fetch(`${base}${added.DeliveryUrl}`, { headers: H });
  assert.ok(file.ok && /-->/.test(await file.text()), 'subtitle file served');
  // The same subtitle again does not add a second stream.
  await api('POST', '/Items/ep-1-1/RemoteSearch/Subtitles/os-fre-1');
  assert.equal((await subStreams('ep-1-1')).length, after.length);
});
server.close();
console.log = logged;

console.log(`subtitles-check: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
