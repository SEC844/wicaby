// Quick Connect sign-in on the Jellyfin mock, the wire steps every app follows (Android core Api.quickConnect, desktop
// ConnectionManager.quickConnect, TV web app Api.quickConnect; the client logic itself is QuickConnectTest.kt):
// Enabled, an anonymous Initiate as this device, Connect pending, the approving side's Authorize (Settings > Accounts,
// with the user token), Connect authenticated, AuthenticateWithQuickConnect for a token bound to this device, the
// secret spent after one use and an unknown one 404 (the apps then start a fresh code). MOCK_QC=0: Enabled false.
// Usage: node tools/checks/quick-connect-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

async function mock(port, env = {}) {
  const p = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-jellyfin.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  await new Promise((resolve, reject) => {
    p.on('exit', (code) => reject(new Error(`mock-jellyfin exited (${code}): is port ${port} taken?`)));
    p.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve());
  });
  return p;
}

const device = (id, token) => ({ 'Content-Type': 'application/json', Authorization: `MediaBrowser Client="Wicaby", Device="TV", DeviceId="${id}", Version="1"${token ? `, Token="${token}"` : ''}` });

const PORT = 8967;
let jf = await mock(PORT);
try {
  const base = `http://127.0.0.1:${PORT}`;
  const tv = device('qc-check-tv');
  assert.equal(await (await fetch(`${base}/QuickConnect/Enabled`)).json(), true, 'Enabled');

  const init = await (await fetch(`${base}/QuickConnect/Initiate`, { method: 'POST', headers: tv })).json();
  assert.match(init.Code, /^\d{6}$/, 'a 6-digit code');
  assert.ok(init.Secret, 'a secret');
  const poll = async () => (await fetch(`${base}/QuickConnect/Connect?secret=${init.Secret}`, { headers: tv })).json();
  assert.equal((await poll()).Authenticated, false, 'pending until approved');
  assert.equal((await fetch(`${base}/Users/AuthenticateWithQuickConnect`, { method: 'POST', headers: tv, body: JSON.stringify({ Secret: init.Secret }) })).status, 401, 'no token before approval');

  // The approving side: a signed-in device types the code.
  const phone = await (await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: device('qc-check-phone'), body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) })).json();
  assert.equal((await fetch(`${base}/QuickConnect/Authorize?code=${init.Code}`, { method: 'POST', headers: device('qc-check-phone') })).status, 401, 'Authorize needs a signed-in user');
  assert.equal((await fetch(`${base}/QuickConnect/Authorize?code=000000`, { method: 'POST', headers: device('qc-check-phone', phone.AccessToken) })).status, 404, 'an unknown code: 404');
  assert.equal((await fetch(`${base}/QuickConnect/Authorize?code=${init.Code}`, { method: 'POST', headers: device('qc-check-phone', phone.AccessToken) })).status, 200, 'Authorize');
  assert.equal((await poll()).Authenticated, true, 'approved');

  const auth = await fetch(`${base}/Users/AuthenticateWithQuickConnect`, { method: 'POST', headers: tv, body: JSON.stringify({ Secret: init.Secret }) });
  assert.equal(auth.status, 200, 'AuthenticateWithQuickConnect');
  const r = await auth.json();
  assert.equal(r.User.Name, 'Wika', "signed in as the approver's user");
  const me = await fetch(`${base}/Users/Me`, { headers: device('qc-check-tv', r.AccessToken) });
  assert.equal(me.status, 200, 'the token works');
  assert.equal((await fetch(`${base}/QuickConnect/Connect?secret=${init.Secret}`, { headers: tv })).status, 404, 'the secret is spent: 404 (a fresh code next)');
} finally {
  jf.kill();
}

jf = await mock(PORT + 1, { MOCK_QC: '0' });
try {
  assert.equal(await (await fetch(`http://127.0.0.1:${PORT + 1}/QuickConnect/Enabled`)).json(), false, 'MOCK_QC=0: Enabled false, not offered');
} finally {
  jf.kill();
}
console.log('quick-connect-check: initiate, poll, authorize, sign-in, spent secret and Quick Connect off OK');
