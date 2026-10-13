// Self-check for the desktop hardening: log redaction and line flattening (core/log.ts),
// route id validation (renderer/lib/route-params.ts), the HDR helper arguments
// (playback/hdr.ts) and the Electron fuses flipped at packaging (build/afterPack.mjs).
// Run: node tools/checks/desktop-hardening-check.mjs
import assert from 'node:assert/strict';
import { oneLine, redact } from '../../apps/desktop/src/main/core/log.ts';
import { isDisplayDevice, parseHdrReply, psQuote } from '../../apps/desktop/src/main/playback/hdr.ts';
import { isRouteId, isServerId, parseRouteParams } from '../../apps/desktop/src/renderer/lib/route-params.ts';

// ---- Log redaction ----
const SECRET = 'a1b2c3d4e5f6';
const leaks = [
  `GET http://srv:8096/emby/Items?api_key=${SECRET}&Fields=x`,
  `GET http://srv:8096/Videos/1/stream?ApiKey=${SECRET}`,
  `X-Emby-Token: ${SECRET}`,
  `token=${SECRET}`,
  `Token: ${SECRET}`,
  `Authorization: MediaBrowser Client="Wicaby", Device="PC", DeviceId="x", Version="1", Token="${SECRET}"`,
  `Authorization: Bearer ${SECRET}`,
  `DELETE http://srv:8096/emby/Auth/Keys/${SECRET} failed`,
  `{"AccessToken":"${SECRET}","User":{"Name":"me"}}`,
  `{"accessToken":"${SECRET}"}`,
  `{"Pw":"${SECRET}"}`,
  // Verifier bypasses: JSON-serialized MediaBrowser headers, quoted / spaced values,
  // case variants, percent-encoding, escaped quotes inside JSON values.
  JSON.stringify({ headers: { Authorization: `MediaBrowser Client="W", Token="${SECRET}"` } }),
  JSON.stringify({ headers: { 'X-Emby-Authorization': `MediaBrowser Client="W", Token="${SECRET}"` } }),
  JSON.stringify({ msg: `MediaBrowser Client="W", Token="${SECRET}"` }),
  JSON.stringify(JSON.stringify({ AccessToken: SECRET })),
  `token="${SECRET}"`,
  `Token = "${SECRET}"`,
  `token='${SECRET}'`,
  `apikey=${SECRET}`,
  `API_KEY=${SECRET}`,
  `Api_Key=${SECRET}`,
  `api-key: ${SECRET}`,
  `x-mediabrowser-token: ${SECRET}`,
  `X-EMBY-TOKEN ${SECRET}`,
  `GET /auth/keys/${SECRET}`,
  `GET /AUTH/KEYS/${SECRET}/x`,
  `url=http%3A%2F%2Fsrv%2FItems%3Fapi_key%3D${SECRET}%26x%3D1`,
  `url=http%253A%252F%252Fsrv%252FItems%253Fapi_key%253D${SECRET}`,
  `next=%2FAuth%2FKeys%2F${SECRET}%3Fx`,
  `authorization=${SECRET}`,
  `Token\t${SECRET}`,
  `{"Pw":"a\\"${SECRET}"}`,
  `{"Pw":"a\\\\\\"${SECRET}"}`,
  `{"Password":"${SECRET}`,
  `token="unterminated ${SECRET}`,
  `token="a\\"${SECRET}"`,
];
for (const line of leaks) {
  const out = redact(line);
  assert.ok(!out.includes(SECRET), `secret survived: ${out}`);
  assert.ok(out.includes('***'), `no marker: ${out}`);
}
assert.equal(redact('GET /Items?api_key=abc&Fields=x'), 'GET /Items?api_key=***&Fields=x');
assert.equal(redact('DELETE /Auth/Keys/abc?x=1'), 'DELETE /Auth/Keys/***?x=1');
assert.equal(redact(redact('token=abc')), 'token=***');
assert.equal(redact('playback started for item 1234'), 'playback started for item 1234');
// Prose keeps its words: a bare space after "token" is not a key/value separator.
for (const prose of [
  'srv: stored token rejected, sign-in required',
  'http://a proved to be server x over https, token bound to it',
  'srv: no address bound to the stored token answered, trying the others without it',
  'token rejected by srv, signing out',
  '401 on GET /Users (token still valid)',
  'Authorization header missing',
]) assert.equal(redact(prose), prose);
// Shapes are kept, redaction is idempotent.
assert.equal(redact('Token="abc", Client="W"'), 'Token="***", Client="W"');
assert.equal(redact('Authorization: MediaBrowser Client="W", Token="abc"'), 'Authorization: MediaBrowser Client="W", Token="***"');
assert.equal(redact('Authorization: Bearer abc'), 'Authorization: Bearer ***');
assert.equal(redact('Authorization: MediaBrowser'), 'Authorization: ***');
assert.equal(redact('Authorization: MediaBrowser abc'), 'Authorization: MediaBrowser ***');
for (const l of [`Authorization: Emby ${SECRET}`, `authorization: Basic "${SECRET}"`, `Authorization=${SECRET} x=1`, `token=${SECRET} x=1`]) {
  assert.ok(!redact(l).includes(SECRET), `secret survived: ${redact(l)}`);
}
assert.equal(redact('a?ApiKey=abc&b=1'), 'a?ApiKey=***&b=1');
assert.equal(redact('/auth/keys/abc?x=1'), '/auth/keys/***?x=1');
assert.equal(redact('{"AccessToken":"abc","User":"me"}'), '{"AccessToken":"***","User":"me"}');
assert.equal(redact('{"Pw":"a\\"b","User":"me"}'), '{"Pw":"***","User":"me"}');
assert.equal(redact('x%3Fapi_key%3Dabc%26y%3D1'), 'x%3Fapi_key%3D***%26y%3D1');
// Renderer text is attacker-shaped: no quadratic backtracking on long runs.
{
  const BS = '\\';
  const t0 = performance.now();
  for (const s of [
    'token=' + BS.repeat(100000) + '"' + 'x'.repeat(100000),
    BS.repeat(100000) + 'x',
    'apikey' + ' '.repeat(100000),
    ('token=' + BS + '"').repeat(30000),
    '{"Pw":"'.repeat(30000),
  ]) redact(s);
  assert.ok(performance.now() - t0 < 2000, `redact too slow: ${performance.now() - t0}ms`);
}
for (const s of ['Token=\\"abc\\"', 'token="abc"', '{"Pw":"x"}', 'X-Emby-Token: abc', '/Auth/Keys/abc']) {
  assert.equal(redact(redact(s)), redact(s));
}

// Renderer messages cannot forge log entries.
assert.equal(oneLine('boom\r\n2026-01-01T00:00:00Z ERROR [main] forged'), 'boom 2026-01-01T00:00:00Z ERROR [main] forged');
assert.equal(oneLine('a\nb\rc'), 'a b c');

// ---- Router ids ----
assert.ok(isRouteId('12345'));
assert.ok(isRouteId('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
assert.ok(isRouteId('a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90'));
assert.ok(!isRouteId(''));
assert.ok(!isRouteId('../../Users'));
assert.ok(!isRouteId('1?api_key=x'));
assert.ok(!isRouteId('a'.repeat(65)));
// File source ids (shared/files/ids.ts): 'p.' + base64url, never a dot segment or a slash.
assert.ok(isRouteId('p.') && isRouteId('p.RmlsbXM'));
assert.ok(!isRouteId('p..') && !isRouteId('p./x') && !isRouteId('p.a+b') && !isRouteId(`p.${'A'.repeat(1001)}`));
assert.ok(isServerId('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
assert.ok(!isServerId('srv/evil'));

assert.deepEqual(parseRouteParams(['item', 'abc123', '42']), { server: 'abc123', id: '42' });
assert.deepEqual(parseRouteParams(['library', '42']), { id: '42' });
assert.deepEqual(parseRouteParams(['login', 'abc123']), { id: 'abc123' });
assert.deepEqual(parseRouteParams(['admin', 'abc123', 'dashboard']), { server: 'abc123', id: 'dashboard' });
assert.deepEqual(parseRouteParams(['home']), {});
assert.deepEqual(parseRouteParams([]), {});
assert.equal(parseRouteParams(['item', 'abc123', '..%2F..%2FUsers']), null);
assert.equal(parseRouteParams(['item', 'abc%2F123', '42']), null);
assert.equal(parseRouteParams(['item', '%E0%A4%A']), null);
assert.equal(parseRouteParams(['item', 'abc', '42', 'extra']), null);
assert.equal(parseRouteParams(['read', '42%3Fx%3D1']), null);

// ---- HDR helper ----
assert.ok(isDisplayDevice('\\\\.\\DISPLAY1'));
assert.ok(isDisplayDevice('\\\\.\\DISPLAY12'));
assert.ok(!isDisplayDevice("\\\\.\\DISPLAY1' ; calc ; '"));
assert.ok(!isDisplayDevice('\\\\.\\DISPLAY1\nstate'));
assert.ok(!isDisplayDevice('DISPLAY1'));
assert.ok(!isDisplayDevice(42));
assert.equal(psQuote('\\\\.\\DISPLAY1'), "'\\\\.\\DISPLAY1'");
assert.equal(psQuote("a'b"), "'a''b'");
assert.equal(psQuote('a’b'), "'a''b'");
// Whole reply only: an extra line can no longer smuggle a matching reply.
assert.equal(parseHdrReply('junk\nstate \\\\.\\DISPLAY1 1 0'), null);
assert.equal(parseHdrReply('state \\\\.\\DISPLAY1 1 0\nkeep \\\\.\\DISPLAY2 1 1'), null);
assert.deepEqual(parseHdrReply('state \\\\.\\DISPLAY1 1 0\r\n'), { verb: 'state', device: '\\\\.\\DISPLAY1', supported: true, on: false });

// ---- Electron fuses ----
const { FUSES } = await import('../../apps/desktop/build/afterPack.mjs');
const { FuseV1Options } = await import('@electron/fuses');
assert.equal(FUSES[FuseV1Options.RunAsNode], false);
assert.equal(FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
assert.equal(FUSES[FuseV1Options.EnableNodeCliInspectArguments], false);
assert.equal(FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
assert.equal(FUSES[FuseV1Options.OnlyLoadAppFromAsar], true);

// ---- IPC listeners return nothing ----
// contextBridge clones a listener's return value back into the preload; `(x) => (state = x)` returns the
// Svelte $state proxy, which throws "An object could not be cloned." So an arrow listener has a block or `void` body.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(import.meta.dirname, '../../apps/desktop/src/renderer');
  const bad = [];
  for (const f of fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(ts|svelte)$/.test(f))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const m = /\bw\.[\w.]+\.on[A-Z]\w*\(\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(.)/.exec(line);
      if (m && m[1] !== '{' && !/=>\s*void /.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `IPC listeners with an expression body: ${bad.join(', ')}`);
}

// ---- Dev-only VPN fixture (onboarding spec OB-D4) ----
// A packaged build never reads WICABY_VPN_FIXTURE, and main hands it the real isPackaged.
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { vpnFixture } = await import('../../apps/desktop/src/main/vpn/fixture.ts');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-fixture-')), 'vpn.json');
  fs.writeFileSync(file, JSON.stringify({ status: [{ kind: 'embedded', state: 'connected', ips: ['192.0.2.10'] }] }));
  assert.equal(vpnFixture(file, true), null);
  assert.equal(vpnFixture(undefined, false), null);
  assert.equal(vpnFixture(file, false)().status[0].state, 'connected');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../../apps/desktop/src/main/index.ts'), 'utf8');
  assert.match(main, /vpnFixture\(process\.env\.WICABY_VPN_FIXTURE, app\.isPackaged\)/);
  assert.equal((main.match(/WICABY_VPN_FIXTURE/g) ?? []).length, 1, 'main reads WICABY_VPN_FIXTURE in one place');
}

// ---- Server address caution (first-run setup, public card) ----
{
  const { plainHttpToPublic } = await import('../../apps/desktop/src/renderer/lib/address.ts');
  for (const a of ['http://media.example.com', 'http://203.0.113.5:8096', 'HTTP://example.org/emby', 'http://[2001:db8::1]:8096']) assert.ok(plainHttpToPublic(a), a);
  for (const a of ['https://media.example.com', 'media.example.com', 'http://127.0.0.1:8096', 'http://192.168.1.20:8096', 'http://10.0.0.2', 'http://172.20.0.3', 'http://100.64.0.7:8096', 'http://nas:8096', 'http://nas.local:8096', 'http://[fd7a::1]:8096', 'http://[::1]', 'http://', ''])
    assert.ok(!plainHttpToPublic(a), a);
}

console.log('desktop-hardening-check: ok');
