// X-05: copies the one source of the track-memory golden vectors to the Kotlin test resources.
// Run after editing fixtures/track/track-fixtures.json: node tools/checks/sync-track-fixtures.mjs
// (track-check.mjs fails while the copy differs).
import fs from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, 'fixtures', 'track', 'track-fixtures.json');
const dst = path.join(import.meta.dirname, '..', '..', 'apps', 'android', 'core', 'src', 'test', 'resources', 'track-fixtures.json');
fs.copyFileSync(src, dst);
console.log(`copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dst)}`);
