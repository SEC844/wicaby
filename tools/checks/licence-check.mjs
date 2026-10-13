// Licence wording self-check (cast spec CA-00): one SPDX identifier for Wicaby's own code,
// GPL-3.0-or-later, and the section 7 Google Play services permission referenced where it applies.
// Usage: node tools/checks/licence-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);
// Split so this file never contains the identifier it greps for.
const ONLY = 'GPL-3.0-' + 'only';

// 1. The acceptance grep: every GPL-3.0 identifier in tracked files is -or-later. Third-party
//    rows of THIRD_PARTY_NOTICES.md may differ.
const hits = execFileSync('git', ['grep', '-nE', 'GPL-3\\.0-(only|or-later)'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const wrong = hits.filter((h) => /GPL-3\.0-only/.test(h)
  && !/^THIRD_PARTY_NOTICES\.md:\d+:\|/.test(h));
assert.deepEqual(wrong, [], `${ONLY} outside third-party rows:\n${wrong.join('\n')}`);
ok(`${hits.length} SPDX mentions, all GPL-3.0-or-later`);

// 2. Both READMEs name the same identifier and point to the exception.
for (const f of ['README.md', 'README.fr.md']) {
  const s = read(f);
  assert.ok(s.includes('GPL-3.0-or-later'), `${f} names GPL-3.0-or-later`);
  assert.doesNotMatch(s, /GPL-3\.0-only/, `${f} mentions ${ONLY}`);
  assert.ok(s.includes('(LICENSE-EXCEPTION.md)'), `${f} links LICENSE-EXCEPTION.md`);
}
ok('README.md and README.fr.md: GPL-3.0-or-later and the exception link');

// 3. The exception follows the FSF section 7 template, names Google Play services only, and
//    drops the braced Corresponding Source sentence (Play services ships no source).
const ex = read('LICENSE-EXCEPTION.md');
assert.match(ex, /Additional permission under GNU GPL version 3 section 7/);
assert.match(ex, /If you modify this Program, or any covered work, by linking or combining\s+it with the Google Play services Cast libraries/);
assert.match(ex, /the licensors of this Program grant you\s+additional permission to convey the resulting work\./);
assert.match(ex, /either version 3 of the License, or \(at your option\)\s+any later version/);
assert.doesNotMatch(ex, /Corresponding Source for a\s+non-source form/);
ok('LICENSE-EXCEPTION.md follows the FSF template for Google Play services');

// 4. Contributors accept the exception; the notices point to it.
assert.match(read('CONTRIBUTING.md'), /GPL-3\.0-or-later[\s\S]{0,300}\[LICENSE-EXCEPTION\.md\]\(LICENSE-EXCEPTION\.md\)/);
assert.ok(read('THIRD_PARTY_NOTICES.md').includes('(LICENSE-EXCEPTION.md)'));
ok('CONTRIBUTING.md and THIRD_PARTY_NOTICES.md reference the exception');

// 5. Photos spec §0 clean room: no Immich package (npm @immich/*, a Gradle "immich" artifact) and no AGPL dependency.
const agplOrImmich = (lock, gradle = '') => [
  ...Object.entries(lock.packages ?? {}).filter(([k, v]) => /(^|\/)@immich\//.test(k) || /AGPL/i.test(String(v.license ?? ''))).map(([k]) => k || '(root)'),
  ...(/immich/i.test(gradle) ? ['gradle: immich'] : []),
];
assert.deepEqual(agplOrImmich({ packages: { 'node_modules/@immich/sdk': { license: 'GNU AGPLv3' } } }), ['node_modules/@immich/sdk'], 'self-test: @immich/sdk caught');
assert.deepEqual(agplOrImmich({ packages: { 'node_modules/x': { license: 'AGPL-3.0' }, 'node_modules/y': { license: 'MIT' } } }), ['node_modules/x'], 'self-test: AGPL-3.0 caught');
assert.deepEqual(agplOrImmich({}, 'implementation("app.immich:sdk:1.0")'), ['gradle: immich'], 'self-test: a Gradle immich artifact caught');
const gradle = execFileSync('git', ['ls-files', '*.gradle.kts', '*.versions.toml'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map(read).join('\n');
assert.deepEqual(agplOrImmich(JSON.parse(read('package-lock.json')), gradle), [], 'Immich or AGPL dependency');
ok('no Immich package and no AGPL dependency (npm lockfile, Gradle)');

// 6. File sources §5.3 / FS-11: the SMB gateway links go-smb2 (BSD-2) and its geoffgarside/ber (BSD-3). The notices
//    name both, and the two generated licence files carry their texts (vendor/ is not tracked: checked when built).
const notices = read('THIRD_PARTY_NOTICES.md');
assert.match(notices, /\|\s*`github\.com\/hirochachacha\/go-smb2`\s*\|[^|\n]*\|\s*BSD-2-Clause\s*\|/, 'THIRD_PARTY_NOTICES.md: go-smb2 BSD-2-Clause');
assert.match(notices, /\|\s*`github\.com\/geoffgarside\/ber`\s*\|[^|\n]*\|\s*BSD-3-Clause\s*\|/, 'THIRD_PARTY_NOTICES.md: geoffgarside/ber BSD-3-Clause');
// One "==== module version" block: go-smb2's own, holding the BSD wording (never the next module's text).
const smbIn = (text) => text.split(/^==== /m).some((b) => b.startsWith('github.com/hirochachacha/go-smb2 ') && b.includes('Redistribution and use in source and binary forms'));
assert.ok(smbIn('==== github.com/hirochachacha/go-smb2 v1.1.0\n\nCopyright (c) 2016\n\nRedistribution and use in source and binary forms'), 'self-test: entry found');
assert.ok(!smbIn('==== github.com/hirochachacha/go-smb2 v1.1.0\n\n==== github.com/other/mod v1\n\nRedistribution and use in source and binary forms'), 'self-test: another module\'s text does not count');
const licFiles = ['vendor/vpn-helper/THIRD_PARTY_LICENSES.txt', 'vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt'].filter((f) => fs.existsSync(path.join(root, f)));
for (const f of licFiles) assert.ok(smbIn(read(f)), `${f}: no go-smb2 entry (rebuild with npm run build:mesh / build:mesh-aar)`);
ok(`go-smb2 (BSD-2) in THIRD_PARTY_NOTICES.md and ${licFiles.length} generated licence file(s)`);

// 7. Plex (plex-spec §1.2, PX-00, D-8): the "not affiliated" line in the desktop About texts (fr and en, shown by
//    AboutPane) and in the notices, with the owner's ToS reading still listed. Android joins with its Plex wave (PX-14).
const plexAbout = { en: /Plex is a trademark of Plex, Inc\. Wicaby is an unofficial client, not affiliated with or endorsed by Plex\./, fr: /Plex est une marque de Plex, Inc\. Wicaby est un client non officiel, sans lien avec Plex/ };
for (const [lang, re] of Object.entries(plexAbout)) assert.match(JSON.parse(read(`apps/desktop/src/renderer/locales/${lang}/plex.json`)).about.notAffiliated, re, `${lang}/plex.json: the not-affiliated line`);
assert.ok(read('apps/desktop/src/renderer/routes/settings/AboutPane.svelte').includes("t('plex.about.notAffiliated')"), 'AboutPane shows the not-affiliated line');
assert.match(notices, /## Plex\r?\n\r?\nPlex is a trademark of Plex, Inc\. Wicaby is an unofficial client, not affiliated with or endorsed by Plex\./, 'THIRD_PARTY_NOTICES.md: the Plex section');
assert.match(notices, /TODO\(owner\)[^]*plex\.tv Terms of Service/, 'THIRD_PARTY_NOTICES.md: the D-8 ToS reading is listed');
ok('Plex: not-affiliated line in About (fr, en) and the notices; D-8 TODO listed');

console.log(`licence-check: ${n} checks passed`);
