// Capability flags (file-sources-spec §2.2, FS-00): apps/desktop/src/shared/server-caps.ts caps(kind) must equal
// fixtures/server-caps.json row for row (the Android ServerCapsTest reads the same file), and kindLabel() names
// every kind. Usage: node tools/checks/caps-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-caps-')), 'caps.mjs');
await build({ entryPoints: [path.join(repo, 'apps/desktop/src/shared/server-caps.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error' });
const { caps, kindLabel } = await import(pathToFileURL(out).href);
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'server-caps.json'), 'utf8'));
const kinds = Object.keys(fixture).filter((k) => !k.startsWith('$'));
assert.deepEqual(kinds.sort(), ['emby', 'files', 'jellyfin', 'navidrome', 'plex']);
for (const k of kinds) assert.deepEqual(caps(k), fixture[k], `caps(${k})`);
// An unknown kind (a newer settings file, a missing session) gets the row the fixture names, on both platforms.
for (const k of ['unknown', '', undefined]) assert.deepEqual(caps(k), fixture[fixture.$unknownKind], `caps(${k})`);
assert.equal(kindLabel('emby'), 'Emby');
assert.equal(kindLabel('jellyfin'), 'Jellyfin');
assert.equal(kindLabel('plex'), 'Plex');
assert.equal(kindLabel('navidrome'), 'Navidrome');
assert.equal(kindLabel('files', 'Fichiers'), 'Fichiers');
console.log(`caps-check: ok (${kinds.length} kinds × ${Object.keys(fixture.emby).length} flags)`);
