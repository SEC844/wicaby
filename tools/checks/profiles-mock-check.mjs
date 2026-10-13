// "Who is watching?" (TP-10, Android TV LoginScreen; desktop Login.svelte) against the Emby and Jellyfin mocks:
// /Users/Public lists several users with their avatars (the disabled guest stays hidden), each signs in with its
// password or none, and a saved token is checked with GET /Users/{id} (401 once refused: the TV asks the password).
// Usage: node tools/checks/profiles-mock-check.mjs   (starts mock-emby and mock-jellyfin on 8962/8963, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const EMBY = 8962;
const JELLYFIN = 8963;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="profiles-check", Version="0"';

function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function call(base, p, headers = {}, init = {}) {
  const res = await fetch(base + p, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
}

async function flavour(name, base, authHeader, tokenHeader, views, avatar) {
  const pub = await call(base, '/Users/Public');
  assert.equal(pub.status, 200, `${name}: /Users/Public`);
  const names = pub.body.map((u) => u.Name);
  assert.ok(pub.body.length >= 3, `${name}: several public users (got ${names})`);
  for (const n of ['Wika', 'Léa', 'Marc']) assert.ok(names.includes(n), `${name}: ${n} is public`);
  assert.ok(!names.includes('Invité'), `${name}: the disabled guest stays hidden`);
  assert.equal(pub.body.find((u) => u.Name === 'Marc').HasPassword, false, `${name}: Marc has no password`);
  const lea = pub.body.find((u) => u.Name === 'Léa');
  assert.equal(lea.HasPassword, true, `${name}: Léa has a password`);
  assert.ok(lea.PrimaryImageTag, `${name}: Léa has an avatar`);

  const login = (Username, Pw) => call(base, '/Users/AuthenticateByName', authHeader, { method: 'POST', body: JSON.stringify({ Username, Pw }) });
  assert.equal((await login('Léa', 'nope')).status, 401, `${name}: wrong password refused`);
  assert.equal((await login('Wika', 'wicaby')).status, 200, `${name}: Wika still signs in`);
  const marc = await login('Marc', '');
  assert.equal(marc.status, 200, `${name}: passwordless sign-in`);
  assert.equal(marc.body.User.Id, 'u-marc');
  const r = await login('Léa', 'wicaby');
  assert.equal(r.status, 200, `${name}: Léa signs in`);
  assert.equal(r.body.User.Id, lea.Id, `${name}: the token is Léa's`);

  // The TV's check before reusing a saved token, then her home.
  const me = await call(base, `/Users/${lea.Id}`, tokenHeader(r.body.AccessToken));
  assert.equal(me.status, 200, `${name}: GET /Users/{id} with her token`);
  assert.equal(me.body.Name, 'Léa');
  assert.equal((await call(base, `/Users/${lea.Id}`, tokenHeader('revoked'))).status, 401, `${name}: a refused token answers 401`);
  const v = await call(base, views(lea.Id), tokenHeader(r.body.AccessToken));
  assert.equal(v.status, 200, `${name}: her libraries`);
  assert.ok(v.body.Items.length > 0, `${name}: her libraries are not empty`);
  const img = await fetch(base + avatar(lea.Id, lea.PrimaryImageTag));
  assert.equal(img.status, 200, `${name}: her avatar`);
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));
  await flavour(
    'emby', `http://127.0.0.1:${EMBY}/emby`, { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }),
    (id) => `/Users/${id}/Views`, (id, tag) => `/Users/${id}/Images/Primary?tag=${tag}&maxHeight=240`,
  );
  // Jellyfin 10.9+: /UserViews?userId= and /UserImage?userId= (core Api.views, Api.userImage).
  await flavour(
    'jellyfin', `http://127.0.0.1:${JELLYFIN}`, { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }),
    (id) => `/UserViews?userId=${id}`, (id, tag) => `/UserImage?userId=${id}&tag=${tag}&maxHeight=240`,
  );
  console.log('profiles-mock-check: public users, profile sign-in and saved-token check OK on Emby and Jellyfin');
} finally {
  for (const c of children) c.kill();
}
