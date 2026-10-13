// Builds the wicaby-mesh helper (packages/mesh, Go) into vendor/vpn-helper with the
// licence texts of everything linked into it. electron-builder bundles that folder as
// resources/vpn-helper, and Wicaby also finds it there in development.
//
// Usage: npm run build:mesh   (from the repo root; builds for this machine)
//        GOOS=linux GOARCH=amd64 npm run build:mesh   (cross-compiles; go test is skipped)
//        node packages/mesh/scripts/build-vpn-helper.mjs --out <dir>   (another target folder)
// Needs Go (winget install -e --id GoLang.Go, or the distribution's golang package). go.mod
// pins the toolchain; Go downloads it on first build if the installed one is older.
// A windows target writes the same files as the former build-vpn-helper.ps1 (CRLF, UTF-8 BOM).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const fail = (msg) => {
  console.error(`build-vpn-helper: ${msg}`);
  process.exit(1);
};

// packages/mesh/scripts -> packages/mesh (Go module) and the repo root (vendor/).
const src = path.resolve(import.meta.dirname, '..');
const root = path.resolve(src, '..', '..');
const outAt = process.argv.indexOf('--out');
const target = outAt > 0 && process.argv[outAt + 1] ? path.resolve(process.argv[outAt + 1]) : path.join(root, 'vendor', 'vpn-helper');

const winGo = 'C:\\Program Files\\Go\\bin\\go.exe';
const goBin = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return 'go';
  } catch {
    if (process.platform === 'win32' && fs.existsSync(winGo)) return winGo;
    return fail('Go not found. Install it with: winget install -e --id GoLang.Go (Windows) or your distribution’s golang package');
  }
})();

// GOOS/GOARCH come from the environment, as for any go command. CGO stays off for the build and
// the dependency listings (a pure Go binary), as the PowerShell script did.
const noCgo = { ...process.env, CGO_ENABLED: '0' };
const go = (args, env = noCgo) => {
  try {
    return execFileSync(goBin, args, { cwd: src, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    return fail(`go ${args.join(' ')} failed`);
  }
};
const [goos, goarch, hostOs, hostArch, goroot, goversion] = go(['env', 'GOOS', 'GOARCH', 'GOHOSTOS', 'GOHOSTARCH', 'GOROOT', 'GOVERSION']).split(/\r?\n/).map((s) => s.trim());

if (goos === hostOs && goarch === hostArch) {
  console.log('Testing the forwarder allow-list');
  try {
    execFileSync(goBin, ['test', './mesh/'], { cwd: src, stdio: 'inherit' });
  } catch {
    fail('go test failed');
  }
} else {
  console.log(`Cross-compiling for ${goos}/${goarch}: go test ./mesh/ skipped (it runs on a ${goos} build machine)`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const exe = path.join(target, goos === 'windows' ? 'wicaby-mesh.exe' : 'wicaby-mesh');
console.log(`Building ${exe}`);
go(['build', '-trimpath', '-ldflags', '-s -w', '-o', exe, './cmd/wicaby-mesh']);

// BSD/MIT/Apache notices must ship with the binary: one file with every linked module's licence.
console.log('Collecting licences');
const fmt = '{{with .Module}}{{if .Replace}}{{.Replace.Path}} {{.Replace.Version}}|{{.Replace.Dir}}{{else}}{{.Path}} {{.Version}}|{{.Dir}}{{end}}{{end}}';
// PowerShell's Sort-Object order (culture compare, '-' and "'" ignored), so the Windows file is unchanged.
const collator = new Intl.Collator('en', { sensitivity: 'accent' });
const psOrder = (a, b) => collator.compare(a.replace(/[-']/g, ''), b.replace(/[-']/g, '')) || collator.compare(a, b);
const mods = [...new Set(go(['list', '-deps', '-f', fmt, './cmd/wicaby-mesh']).split(/\r?\n/).filter((l) => l && !l.startsWith('wicaby/')))].sort(psOrder);

const NL = goos === 'windows' ? '\r\n' : '\n';
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
let out = `wicaby-mesh is built from packages/mesh (Wicaby) and the following open source components.${NL}${NL}`;
out += `==== Go standard library ${goversion}${NL}${NL}`;
out += readText(path.join(goroot, 'LICENSE')) + NL;
const missing = [];
for (const m of mods) {
  const [name, dir] = m.split(/\|(.*)/s);
  // Directory order as NTFS lists it (case-insensitive), whatever the file system.
  const files = dir && fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /^(LICEN[CS]E|COPYING|NOTICE|PATENTS)/i.test(e.name)).map((e) => e.name).sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
    : [];
  if (!files.length) {
    missing.push(name);
    continue;
  }
  out += `==== ${name}${NL}${NL}`;
  for (const f of files) {
    const text = readText(path.join(dir, f));
    // Judge by the title only: MPL-2.0 also mentions the GPL in its body. NetBird's
    // notice names its AGPL directories, which the package check below covers.
    if (!name.toLowerCase().startsWith('github.com/netbirdio/netbird ') && /GNU (Affero |Lesser )?General Public License/i.test(text.slice(0, 400))) fail(`${name} is (A/L)GPL licensed`);
    out += text + NL;
  }
}
// NetBird keeps AGPL code in management/, signal/, relay/ and combined/; none may be linked here.
// List first, filter second: a failing `go list` must stop the build, not read as "no hits".
const deps = go(['list', '-deps', './cmd/wicaby-mesh']).split(/\r?\n/).filter(Boolean);
if (!deps.length) fail('go list returned no packages for ./cmd/wicaby-mesh');
const agpl = deps.filter((d) => /github\.com\/netbirdio\/netbird\/(management|signal|relay|combined)(\/|$)/i.test(d));
if (agpl.length) fail(`AGPL NetBird packages linked: ${agpl.join(', ')}`);
// Set-Content -Encoding utf8 (Windows PowerShell) wrote a BOM and a final newline.
fs.writeFileSync(path.join(target, 'THIRD_PARTY_LICENSES.txt'), (goos === 'windows' ? '\uFEFF' : '') + out + NL);
if (missing.length) console.warn(`WARNING: No licence file found for: ${missing.join(', ')}`);

console.log(`OK: ${exe} (${(fs.statSync(exe).size / 1024 ** 2).toFixed(1)} MB), ${mods.length} modules`);
