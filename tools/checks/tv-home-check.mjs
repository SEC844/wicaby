// Android TV launcher integration, exercised headlessly against the mock servers: the routes the
// preview channels (HomeChannels.kt: Next Up, Recently Added) and the system screen saver (Dream.kt,
// the in-app Screensaver) call, on Emby and on Jellyfin 12, plus the manifest entry that makes the
// screen saver show up in the TV settings.
// Usage: node tools/checks/tv-home-check.mjs   (starts mock-emby and mock-jellyfin on 8946/8947, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const EMBY = 8946;
const JELLYFIN = 8947;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="tv-home-check", Version="0"';

// File sources (FS-10): the Files tab comes after the library tabs and before Torrents, Search and Settings, and only
// once a source exists; its folders are routes of their own (Back goes up one folder).
{
  const main = fs.readFileSync(path.join(root, 'apps/android/tv/src/main/java/com/wika/wicaby/tv/ui/Main.kt'), 'utf8');
  const at = (re, what) => {
    const m = re.exec(main);
    assert.ok(m, `tv Main.kt: ${what} not found`);
    return m.index;
  };
  const libs = at(/views\.forEach \{ v ->/, 'library tabs');
  const files = at(/if \(fileSources\.isNotEmpty\(\)\) add\(Dest\(TopTab\("files"/, 'the Files tab (only with a source)');
  const extra = at(/addAll\(extraTabs\(\)\)/, 'extra tabs');
  const search = at(/TopTab\("search"/, 'Search tab');
  assert.ok(libs < files && files < extra && extra < search, 'tv tabs: libraries, Files, Torrents, Search, Settings');
  const activity = fs.readFileSync(path.join(root, 'apps/android/tv/src/main/java/com/wika/wicaby/tv/MainActivity.kt'), 'utf8');
  assert.match(activity, /is Route\.Files -> .*FilesFolderScreen\(route\.sourceId, route\.id, route\.name\)/, 'tv: a folder is a route of its own');
}

// The screen saver is registered as a DreamService the system may bind.
const manifest = fs.readFileSync(path.join(root, 'apps/android/tv/src/main/AndroidManifest.xml'), 'utf8');
const dream = /<service[^>]*android:name="\.Dream"[\s\S]*?<\/service>/.exec(manifest)?.[0];
assert.ok(dream, 'tv manifest: no .Dream service');
assert.match(dream, /android:permission="android\.permission\.BIND_DREAM_SERVICE"/);
assert.match(dream, /android:exported="true"/);
assert.match(dream, /<action android:name="android\.service\.dreams\.DreamService"/);

function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function call(base, p, headers, init = {}) {
  const res = await fetch(base + p, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}

const videoTypes = new Set(['Movie', 'Series', 'Episode']);
function checkRows(flavour, nextUp, latest, saver) {
  assert.ok(nextUp.Items.length > 0, `${flavour}: Next Up is empty`);
  for (const ep of nextUp.Items) assert.equal(ep.Type, 'Episode', `${flavour}: Next Up lists ${ep.Type}`);
  assert.ok(Array.isArray(latest) && latest.length > 0, `${flavour}: Recently Added (no ParentId) is empty`);
  for (const it of latest) assert.ok(videoTypes.has(it.Type), `${flavour}: Recently Added lists ${it.Type}`);
  const dates = latest.map((x) => x.DateCreated ?? '');
  assert.deepEqual(dates, [...dates].sort().reverse(), `${flavour}: Recently Added is not newest first`);
  assert.ok(saver.Items.some((x) => x.BackdropImageTags?.length), `${flavour}: no backdrop for the screen saver`);
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));
  const saverQuery = 'IncludeItemTypes=Movie,Series&Recursive=true&SortBy=Random&Limit=40&ImageTypes=Backdrop';

  // Emby: per-user routes under /emby, X-Emby-Token.
  {
    const base = `http://127.0.0.1:${EMBY}/emby`;
    const login = await call(base, '/Users/AuthenticateByName', { 'X-Emby-Authorization': `Emby ${DEVICE}` }, { method: 'POST', body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
    assert.equal(login.status, 200, 'emby login');
    const h = { 'X-Emby-Token': login.body.AccessToken };
    const uid = login.body.User.Id;
    const nextUp = await call(base, `/Shows/NextUp?UserId=${uid}&Limit=20`, h);
    const latest = await call(base, `/Users/${uid}/Items/Latest?Limit=24`, h);
    const saver = await call(base, `/Users/${uid}/Items?${saverQuery}`, h);
    checkRows('emby', nextUp.body, latest.body, saver.body);
    const art = await fetch(`${base}/Items/${latest.body[0].Id}/Images/Primary?maxWidth=640`);
    assert.equal(art.status, 200, 'emby: channel artwork');
  }

  // Jellyfin 12: /Items/Latest?userId= and /Items?userId=; the obsolete per-user routes are gone.
  {
    const base = `http://127.0.0.1:${JELLYFIN}`;
    const login = await call(base, '/Users/AuthenticateByName', { Authorization: `MediaBrowser ${DEVICE}` }, { method: 'POST', body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
    assert.equal(login.status, 200, 'jellyfin login');
    const h = { Authorization: `MediaBrowser ${DEVICE}, Token="${login.body.AccessToken}"` };
    const uid = login.body.User.Id;
    const nextUp = await call(base, `/Shows/NextUp?UserId=${uid}&Limit=20`, h);
    const latest = await call(base, `/Items/Latest?userId=${uid}&Limit=24`, h);
    const saver = await call(base, `/Items?userId=${uid}&${saverQuery}`, h);
    checkRows('jellyfin', nextUp.body, latest.body, saver.body);
    // Api.latest falls back to this route for Jellyfin < 10.9: on 12 it must answer 404, not data.
    assert.equal((await call(base, `/Users/${uid}/Items/Latest?Limit=24`, h)).status, 404, 'jellyfin: legacy Latest route');
  }
  console.log('tv-home-check: OK (manifest, Emby and Jellyfin channel and screen saver routes)');
} finally {
  for (const c of children) c.kill();
}
