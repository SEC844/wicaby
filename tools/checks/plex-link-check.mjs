// Plex account link, Home users and connection choice on desktop (plex-spec §5, PX-04 and PX-05), through the real
// ConnectionManager (bundled for Node, Electron stubbed) against tools/mock-server/mock-plex.mjs on loopback: never
// plex.tv, never a real server.
// - link with a code: the PIN, then the servers plex.tv lists (owned and shared, players left out);
// - the account token is seen only by the plex.tv mock, never by a PMS (/Mock/State.tokens), and no token in a URL;
// - D-3: a plain-http LAN address gets no token until the user confirms it;
// - a protected Home user needs a PIN, a wrong PIN is a clear error, and a PIN changed upstream asks again;
// - D-10: a shared server can be hidden, and stays hidden after a restart;
// - a restart with plex.tv down still lists the servers and signs in from the cache;
// - PX-05: local wins in under 1 s; with local down, remote then relay (the "relay" route); lastGood heads its wave;
//   with httpsRequired and only http listed, not one http call reaches the PMS.
// Usage: node tools/checks/plex-link-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_TOKEN, MACHINE_ID, SECOND_ID, startMockPlex } from '../mock-server/mock-plex.mjs';
import { bundlePlex, identity, quiet, refused } from './plex-bundle.mjs';

const F = await bundlePlex();
let n = 0;
const ok = (c, msg) => (assert.ok(c, msg), n++);
const ports = { port: 0, tvPort: 0, relayPort: 0, secondPort: 0 };
const start = (env = {}) => quiet(() => startMockPlex({ ...ports, env: { MOCK_PLEX_SECOND: '1', MOCK_PLEX_TLS: '0', ...env } }));
const sessionOf = (cm, id) => cm.session.sessions.find((s) => s.server.id === id);
const OWNER = 'a1b2c3d4e5f60718';
const ADO = 'b2c3d4e5f6071829';
const profile = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plexlink-'));
  return { dir, vault: await F.CredentialVault.open(path.join(dir, 'vault.bin')) };
};
const restart = async (dir) => {
  const vault = await F.CredentialVault.open(path.join(dir, 'vault.bin'));
  return new F.ConnectionManager(path.join(dir, 'servers.json'), vault, identity);
};
const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
};

const mock = await start();
process.env.WICABY_PLEXTV_BASE = mock.plextv;
try {
  await quiet(async () => {
    const { dir, vault } = await profile();
    let cm = new F.ConnectionManager(path.join(dir, 'servers.json'), vault, identity);

    // ---- Link with a code ----
    const pin = await cm.plexLink();
    ok(/^[A-Z0-9]{4}$/.test(pin.code) && pin.url === `https://plex.tv/link?code=${pin.code}`, 'a 4-character code and its plex.tv/link URL (the QR code)');
    ok((await cm.plexPoll()).status === 'waiting', 'waiting until the code is entered');
    await fetch(`${mock.plextv}/Mock/Pin/Link?code=${pin.code}`, { method: 'POST' });
    const linked = await until('linked', async () => {
      const r = await cm.plexPoll();
      return r.status === 'linked' && r;
    });
    const names = linked.servers.map((s) => s.name).sort();
    ok(names.join() === 'Chez Léa,Maison', `servers listed, the player left out (${names})`);
    const maison = linked.servers.find((s) => s.id === MACHINE_ID);
    const lea = linked.servers.find((s) => s.id === SECOND_ID);
    ok(maison.kind === 'plex' && maison.plex.owned && !lea.plex.owned && lea.plex.source === 'Léa', 'owned, and shared by Léa');
    ok(cm.plexAccounts()[0]?.id === OWNER && cm.plexAccounts()[0]?.pass === true, 'the account and its Plex Pass');
    const subs = cm.plexSubtitles(MACHINE_ID);
    ok(subs?.mode === 'foreign' && subs.language === 'fr', `the account's subtitle mode and language seed a Plex play (§6.4: ${JSON.stringify(subs)})`);
    ok(linked.servers.every((s) => !s.hasToken), 'a Home with several users: no server token before someone is picked');
    ok((await cm.plexPoll()).status === 'expired', 'the PIN is used once');

    // D-3 also covers .lan / .home.arpa names (answered by the current network's DNS); a public http one is vouched.
    const lanNames = { connections: [{ uri: 'http://nas.lan:32400' }, { uri: 'http://plex.home.arpa:32400' }, { uri: 'http://203.0.113.7:32400' }] };
    ok(cm.plexOrigins(lanNames).join() === 'http://203.0.113.7:32400', `.lan and .home.arpa are not vouched (${cm.plexOrigins(lanNames)})`);
    ok(cm.plexHttpLan({ plex: lanNames }, 'http://nas.lan:32400') === 'http://nas.lan:32400', 'a .lan address asks first');

    // ---- D-3, then who is watching ----
    let st = await cm.select(MACHINE_ID);
    const local = sessionOf(cm, MACHINE_ID);
    ok(local.status === 'server-selected' && local.confirm === mock.pms, `local http wins and asks for confirmation (${local.confirm})`);
    ok(mock.state.tokens.pms.length === 0, 'no token sent to the http LAN address before the user agrees');
    st = await cm.plexConfirm(MACHINE_ID, local.confirm);
    ok(sessionOf(cm, MACHINE_ID).status === 'server-selected' && !sessionOf(cm, MACHINE_ID).confirm, 'confirmed: on to the profile picker');
    const users = await cm.publicUsers(MACHINE_ID);
    ok(users.length === 3 && users.find((u) => u.id === ADO)?.hasPassword === true && users.find((u) => u.id === OWNER)?.hasPassword === false, 'the Home users, the protected one flagged');
    await assert.rejects(cm.login('Ado', '0000', MACHINE_ID), /PIN/, 'a wrong PIN is a clear error');
    ok(mock.state.switches.at(-1)?.ok === false, 'plex.tv refused the wrong PIN');
    await assert.rejects(cm.login('Ado', '', MACHINE_ID), /PIN/, 'a protected user is never picked without a PIN');
    st = await cm.login('Ado', '1234', MACHINE_ID);
    const ado = sessionOf(cm, MACHINE_ID);
    ok(ado.status === 'signed-in' && ado.user.name === 'Ado' && ado.user.isAdmin === false && ado.route === 'local', 'signed in as Ado, locally');
    ok(mock.state.tokens.pms.includes(mock.serverToken(ADO)), "the PMS got Ado's own server token");
    ok(!mock.state.tokens.pms.includes(ACCOUNT_TOKEN) && !mock.state.tokens.pms.some((t) => t.startsWith('mock-user-')), 'the account and user tokens never reach a PMS');
    ok(mock.state.tokens.plextv.includes(ACCOUNT_TOKEN), 'the account token goes to plex.tv');

    // ---- The shared server and the hide toggle (D-10) ----
    await cm.select(SECOND_ID);
    const leaAddr = sessionOf(cm, SECOND_ID).confirm;
    ok(!!leaAddr, 'the shared server asks for its http LAN address too');
    await cm.plexConfirm(SECOND_ID, leaAddr);
    ok(sessionOf(cm, SECOND_ID)?.status === 'signed-in', 'signed in on the shared server (the token plex.tv gave Ado for it)');
    const listed = cm.plexSetHidden(SECOND_ID, true);
    ok(listed.find((s) => s.id === SECOND_ID).plex.hidden === true && !sessionOf(cm, SECOND_ID), 'hidden: stays listed, leaves the session');

    // ---- A PIN changed upstream: the stored token is refused, the PIN is asked again (#553) ----
    await fetch(`${mock.plextv}/Mock/Home/SetPin?user=Ado&pin=5678`, { method: 'POST' });
    cm.disconnect(MACHINE_ID);
    await cm.select(MACHINE_ID);
    ok(sessionOf(cm, MACHINE_ID).status === 'server-selected', 'the old token answers 401: back to the profile picker');
    await assert.rejects(cm.login('Ado', '1234', MACHINE_ID), /PIN/, 'the old PIN no longer works');
    await cm.login('Ado', '5678', MACHINE_ID);
    ok(sessionOf(cm, MACHINE_ID).status === 'signed-in', 'the new PIN signs in again');

    // ---- Restart with plex.tv down: the cache serves ----
    // The old manager's sockets would reconnect (and race every cached address) once the mock closes: close them,
    // keeping the saved sessions on disk for the restart.
    cm.flush();
    const saved = fs.readFileSync(path.join(dir, 'servers.json'));
    cm.disconnect();
    cm.flush();
    fs.writeFileSync(path.join(dir, 'servers.json'), saved);
    await vault.flush();
    process.env.WICABY_PLEXTV_BASE = 'http://127.0.0.1:9';
    cm = await restart(dir);
    ok(cm.list().length === 2 && cm.list().find((s) => s.id === SECOND_ID).plex.hidden === true, 'restart, plex.tv down: both servers listed, the hidden one still hidden');
    await cm.resumeLastSession();
    ok(sessionOf(cm, MACHINE_ID)?.status === 'signed-in' && !sessionOf(cm, SECOND_ID), 'signed in from the cache; the hidden server is not resumed');

    // ---- PX-05: local down → remote, then relay ----
    cm.disconnect();
    cm.flush();
    await vault.flush();
    const file = path.join(dir, 'servers.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = doc.servers.find((s) => s.id === MACHINE_ID);
    const original = m.plex.connections;
    const dead = (port, local) => ({ protocol: 'http', address: '127.0.0.1', port, uri: `http://127.0.0.1:${port}`, local, relay: false });
    m.plex.connections = [dead(9, true), dead(7, false), { protocol: 'http', address: '127.0.0.1', uri: mock.relay, local: false, relay: true }];
    doc.activeIds = [MACHINE_ID];
    fs.writeFileSync(file, JSON.stringify(doc));
    cm = await restart(dir);
    await cm.select(MACHINE_ID);
    const viaRelay = sessionOf(cm, MACHINE_ID);
    ok(viaRelay.confirm === mock.relay, 'local and remote down: the relay answers');
    await cm.plexConfirm(MACHINE_ID, mock.relay);
    ok(sessionOf(cm, MACHINE_ID).status === 'signed-in' && sessionOf(cm, MACHINE_ID).route === 'relay', 'signed in through the relay, shown as such');
    cm.disconnect();
    cm.flush();
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).servers.find((s) => s.id === MACHINE_ID);
    ok(after.lastAddress === mock.relay, 'the relay is the last good address');
    after.plex.connections = original;
    const ranked = F.rankConnections(after.plex.connections.concat([{ uri: mock.relay, protocol: 'http', address: '127.0.0.1', relay: true }]), { lastGood: after.lastAddress, subnets: ['127.0.0.0/8'] });
    ok(ranked.waves[2][0] === mock.relay && ranked.waves[0][0] === mock.pms, 'lastGood heads its wave after a restart; a relay never jumps ahead of local');
    const doc2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc2.servers.find((s) => s.id === MACHINE_ID).plex.connections = original;
    doc2.activeIds = [MACHINE_ID];
    fs.writeFileSync(file, JSON.stringify(doc2));
    await vault.flush();
    // A timing race (local has a 600 ms head start): on a loaded machine one cold attempt can lose it, so a second
    // attempt is allowed; both are reported.
    const tries = [];
    for (let i = 0; i < 2 && !tries.some((x) => x.won); i++) {
      if (i) cm.disconnect();
      cm = await restart(dir);
      const t0 = Date.now();
      await cm.select(MACHINE_ID);
      const ms = Date.now() - t0;
      const back = sessionOf(cm, MACHINE_ID);
      tries.push({ won: back.status === 'signed-in' && back.address === mock.pms && ms < 1000, text: `${back.status} at ${back.address === mock.pms ? 'local' : back.address} in ${ms} ms` });
    }
    ok(tries.some((x) => x.won), `local up again: local wins in under 1 s (${tries.map((x) => x.text).join('; ')})`);
    cm.disconnect();

    ok(!mock.state.tags.some((t) => ['TOKEN-IN-URL', 'ACCOUNT-TOKEN-ON-PMS', 'NO-CLIENT-ID', 'UNMAPPED'].includes(t)), `no Plezy tag (${[...new Set(mock.state.tags)]})`);
  });
} finally {
  await mock.close();
}

// ---- httpsRequired with only http listed: not one http call reaches the PMS (#929) ----
const strict = await start({ MOCK_PLEX_HTTPS_REQUIRED: '1', MOCK_PLEX_SECOND: '0' });
process.env.WICABY_PLEXTV_BASE = strict.plextv;
try {
  await quiet(async () => {
    const { dir, vault } = await profile();
    const cm = new F.ConnectionManager(path.join(dir, 'servers.json'), vault, identity);
    const pin = await cm.plexLink();
    await fetch(`${strict.plextv}/Mock/Pin/Link?code=${pin.code}`, { method: 'POST' });
    await until('linked', async () => (await cm.plexPoll()).status === 'linked');
    await assert.rejects(cm.select(MACHINE_ID), /https/, 'httpsRequired and no https address: the reason, not just offline');
    ok(strict.state.calls.length === 0 && !strict.state.tags.includes('HTTP-REFUSED'), 'no http request reached the PMS');
  });
} finally {
  await strict.close();
}

ok(refused.length === 0, `nothing left loopback (refused: ${refused})`);
console.log(`plex-link-check: ok (${n} assertions)`);
// Sockets of the managers built above may still be retrying the closed mock.
process.exit(0);
