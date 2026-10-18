// Downloads the pinned Chromium builds of scripts/engines.mjs and checks the MD5 published with each snapshot.
// Usage: npm run engines [-- <major> ...]   (default: every engine)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINES, engineDir, engineExe } from './engines.mjs';

const BUCKET = 'https://www.googleapis.com/storage/v1/b/chromium-browser-snapshots/o/';

const wanted = process.argv.slice(2).map(Number);
for (const major of wanted.length ? wanted : Object.keys(ENGINES).map(Number)) {
  const engine = ENGINES[major];
  if (!engine) throw new Error(`unknown engine ${major}; known: ${Object.keys(ENGINES).join(', ')}`);
  if (fs.existsSync(engineExe(major))) {
    console.log(`Chromium ${major}: present`);
    continue;
  }
  const meta = await fetch(BUCKET + encodeURIComponent(`Win_x64/${engine.position}/chrome-win32.zip`)).then((r) => r.json());
  if (!meta.md5Hash) throw new Error(`Chromium ${major}: snapshot ${engine.position} not found`);
  const zip = Buffer.from(await fetch(meta.mediaLink).then((r) => r.arrayBuffer()));
  const md5 = crypto.createHash('md5').update(zip).digest('base64');
  if (md5 !== meta.md5Hash) throw new Error(`Chromium ${major}: MD5 mismatch (${md5}, expected ${meta.md5Hash})`);
  fs.mkdirSync(engineDir(major), { recursive: true });
  const file = path.join(engineDir(major), 'chrome-win32.zip');
  fs.writeFileSync(file, zip);
  // Windows' own bsdtar reads ZIP; Git's GNU tar (often first in PATH) takes "C:" for a remote host.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', file, '-C', engineDir(major)]);
  fs.rmSync(file);
  const version = fs.readdirSync(path.dirname(engineExe(major))).find((f) => /^\d+\.\d+\.\d+\.\d+\.manifest$/.test(f));
  console.log(`Chromium ${major}: ${version?.replace('.manifest', '') ?? '?'} (${engine.why})`);
}
