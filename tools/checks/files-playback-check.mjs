// File source playback (file-sources-spec FS-05) with the bundled mpv (--vo=null --ao=null --no-audio) against the
// WebDAV mock: mpv gets a loopback relay URL and never the mock's address or a credential; every request reaching
// the mock carries Authorization (none in a URL); a seek is a 206; the relay listens on 127.0.0.1 only and answers
// 404 for an unknown or expired token, and for a token whose play was replaced, stopped or whose source went.
// Then local progress: stopping at 50 % resumes there, the title tag and the
// duration are cached after the first play, and touching the file's mtime starts it over (files.resume.changed).
// Without mpv (or without a playable clip) the mpv part is skipped and said so.
// Usage: node tools/checks/files-playback-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildFilesFixture, findMpv } from '../mock-server/files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';
import { bundleFiles, identity, quiet } from './files-bundle.mjs';

const F = await bundleFiles();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-play-'));
const fx = buildFilesFixture(path.join(tmp, 'tree'));
// A clip with no NFO, so the cached title tag shows.
const clipRel = 'Clips/Some.Clip.mkv';
fs.mkdirSync(path.join(fx.dir, 'Clips'));
fs.copyFileSync(path.join(fx.dir, ...fx.film.split('/')), path.join(fx.dir, 'Clips', 'Some.Clip.mkv'));
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);
const TICKS = 10_000;

const dav = await startMockWebdav({ root: fx.dir, port: 0 });
const relay = new F.LoopbackRelay();
const backend = new F.WebDavBackend(dav.base, { user: 'demo', pass: 'demo' }, { mode: 'insecure-http' });
const progress = new F.ProgressStore(path.join(tmp, 'progress.json'));
const client = new F.FilesClient({ id: 'd'.repeat(32), name: 'Example DAV', protocol: 'webdav' }, backend, progress, identity, relay);
const id = F.encodeId(clipRel);

const target = await client.playTarget(id, 'mpv', (p) => `wicaby-media://api/${'d'.repeat(32)}${p}`);
const port = relay.address.port;
ok(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[0-9a-f]{32}/0$`).test(target.url), `mpv gets a relay URL (${target.url.replace(/[0-9a-f]{32}/, '<token>')})`);
ok(!target.url.includes(String(dav.server.address().port)) && !/demo/.test(target.url), 'never the mock address or a credential');
ok(relay.address.address === '127.0.0.1', 'the relay binds 127.0.0.1');
const html = await client.playTarget(id, 'html', (p) => `wicaby-media://api/${'d'.repeat(32)}${p}`);
ok(html.url === `wicaby-media://api/${'d'.repeat(32)}/Items/${id}/File`, 'the HTML player gets the wicaby-media:// file route');

const mpv = findMpv();
if (mpv && fx.playable) {
  dav.state.calls.length = 0;
  dav.state.ranges.length = 0;
  // Start at 5 s: FFmpeg seeks with a Range request. The title tag is printed for the cache below.
  // Async: the relay and the mock answer from this very process. mpv.com is the console twin of mpv.exe (stdout).
  const com = mpv.replace(/\.exe$/i, '.com');
  const r = await new Promise((resolve) => {
    const p = spawn(fs.existsSync(com) ? com : mpv, ['--no-config', '--vo=null', '--ao=null', '--no-audio', '--start=5', '--length=1', '--term-playing-msg=TAG=${metadata/by-key/title}', target.url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.resume();
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('close', (status) => (clearTimeout(timer), resolve({ status, stdout })));
  });
  ok(r.status === 0, `mpv played through the relay (exit ${r.status})`);
  ok(dav.state.calls.length > 0 && dav.state.calls.every((c) => c.auth), `mpv's ${dav.state.calls.length} request(s) reached the mock with Authorization`);
  ok(!dav.state.tags.includes('AUTH-IN-URL') && !dav.state.tags.includes('NO-AUTH'), 'AUTH-IN-URL = 0, NO-AUTH = 0');
  ok(dav.state.ranges.some((x) => x.status === 206 && x.start > 0), 'the seek is a 206 past byte 0');
  const tag = /TAG=(.*)/.exec(r.stdout ?? '')?.[1]?.trim();
  ok(tag === 'Example Tag Title', `mpv read the title tag (${tag})`);
  client.cacheTitle(id, tag);
} else {
  console.log(`files-playback-check: mpv part skipped (${mpv ? 'no playable clip' : 'mpv not found'})`);
  client.cacheTitle(id, 'Example Tag Title');
}

// ---- the relay's own guards ----
const get = (url) => new Promise((resolve) => http.get(url, (res) => (res.resume(), resolve(res.statusCode))).on('error', (e) => resolve(e.code)));
ok((await get(`http://127.0.0.1:${port}/${'0'.repeat(32)}/0`)) === 404, 'an unknown token: 404');
ok((await get(target.url.replace(/\/0$/, '/9'))) === 404, 'a token past its files: 404');
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
if (lan) {
  const refused = await new Promise((resolve) => {
    const s = net.connect({ host: lan, port }, () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(true));
  });
  ok(refused, 'a connection to a LAN address of this machine is refused');
} else console.log('files-playback-check: no LAN address here, LAN refusal not tested');
relay.close();
const again = await client.playTarget(id, 'mpv', () => '');
ok((await get(target.url.replace(/:\d+\//, `:${relay.address.port}/`))) === 404, 'an expired token (relay restarted): 404');
ok(again.url !== target.url, 'a new play gets a new token');

// ---- token lifetime (§5.1: one token per play) ----
ok((await get(again.url)) === 200, 'the current play is served');
const next = await client.playTarget(id, 'mpv', () => '');
ok((await get(again.url)) === 404 && (await get(next.url)) === 200, 'a new play revokes the one it replaces');
await client.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: id, PositionTicks: 0, RunTimeTicks: 0 });
ok((await get(next.url)) === 200, "the replaced play's late Stopped report (a version switch) leaves the new one alone");
await client.request('POST', '/Sessions/Playing', undefined, { ItemId: id, PositionTicks: 0, RunTimeTicks: 0 });
await client.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: id, PositionTicks: 0, RunTimeTicks: 0 });
ok((await get(next.url)) === 404, "the play's own Stopped report revokes its token");
const removed = await client.playTarget(id, 'mpv', () => '');
relay.releaseBackend(backend);
ok((await get(removed.url)) === 404, 'removing the source or changing its credentials (releaseBackend) revokes its tokens');
const idle = await client.playTarget(id, 'mpv', () => '');
const realNow = Date.now;
Date.now = () => realNow() + 31 * 60_000;
const idleStatus = await get(idle.url);
Date.now = realNow;
ok(idleStatus === 404, 'a token unused for 30 minutes: 404 while the relay keeps listening');

// ---- local progress ----
await client.request('POST', '/Sessions/Playing', undefined, { ItemId: id, PositionTicks: 0, RunTimeTicks: 10_000 * TICKS });
await client.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: id, PositionTicks: 5_000 * TICKS, RunTimeTicks: 10_000 * TICKS });
progress.flush();
const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'progress.json'), 'utf8'));
ok(Object.keys(doc.records).length === 1 && doc.records[clipRel].positionMs === 5000, 'stopping at 50 % writes one progress record');
const item = await client.request('GET', `/Users/local/Items/${id}`);
ok(item.UserData.PlaybackPositionTicks === 5_000 * TICKS && item.RunTimeTicks === 10_000 * TICKS, 'reopening resumes at 50 %, with the cached duration');
const listed = (await client.request('GET', '/Users/local/Items', { ParentId: F.encodeId('Clips') })).Items[0];
ok(listed.Name === 'Example Tag Title' && listed.RunTimeTicks === 10_000 * TICKS, 'the title tag and the duration show in the listing');
ok((await client.request('GET', '/Users/local/Items/Resume')).Items[0]?.Id === id, 'and in Continue');
const resumed = await client.playTarget(id, 'mpv', () => '');
ok(!resumed.changed && resumed.durationMs === 10_000, 'an unchanged file resumes');

const file = path.join(fx.dir, 'Clips', 'Some.Clip.mkv');
const later = new Date(Date.now() + 120_000);
fs.utimesSync(file, later, later);
client.refresh();
const changed = await quiet(() => client.playTarget(id, 'mpv', () => ''));
ok(changed.changed, 'touching the mtime: files.resume.changed');
ok((await client.request('GET', `/Users/local/Items/${id}`)).UserData.PlaybackPositionTicks === 0, 'and it starts at 0');

relay.close();
backend.close();
await dav.close();
console.log(`files-playback-check: ok (${passed} checks${mpv && fx.playable ? ', mpv through the relay' : ', no mpv'})`);
