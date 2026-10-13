// Checks every relative link and image in the repo's Markdown files:
//   - [text](path), ![alt](path), [ref]: path, and HTML src= / href= / srcset=;
//   - the target file or folder must exist (relative to the Markdown file, or to
//     the repo root for a leading "/");
//   - a #fragment pointing at a Markdown file must match one of its headings
//     (GitHub slug rules) or an explicit <a id|name="…">.
// External links (http:, https:, mailto:, …) are not fetched. Links inside fenced
// code blocks and inline code are ignored; links inside HTML comments are checked too,
// so a commented-out image cannot hide a broken path.
// Every image in docs/screenshots/ must be referenced by at least one Markdown file,
// so unused screenshots don't pile up in the repository.
// Usage: node tools/checks/links-check.mjs [--verbose]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const verbose = process.argv.includes('--verbose');

// README images made by tools/screenshots; each one must be used somewhere.
const SCREENSHOTS = 'docs/screenshots';
const IMAGE_EXT = /.(png|jpe?g|webp|gif|avif|svg)$/i;

const SKIP_DIRS = new Set(['node_modules', '.git', '.dev', 'vendor', 'release', 'out', 'build', '.gradle', '.kotlin', '.idea']);

function markdownFiles() {
  try {
    // Tracked plus untracked-but-not-ignored files: what a commit would publish.
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((f) => f && !f.split('/').some((p) => SKIP_DIRS.has(p)) && fs.existsSync(path.join(root, f)));
  } catch {
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel);
        } else if (e.name.endsWith('.md')) found.push(rel);
      }
    };
    walk('');
    return found;
  }
}

// Replace fenced code blocks and (unless keepInline) inline code spans with spaces (keeps line numbers).
function stripCode(text, keepInline = false) {
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*(`+|~+)\s*$/.test(lines[i])) fence = null;
      lines[i] = '';
    } else if (m) {
      fence = m[1];
      lines[i] = '';
    } else if (!keepInline) {
      lines[i] = lines[i].replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (s) => ' '.repeat(s.length));
    }
  }
  return lines.join('\n');
}

// GitHub heading anchors: lowercase, drop punctuation except - and _, spaces to -, dedupe with -1, -2…
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = stripCode(fs.readFileSync(file, 'utf8'), true);
  const anchors = new Set();
  const seen = new Map();
  for (const line of text.split('\n')) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const plain = h[1]
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[*_~]/g, (c) => (c === '_' ? '_' : ''));
      let slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      if (n) slug = `${slug}-${n}`;
      anchors.add(slug);
    }
    for (const a of line.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(a[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function linksOf(text) {
  const out = [];
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  // Inline links and images; the target may be wrapped in <…> and followed by a "title".
  for (const m of text.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g))
    out.push({ target: m[1].replace(/^<|>$/g, ''), line: lineAt(m.index), image: m[0].startsWith('!') });
  // Reference definitions.
  for (const m of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm)) out.push({ target: m[1].replace(/^<|>$/g, ''), line: lineAt(m.index), image: false });
  // HTML attributes.
  for (const m of text.matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gi)) out.push({ target: m[2], line: lineAt(m.index), image: m[1].toLowerCase() === 'src' });
  for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi))
    for (const part of m[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.push({ target: url, line: lineAt(m.index), image: true });
    }
  return out;
}

const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');
const isPlaceholder = (t) => /[<>{}]/.test(t) || t.includes('…');

const files = markdownFiles().sort();
const broken = [];
const referenced = new Set();
let checked = 0;

for (const rel of files) {
  const abs = path.join(root, rel);
  const text = stripCode(fs.readFileSync(abs, 'utf8'));
  for (const { target, line, image } of linksOf(text)) {
    if (!target || isExternal(target) || isPlaceholder(target)) continue;
    checked++;
    const [beforeHash, fragment] = target.split('#', 2);
    const filePart = beforeHash.split('?')[0];
    let dest;
    try {
      dest = filePart ? decodeURIComponent(filePart) : '';
    } catch {
      dest = filePart;
    }
    const resolved = !dest ? abs : dest.startsWith('/') ? path.join(root, dest) : path.resolve(path.dirname(abs), dest);
    const repoRel = path.relative(root, resolved).split(path.sep).join('/');
    const where = `${rel}:${line}`;
    if (repoRel.startsWith('..')) {
      broken.push(`${where}: ${target} points outside the repository`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      broken.push(`${where}: ${image ? 'missing image' : 'broken link'} ${target}`);
      continue;
    }
    referenced.add(repoRel);
    if (fragment && resolved.endsWith('.md') && fs.statSync(resolved).isFile()) {
      let frag = fragment;
      try {
        frag = decodeURIComponent(fragment);
      } catch {}
      if (!anchorsOf(resolved).has(frag.toLowerCase()) && !anchorsOf(resolved).has(frag)) broken.push(`${where}: no heading #${fragment} in ${repoRel}`);
    }
    if (verbose) console.log(`ok   ${where} ${target}`);
  }
}

const shotsDir = path.join(root, SCREENSHOTS);
const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((n) => IMAGE_EXT.test(n)).sort() : [];
const unused = shots.map((n) => `${SCREENSHOTS}/${n}`).filter((p) => !referenced.has(p));
for (const u of unused) broken.push(`${u}: not referenced by any Markdown file (use it or delete it)`);

for (const b of broken) console.error(`FAIL ${b}`);
console.log(`links-check: ${files.length} Markdown files, ${checked} relative links, ${shots.length} screenshots (${unused.length} unused), ${broken.length} problem${broken.length === 1 ? "" : "s"}.`);
process.exit(broken.length ? 1 : 0);
