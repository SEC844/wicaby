// Keeps the repository (tracked files and new ones not yet added, minus .gitignore) free of personal and setup
// details before it is published:
// owner wording, household room names, session links, private tooling and C2PA image metadata.
// Maintainer-specific identifiers (addresses, names, paths) live in the untracked .dev/privacy-patterns.json
// ({ "text": [[regex, label]], "binary": [substring] }) so the check never publishes what it guards.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
// Built from parts so this file never matches itself.
const j = (...p) => p.join('');
const rules = [
  // "the owner" alone is fine: windows have owners too.
  [j("\\bthe owner's (TV|server|network|PC|Emby|Sony)|\\b(user|owner)'s (Sony|Bravia|real server|real TV)"), 'owner wording'],
  [j('\\bSal', 'on\\b|\\bCham', 'bre\\b'), 'household room name'],
  [j('claude\\.ai/', 'code|Claude-', 'Session'), 'private session link'],
  [j('graph', 'ify'), 'private tooling'],
];
const binary = [[j('ca', 'BX'), 'C2PA metadata']];

const local = path.join(root, '.dev', 'privacy-patterns.json');
if (existsSync(local)) {
  const extra = JSON.parse(readFileSync(local, 'utf8'));
  for (const [re, why] of extra.text ?? []) rules.push([re, why]);
  for (const s of extra.binary ?? []) binary.push([s, 'a personal identifier']);
}

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];
for (const f of files) {
  if (f === 'tools/checks/privacy-check.mjs') continue;
  let buf;
  try {
    buf = readFileSync(path.join(root, f));
  } catch {
    continue; // deleted in the working tree
  }
  if (!buf.subarray(0, 8000).includes(0)) {
    buf.toString('utf8').split('\n').forEach((line, i) => {
      for (const [re, why] of rules) if (new RegExp(re).test(line)) hits.push(`${f}:${i + 1}: ${why}`);
    });
  } else {
    const s = buf.toString('latin1');
    for (const [b, why] of binary) if (s.includes(b)) hits.push(`${f}: binary contains ${why}`);
  }
}

if (hits.length) {
  console.error(`privacy-check: ${hits.length} problem(s)\n` + hits.join('\n'));
  process.exit(1);
}
console.log(`privacy-check: ok (${files.length} tracked and new files${existsSync(local) ? ', with local patterns' : ''})`);
