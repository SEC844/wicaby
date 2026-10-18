// Self-check for the Tailscale / NetBird status parsers and the address
// classifier, against sample `status --json` outputs. No VPN client needed.
// Usage: node tools/checks/vpn-selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The desktop app's sources live in apps/desktop.
const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-vpn-')), 'vpn-clients.mjs');
// Electron stub: i18n reads app (never ready here, so French) and api-client uses net.fetch.
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const net = { fetch: globalThis.fetch }; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' };` }));
  },
};
await build({ entryPoints: [path.join(root, 'src/main/vpn/vpn-clients.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const m = await import(pathToFileURL(out).href);
// The facade, with Electron stubbed out (only api-client's net.fetch uses it).
const facadeOut = path.join(path.dirname(out), 'vpn-index.mjs');
await build({
  entryPoints: [path.join(root, 'src/main/vpn/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: facadeOut,
  logLevel: 'error',
  plugins: [electronStub],
});
const { VpnService } = await import(pathToFileURL(facadeOut).href);

// Shapes from ipnstate.Status (tailscale status --json).
const tailscale = {
  Version: '1.80.2-t1234',
  BackendState: 'Running',
  AuthURL: '',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  Self: { HostName: 'DESKTOP-WIKA', DNSName: 'desktop-wika.tail1234.ts.net.', OS: 'windows', UserID: 42, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], Online: true },
  MagicDNSSuffix: 'tail1234.ts.net',
  CurrentTailnet: { Name: 'wika@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
  Peer: {
    'nodekey:aaa': {
      HostName: 'nas',
      DNSName: 'nas.tail1234.ts.net.',
      OS: 'linux',
      TailscaleIPs: ['100.90.1.2', 'fd7a:115c:a1e0::2'],
      Online: true,
      Addrs: ['203.0.113.7:41641', '192.0.2.10:41641'],
      CurAddr: '192.0.2.10:41641',
    },
    'nodekey:bbb': { HostName: 'phone', DNSName: 'phone.tail1234.ts.net.', OS: 'iOS', TailscaleIPs: ['100.90.1.3'], Online: false, Addrs: null },
    'nodekey:ccc': { HostName: 'se-sto-wg-001.mullvad.ts.net', DNSName: 'se-sto-wg-001.mullvad.ts.net.', TailscaleIPs: ['100.120.0.1'], Online: true },
  },
  User: { 42: { ID: 42, LoginName: 'wika@example.com', DisplayName: 'Wika' } },
};

const ts = m.parseTailscale(JSON.stringify(tailscale));
assert.equal(ts.status.state, 'connected');
assert.equal(ts.status.selfName, 'DESKTOP-WIKA');
assert.equal(ts.status.selfDnsName, 'desktop-wika.tail1234.ts.net');
assert.equal(ts.status.dnsSuffix, 'tail1234.ts.net');
assert.deepEqual(ts.status.ips, ['100.101.102.103', 'fd7a:115c:a1e0::1']);
assert.equal(ts.peers.length, 2, 'mullvad exit node filtered');
const nas = ts.peers.find((p) => p.name === 'nas');
assert.equal(nas.dnsName, 'nas.tail1234.ts.net');
assert.equal(nas.online, true);
assert.ok(nas.endpoints.includes('192.0.2.10'));
assert.equal(ts.peers.find((p) => p.name === 'phone').online, false);

const needsLogin = m.parseTailscale(JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc123', Self: {}, Peer: null, TailscaleIPs: null }));
assert.equal(needsLogin.status.state, 'needs-login');
assert.equal(needsLogin.status.authUrl, 'https://login.tailscale.com/a/abc123');
assert.deepEqual(needsLogin.peers, []);
assert.equal(m.parseTailscale(JSON.stringify({ BackendState: 'Stopped' })).status.state, 'stopped');

// Shapes from client/status OutputOverview (netbird status --json).
const netbird = {
  peers: {
    total: 2,
    connected: 1,
    details: [
      { fqdn: 'media.netbird.cloud', netbirdIp: '100.92.10.5', publicKey: 'x', status: 'Connected', connectionType: 'P2P', iceCandidateEndpoint: { local: '10.0.0.2:51820', remote: '192.0.2.10:51820' } },
      { fqdn: 'laptop.netbird.cloud', netbirdIp: '100.92.10.6', publicKey: 'y', status: 'Idle', connectionType: '', iceCandidateEndpoint: { local: '', remote: '' } },
    ],
  },
  cliVersion: '0.36.0',
  daemonVersion: '0.36.0',
  daemonStatus: 'Connected',
  management: { url: 'https://api.netbird.io:443', connected: true, error: '' },
  signal: { url: 'https://signal.netbird.io:443', connected: true, error: '' },
  netbirdIp: '100.92.10.4/16',
  publicKey: 'z',
  usesKernelInterface: false,
  fqdn: 'desktop-wika.netbird.cloud',
  lazyConnectionEnabled: false,
};
const nb = m.parseNetbird(JSON.stringify(netbird));
assert.equal(nb.status.state, 'connected');
assert.equal(nb.status.selfName, 'desktop-wika');
assert.equal(nb.status.dnsSuffix, 'netbird.cloud');
assert.deepEqual(nb.status.ips, ['100.92.10.4']);
assert.equal(nb.peers[0].name, 'media');
assert.equal(nb.peers[0].online, true);
assert.deepEqual(nb.peers[0].endpoints, ['192.0.2.10']);
assert.equal(nb.peers[1].online, false);
assert.equal(m.parseNetbird(JSON.stringify({ ...netbird, lazyConnectionEnabled: true })).peers[1].online, true);
assert.equal(m.parseNetbird(JSON.stringify({ ...netbird, daemonStatus: 'NeedsLogin', management: { connected: false } })).status.state, 'needs-login');
assert.equal(m.parseNetbird(JSON.stringify({ ...netbird, daemonStatus: undefined, management: { connected: false } })).status.state, 'stopped');

assert.equal(m.isCgnat('100.64.0.1'), true);
assert.equal(m.isCgnat('100.127.255.254'), true);
assert.equal(m.isCgnat('100.128.0.1'), false);
assert.equal(m.isCgnat('100.63.255.255'), false);
assert.equal(m.isCgnat('192.0.2.10'), false);
assert.equal(m.classifyAddress('nas.tail1234.ts.net'), 'tailscale');
assert.equal(m.classifyAddress('fd7a:115c:a1e0::2'), 'tailscale');
assert.equal(m.classifyAddress('media.netbird.cloud'), 'netbird');
assert.equal(m.classifyAddress('box.netbird.selfhosted.'), 'netbird');
assert.equal(m.classifyAddress('100.90.1.2'), 'tailscale');
assert.equal(m.classifyAddress('192.0.2.10'), undefined);
assert.equal(m.classifyAddress('emby.example.fr'), undefined);

assert.equal(m.findLoginUrl('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c\n\n'), 'https://login.tailscale.com/a/1a2b3c');
assert.equal(
  m.findLoginUrl("Please do the SSO login in your browser.\nIf your browser didn't open automatically, use this URL to log in:\n\nhttps://login.netbird.io/activate?user_code=ABCD-EFGH\n"),
  'https://login.netbird.io/activate?user_code=ABCD-EFGH',
);
assert.equal(m.findLoginUrl('Connected'), undefined);

// Facade: server matching against fake providers.
const fake = (kind, state, peers) => ({ kind, status: async () => ({ kind, state, ips: [] }), connect: async () => ({ status: { kind, state, ips: [] } }), peers: async () => peers });
const vpn = new VpnService(() => {});
vpn.installed = [fake('tailscale', 'connected', ts.peers), fake('netbird', 'stopped', nb.peers)];
// Known by LAN IP only: matched through the peer's endpoints.
const addrs = (c) => c.map((x) => x.address);
assert.deepEqual(addrs(await vpn.candidatesFor({ name: 'Emby maison', addresses: ['http://192.0.2.10:8096'] })), ['http://100.90.1.2:8096', 'http://nas.tail1234.ts.net:8096']);
// Trusted only when the peer carries a host the token is bound to (here its LAN endpoint), never by name alone.
assert.ok((await vpn.candidatesFor({ name: 'Emby maison', addresses: ['http://192.0.2.10:8096'], trusted: ['http://192.0.2.10:8096'] })).every((x) => x.trusted));
// Matched by server name = host name, custom port kept.
assert.deepEqual(addrs(await vpn.candidatesFor({ name: 'NAS', addresses: ['https://emby.example.fr:8920'] })), ['http://100.90.1.2:8920', 'http://nas.tail1234.ts.net:8920']);
assert.ok((await vpn.candidatesFor({ name: 'NAS', addresses: ['https://emby.example.fr:8920'], trusted: ['https://emby.example.fr:8920'] })).every((x) => !x.trusted), 'a name match is not trusted');
// Offline peer, or a network that is not connected: nothing.
assert.deepEqual(await vpn.candidatesFor({ name: 'phone', addresses: [] }), []);
assert.deepEqual(await vpn.candidatesFor({ name: 'media', addresses: [] }), []);
assert.equal(vpn.networkOf('http://nas.tail1234.ts.net:8096'), 'tailscale');
assert.equal(vpn.networkOf('http://[fd7a:115c:a1e0::2]:8096'), 'tailscale');
assert.equal(vpn.networkOf('http://192.0.2.10:8096'), undefined);
const embedded = fake('embedded', 'connected', []);
vpn.setEmbedded(embedded);
assert.deepEqual((await vpn.status()).map((s) => s.kind), ['tailscale', 'netbird', 'embedded']);

// Finding the installed CLI: tailscale.exe under Program Files then PATH on Windows; tailscale on PATH elsewhere.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-vpn-bin-'));
  const pf = path.join(dir, 'pf');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(pf, 'Tailscale'), { recursive: true });
  fs.mkdirSync(bin);
  const winEnv = { ProgramFiles: pf, PATH: bin };
  // Linux PATH entries are ':'-separated: relative to the temp folder, so a Windows host (C:\...) can run it too.
  const cwd = process.cwd();
  process.chdir(dir);
  const linuxEnv = { PATH: '/nonexistent:bin' };
  assert.equal(m.locate('tailscale', ['Tailscale'], 'win32', winEnv), null);
  assert.equal(m.locate('zz-wicaby-none', ['Tailscale'], 'linux', linuxEnv), null);
  fs.writeFileSync(path.join(bin, 'tailscale'), '');
  assert.equal(m.locate('tailscale', ['Tailscale'], 'win32', winEnv), null, 'Windows only runs tailscale.exe');
  assert.equal(m.locate('tailscale', ['Tailscale'], 'linux', linuxEnv), 'bin/tailscale');
  fs.writeFileSync(path.join(bin, 'tailscale.exe'), '');
  assert.equal(m.locate('tailscale', ['Tailscale'], 'win32', winEnv), path.join(bin, 'tailscale.exe'));
  fs.writeFileSync(path.join(pf, 'Tailscale', 'tailscale.exe'), '');
  assert.equal(m.locate('tailscale', ['Tailscale'], 'win32', winEnv), path.join(pf, 'Tailscale', 'tailscale.exe'), 'Program Files first');
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}

// `up` refused: on Linux, the operator hint (Tailscale) or root (NetBird); Windows keeps its own message.
{
  const denied = "Access denied: prefs write access denied\n\nUse 'sudo tailscale up' or 'sudo tailscale set --operator=$USER' to not require root.";
  assert.match(m.upError(denied, 'tailscale', 'linux'), /sudo tailscale set --operator=\$USER/);
  assert.match(m.upError('connect: permission denied', 'netbird', 'linux'), /sudo netbird up/);
  assert.doesNotMatch(m.upError(denied, 'tailscale', 'win32'), /--operator/);
  assert.match(m.upError('Access is denied.', 'tailscale', 'win32'), /administrateur/);
}

// Diagnostics redaction: the fixture core's DiagnosticsTest runs too, so both sides mask alike.
{
  const diagOut = path.join(path.dirname(out), 'diagnostics.mjs');
  await build({ entryPoints: [path.join(root, 'src/main/vpn/diagnostics.ts')], bundle: true, platform: 'node', format: 'esm', outfile: diagOut, logLevel: 'error', plugins: [electronStub] });
  const { redactDiagnostics } = await import(pathToFileURL(diagOut).href);
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'diagnostics-redact.json'), 'utf8'));
  for (const c of fixture.cases) assert.equal(redactDiagnostics(c.input, c.names), c.expected, c.name);
}

// vpn.diagnostics() (Remote access pane): peers counted, never probed; no address, key or name left in clear.
{
  const fx = {
    status: [
      { kind: 'tailscale', state: 'not-installed', ips: [] },
      {
        kind: 'embedded',
        provider: 'netbird',
        state: 'connected',
        selfName: 'wicaby-desk',
        selfDnsName: 'wicaby-desk.netbird.example',
        ips: ['100.64.0.10'],
        managementUrl: 'https://netbird.example.com',
        routes: ['192.0.2.0/24'],
        lastError: { message: 'management: 401 for key 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', at: Date.UTC(2026, 9, 12, 14, 3) },
      },
    ],
    peers: { embedded: [{ kind: 'embedded', name: 'nas', ips: ['100.64.0.11'], online: true, servers: [] }, { kind: 'embedded', name: 'phone', ips: ['100.64.0.12'], online: false, servers: [] }] },
    log: ['dial 192.0.2.7:443 for nas.netbird.example with tskey-auth-abc123'],
  };
  const svc = new VpnService(() => undefined, () => fx);
  const text = await svc.diagnostics('9.9.9', 'win32');
  assert.match(text, /^Wicaby 9\.9\.9 \(desktop, win32\) · \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  assert.match(text, /provider: netbird \(embedded\) · state: connected · management: https:\/\/<host>/);
  assert.match(text, /peers: 2 \(1 online\)/);
  assert.match(text, /routes: 192\.0\.\*\.\*\/24/);
  assert.match(text, /last error \(2026-10-12T14:03Z\): management: 401 for key \*\*\*/);
  assert.doesNotMatch(text, /100\.64\.0\.|192\.0\.2\.|0a1b2c3d|tskey-auth|abc123|wicaby-desk|\bnas\b|netbird\.example/);
  assert.doesNotMatch(text, /tailscale/);
  // Listing the pane's devices does not probe them.
  assert.deepEqual((await svc.peers('embedded', false)).map((p) => [p.name, p.servers.length]), [['nas', 0], ['phone', 0]]);
}

console.log('vpn self-check: ok');
