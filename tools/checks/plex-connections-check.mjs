// Plex connection choice (plex-spec §5.3, PX-05), the pure half: rankConnections() against the shared vectors in
// fixtures/plex/connections.json (the Android port replays them), and raceWaves() with a fake probe and short
// delays: local wins at once, a dead local hands over to remote then relay, a pending local blocks remote and relay, a wave starts early once everything
// before it failed, and all-dead rejects. No network. The mock half is plex-link-check.mjs.
// Usage: node tools/checks/plex-connections-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const C = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../apps/desktop/src/shared/plex/connections.ts')).href);
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'plex', 'connections.json'), 'utf8'));

let n = 0;
for (const c of fixture.cases) {
  assert.deepEqual(JSON.parse(JSON.stringify(C.rankConnections(c.connections, c.options))), c.out, c.name);
  n++;
}
assert.ok(C.inSubnet('10.0.0.200', '10.0.0.0/24') && !C.inSubnet('10.0.1.1', '10.0.0.0/24') && C.inSubnet('1.2.3.4', '0.0.0.0/0') && !C.inSubnet('x', '10.0.0.0/8'), 'inSubnet');

// ---- raceWaves ----
const DELAYS = [0, 60, 150];
const fake = (table) => {
  const started = [];
  const probe = (uri) => {
    started.push(uri);
    const [ms, okay] = table[uri];
    return new Promise((res, rej) => setTimeout(() => (okay ? res(uri) : rej(new Error('down'))), ms));
  };
  return { started, probe };
};
const t0 = () => performance.now();

{
  const f = fake({ local: [5, true], remote: [5, true], relay: [5, true] });
  const s = t0();
  const r = await C.raceWaves([['local'], ['remote'], ['relay']], f.probe, DELAYS);
  assert.equal(r.uri, 'local', 'local up: local wins');
  assert.ok(performance.now() - s < 55 && !f.started.includes('remote'), 'local up: wins before the remote wave starts');
}
{
  const f = fake({ local: [100, false], remote: [5, true], relay: [5, true] });
  const r = await C.raceWaves([['local'], ['remote'], ['relay']], f.probe, DELAYS);
  assert.equal(r.uri, 'remote', 'local slow and down: the remote answer (ready since its delay) wins once local failed');
  assert.ok(!f.started.includes('relay'), 'the relay was not needed');
}
{
  const f = fake({ local: [5, false], remote: [5, false], relay: [5, true] });
  const s = t0();
  const r = await C.raceWaves([['local'], ['remote'], ['relay']], f.probe, DELAYS);
  assert.equal(r.uri, 'relay', 'local and remote down: the relay');
  assert.ok(performance.now() - s < 140, 'each wave starts as soon as everything before it failed');
  assert.deepEqual(f.started, ['local', 'remote', 'relay'], 'in order');
}
{
  const f = fake({ a: [5, false], b: [5, false] });
  await assert.rejects(C.raceWaves([['a'], [], ['b']], f.probe, DELAYS), /unreachable/, 'all down rejects');
  await assert.rejects(C.raceWaves([[], [], []], f.probe, DELAYS), /no candidate/, 'nothing to try rejects');
}
{
  // Inside a wave rank decides, not speed: a slower https beats a faster http (no needless D-3 prompt).
  const f = fake({ https: [40, true], http: [5, true] });
  assert.equal((await C.raceWaves([['https', 'http']], f.probe, DELAYS)).uri, 'https', 'https beats a faster http');
  assert.deepEqual(f.started, ['https', 'http'], 'both raced at once');
}
{
  // Through the real ranking: one local https plex.direct and one local http, http answering first.
  const { waves } = C.rankConnections(
    [
      { uri: 'http://192.168.1.5:32400', protocol: 'http', address: '192.168.1.5', local: true },
      { uri: 'https://192-168-1-5.abc.plex.direct:32400', protocol: 'https', address: '192.168.1.5', local: true },
    ],
    { subnets: ['192.168.1.0/24'] },
  );
  const f = fake({ 'http://192.168.1.5:32400': [5, true], 'https://192-168-1-5.abc.plex.direct:32400': [40, true] });
  assert.equal((await C.raceWaves(waves, f.probe, DELAYS)).uri, 'https://192-168-1-5.abc.plex.direct:32400', 'ranked https wins the race');
}
{
  // lastGood wins over a faster candidate of its wave.
  const f = fake({ last: [30, true], other: [5, true] });
  assert.equal((await C.raceWaves([['last', 'other']], f.probe, DELAYS)).uri, 'last', 'lastGood first');
}
{
  // A better-ranked failure hands over to the next answer of its wave at once.
  const f = fake({ https: [20, false], http: [5, true] });
  const s = t0();
  assert.equal((await C.raceWaves([['https', 'http']], f.probe, DELAYS)).uri, 'http', 'https down: http');
  assert.ok(performance.now() - s < 55 && !f.started.includes('remote'), 'without waiting for the next wave');
}

{
  // §1.3/§5.3: home https hangs (plex.direct DNS rebind) until its timeout while home http answers at once; the
  // remote and relay answers that come in meanwhile must not win: home http does, when https gives up.
  const f = fake({ https: [250, false], http: [5, true], rhttps: [5, true], relay: [5, true] });
  const s = t0();
  assert.equal((await C.raceWaves([['https', 'http'], ['rhttps'], ['relay']], f.probe, DELAYS)).uri, 'http', 'a pending local holds back remote and relay');
  assert.ok(performance.now() - s >= 240 && f.started.includes('relay'), 'remote and relay answered first, yet lost');
  const g = fake({ https: [250, false], http: [5, true], relay: [5, true] });
  assert.equal((await C.raceWaves([['https', 'http'], [], ['relay']], g.probe, DELAYS)).uri, 'http', 'no remote: home http, not the relay');
}
{
  // A local that only hangs and then fails: the remote answer already in hand wins at that moment, not later.
  const f = fake({ https: [250, false], rhttps: [5, true] });
  const s = t0();
  assert.equal((await C.raceWaves([['https'], ['rhttps']], f.probe, DELAYS)).uri, 'rhttps', 'local gone: remote');
  assert.ok(performance.now() - s < 300, 'right after the local timeout');
}

console.log(`plex-connections-check: ok (${n} ranking vectors, 11 race cases)`);
