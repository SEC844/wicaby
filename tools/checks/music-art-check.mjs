// Music covers (music-feishin-navidrome spec §4.A, MU-A1 to MU-A5): the shared vectors through shared/music-art.ts
// (the Android side runs the same file in :core music/MusicArtTest.kt), the placeholder contrast at every hue, the
// lookup cache and its concurrency, then the owner's field bug on both mocks: an Emby album without a Primary whose
// tracks have their own art gets its first track's cover, an artist without an image its first album's (through that
// album's track when the album has none), an album with no art anywhere the placeholder; one lookup per item, none for
// items that have a Primary.
// Usage: node tools/checks/music-art-check.mjs   (starts both mocks with MOCK_MUSIC=1 on 8968/8969, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { coverResolver, dominantColour, hslRgb, initials, lookupQuery, musicArt, musicSize, nameHue } from '../../apps/desktop/src/shared/music-art.ts';

const root = path.resolve(import.meta.dirname, '../..');
const V = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'music', 'cover-vectors.json'), 'utf8'));

// ---- Vectors ----
for (const c of V.art) assert.deepEqual(musicArt(c.item), c.expect, c.name);
for (const c of V.queries) assert.deepEqual(Object.fromEntries(Object.entries(lookupQuery(c.kind, c.id, c.emby)).map(([k, v]) => [k, String(v)])), c.query, `${c.kind} emby=${c.emby}`);
for (const c of V.placeholder) assert.deepEqual({ initials: initials(c.name), hue: nameHue(c.name) }, { initials: c.initials, hue: c.hue }, `placeholder "${c.name}"`);
for (const c of V.tile) assert.deepEqual(hslRgb(c.hue), c.rgb, `tile hue ${c.hue}`);
for (const c of V.size) assert.equal(musicSize(c.css, c.dpr), c.px, `musicSize(${c.css}, ${c.dpr})`);
const pixels = (runs) => runs.flatMap(([r, g, b, a, n]) => Array.from({ length: n }, () => [r, g, b, a]).flat());
for (const c of V.colour) assert.equal(dominantColour(pixels(c.runs)), c.colour, `colour: ${c.name}`);

// ---- Placeholder contrast: white initials at 92 % over the tile, ≥ 4.5:1 at all 360 hues ----
const lum = ([r, g, b]) => [r, g, b].map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
let worst = Infinity;
for (let h = 0; h < 360; h++) {
  const bg = hslRgb(h);
  const ink = bg.map((v) => 0.92 * 255 + 0.08 * v);
  worst = Math.min(worst, (lum(ink) + 0.05) / (lum(bg) + 0.05));
}
assert.ok(worst >= 4.5, `placeholder contrast ${worst.toFixed(2)} ≥ 4.5 at every hue`);

// ---- Resolver: one lookup per item, negatives kept, failures asked again, at most 3 in flight ----
{
  let calls = 0;
  let peak = 0;
  let live = 0;
  let fail = true;
  const r = coverResolver(async (kind, item) => {
    calls++;
    peak = Math.max(peak, ++live);
    await new Promise((res) => setTimeout(res, 5));
    live--;
    if (item.Id === 'flaky' && fail) throw new Error('offline');
    if (item.Id.startsWith('artist')) return { Id: `of-${item.Id}`, Type: 'MusicAlbum' };
    return item.Id === 'empty' ? undefined : { Id: `t-${item.Id}`, Type: 'Audio', ImageTags: { Primary: 'x' } };
  });
  const albums = Array.from({ length: 10 }, (_, i) => ({ Id: `al${i}`, Type: 'MusicAlbum', ServerId: 's' }));
  const first = await Promise.all(albums.map((a) => r.resolve(a)));
  assert.deepEqual(first[3], { id: 't-al3', tag: 'x' }, 'an album borrows its first track cover');
  assert.ok(peak <= 3, `at most 3 lookups in flight (${peak})`);
  await Promise.all(albums.map((a) => r.resolve(a)));
  assert.equal(calls, 10, 'one lookup per album, the second visit from the cache');
  assert.deepEqual(await r.resolve({ Id: 'own', Type: 'MusicAlbum', ImageTags: { Primary: 'p' } }), { id: 'own', tag: 'p' });
  assert.equal(calls, 10, 'no lookup for an album that has a Primary');
  assert.equal(await r.resolve({ Id: 'empty', Type: 'MusicAlbum' }), null);
  assert.equal(await r.resolve({ Id: 'empty', Type: 'MusicAlbum' }), null);
  assert.equal(calls, 11, 'an album with nothing: asked once');
  assert.equal(await r.resolve({ Id: 'flaky', Type: 'MusicAlbum' }), null);
  fail = false;
  assert.deepEqual(await r.resolve({ Id: 'flaky', Type: 'MusicAlbum' }), { id: 't-flaky', tag: 'x' }, 'a failed lookup is asked again');
  assert.deepEqual(await r.resolve({ Id: 'artist-x', Type: 'MusicArtist' }), { id: 't-of-artist-x', tag: 'x' }, 'artist → first album → its first track');
  assert.equal(r.inFlight(), 0, 'every slot handed back');
}

// ---- The field bug on both mocks ----
const EMBY = 8968;
const JELLYFIN = 8969;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="music-art-check", Version="0"';
function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_MUSIC: '1' } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function flavour(name, base, login, tokenHeader, itemsPath) {
  const emby = name === 'emby';
  const res = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
  const { AccessToken, User } = await res.json();
  const items = async (query) => {
    const r = await fetch(`${base}${itemsPath(User.Id)}${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`, { headers: tokenHeader(AccessToken) });
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(query)}`);
    return (await r.json()).Items;
  };
  const albums = await items({ IncludeItemTypes: 'MusicAlbum', Recursive: true });
  const artists = await items({ IncludeItemTypes: 'MusicArtist', Recursive: true });
  const byName = (list, n) => list.find((x) => x.Name === n);
  // The mock reproduces the field: an album without a Primary whose tracks have theirs, artists without an image.
  const brume = byName(albums, 'Brume');
  assert.ok(!brume.ImageTags?.Primary, `${name}: Brume has no Primary`);
  const brumeTracks = await items({ ParentId: brume.Id, IncludeItemTypes: 'Audio', Recursive: true });
  assert.ok(brumeTracks.length && brumeTracks.every((t) => t.ImageTags?.Primary && !t.AlbumPrimaryImageTag), `${name}: its tracks have their own art`);
  assert.ok(artists.filter((a) => !a.ImageTags?.Primary).length >= 3, `${name}: artists without an image`);

  const asked = [];
  const r = coverResolver((kind, item) => (asked.push(item.Id), items(lookupQuery(kind, item.Id, emby)).then((x) => x[0])));
  const covers = new Map();
  for (const x of [...albums, ...artists, ...albums]) covers.set(x.Id, await r.resolve(x));
  assert.deepEqual(covers.get(brume.Id), { id: brumeTracks[0].Id, tag: brumeTracks[0].ImageTags.Primary }, `${name}: Brume shows its first track's cover (the field bug)`);
  assert.equal(covers.get(byName(albums, 'Trois vents').Id), null, `${name}: an album with no art anywhere: the placeholder`);
  const neon = byName(albums, 'Neon Avenue');
  assert.deepEqual(covers.get(byName(artists, 'Night Arcade').Id), { id: neon.Id, tag: neon.ImageTags.Primary }, `${name}: an artist without an image shows its first album`);
  assert.deepEqual(covers.get(byName(artists, 'Les Ondes Calmes').Id), covers.get(brume.Id), `${name}: newest album without a Primary → its track`);
  assert.equal(covers.get(byName(artists, 'Zéphyr Trio').Id), null, `${name}: artist whose album has nothing: the placeholder`);
  for (const a of albums.filter((x) => x.Name !== 'Trois vents')) assert.ok(covers.get(a.Id), `${name}: ${a.Name} has a cover`);
  const lookedUp = new Set(asked);
  assert.equal(lookedUp.size, asked.length, `${name}: one lookup per item across two visits`);
  for (const x of [...albums, ...artists]) if (x.ImageTags?.Primary) assert.ok(!lookedUp.has(x.Id), `${name}: no lookup for ${x.Name}, which has a Primary`);
  // Emby joins a name repeated in the query (checked on a real 4.10.1): Android 0.10.4's lookup named ImageTypeLimit
  // twice and every lookup answered 500. Jellyfin takes the first value.
  const twice = await fetch(`${base}${itemsPath(User.Id)}${new URLSearchParams(lookupQuery('firstTrack', brume.Id, emby))}&ImageTypeLimit=1`, { headers: tokenHeader(AccessToken) });
  assert.equal(twice.status, emby ? 500 : 200, `${name}: a number named twice in the query`);
  const img = await fetch(`${base}/Items/${brumeTracks[0].Id}/Images/Primary?tag=${brumeTracks[0].ImageTags.Primary}&maxWidth=480&maxHeight=480`);
  assert.equal(img.status, 200, `${name}: the borrowed cover is served`);
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));
  await flavour('emby', `http://127.0.0.1:${EMBY}/emby`, { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }), (id) => `/Users/${id}/Items?`);
  await flavour('jellyfin', `http://127.0.0.1:${JELLYFIN}`, { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }), (id) => `/Items?userId=${id}&`);
  console.log(`music-art-check: ${V.art.length} cover, ${V.placeholder.length} placeholder, ${V.size.length} size and ${V.colour.length} colour vectors, contrast ≥ 4.5 (${worst.toFixed(2)}), resolver cache and concurrency, and missing album and artist art on Emby and Jellyfin OK`);
} finally {
  for (const c of children) c.kill();
}
