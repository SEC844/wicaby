// Builds the demo artwork for the mock server's MOCK_DATASET=demo mode:
//   1. downloads every image listed in ../sources.mjs (cached in the OS temp dir),
//   2. refuses anything that is not CC BY or CC0: Wikimedia Commons licence metadata is read live, and a
//      Commons "Restrictions" value (e.g. trademarked) fails the build unless sources.mjs acknowledges it;
//      for Blender Studio images the licence page (licenseSource) is re-read and must still contain
//      licenseQuote, and a Studio asset page is re-checked when an asset id is given,
//   3. crops and resizes with Chromium (the project's own Electron, no extra dependency):
//      posters 600x900, backdrops 1920x1080, JPEG,
//   4. writes ../ATTRIBUTION.json and ../ATTRIBUTION.md, with a BlurHash per image.
// Usage: node scripts/build-demo-assets.mjs [--refetch]   (re-launches itself under Electron)
//   ELECTRON_PATH=...           use another Electron binary
//   DEMO_ASSETS_CACHE=<dir>     download cache (default: <tmp>/wicaby-demo-assets-cache)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = process.env.DEMO_ASSETS_CACHE ?? path.join(os.tmpdir(), 'wicaby-demo-assets-cache');
const REFETCH = process.argv.includes('--refetch');
const UA = 'WicabyDemoAssets/1.0 (open-source media client; one-off fetch of CC BY Blender open movie artwork)';

if (!process.versions.electron) {
  const electronPath = process.env.ELECTRON_PATH ?? (await import('electron')).default;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = await import('electron');
const { FILMS, IMAGES, SIZES, JPEG_QUALITY } = await import(pathToFileURL(path.join(ROOT, 'sources.mjs')).href);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// Not awaited at top level: Electron holds 'ready' until the ESM entry finishes evaluating.
app.whenReady().then(() => main().then(() => app.exit(0), (e) => (console.error(e), app.exit(1))));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
// For quote checks: straight quotes and hyphens, no space before punctuation.
const plain = (s) => strip(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-').replace(/\s+([.,;:])/g, '$1');
// CC BY in any version/port, or CC0. No SA, ND or NC.
const ALLOWED = /^(CC BY \d\.\d( [a-z]{2})?|CC0( 1\.0)?)$/i;

async function get(url, type = 'text') {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return type === 'buffer' ? Buffer.from(await r.arrayBuffer()) : type === 'json' ? r.json() : r.text();
    if (attempt >= 7 || (r.status !== 429 && r.status < 500)) throw new Error(`HTTP ${r.status} for ${url}`);
    const wait = Math.min(120, Number(r.headers.get('retry-after')) || 10 * attempt);
    console.log(`  HTTP ${r.status}, retrying in ${wait} s`);
    await sleep(wait * 1000);
  }
}

// Commons: one API call per width class. Posters without a crop only need a 1280 px rendition;
// everything else asks for up to 3840 px (the API hands back the original when it is smaller).
async function commonsInfo(titles, width) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 40) {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    const params = { action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(width), iiextmetadatafilter: 'LicenseShortName|LicenseUrl|UsageTerms|Restrictions|Artist|Credit|Attribution|AttributionRequired', titles: titles.slice(i, i + 40).join('|') };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const j = await get(u, 'json');
    const norm = new Map((j.query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of j.query.pages) {
      const ii = p.imageinfo?.[0];
      if (!ii) throw new Error(`Commons file not found: ${p.title}`);
      const m = ii.extmetadata ?? {};
      const clean = (u) => u && u.split('?')[0];
      out.set(norm.get(p.title) ?? p.title, {
        title: p.title, page: ii.descriptionurl, original: clean(ii.url), download: clean(ii.thumburl ?? ii.url), width: ii.width, height: ii.height,
        license: strip(m.LicenseShortName?.value), licenseUrl: m.LicenseUrl?.value ?? null, usageTerms: strip(m.UsageTerms?.value) || null,
        // Commons "Restrictions": non-copyright restrictions such as trademarked, personality, insignia.
        restrictions: strip(m.Restrictions?.value).split(/[|,]/).map((r) => r.trim()).filter(Boolean),
        author: strip(m.Artist?.value), credit: strip(m.Credit?.value).replace(/\[\d+\]/g, '').trim(), attribution: strip(m.Attribution?.value) || null,
      });
    }
    await sleep(1500);
  }
  return out;
}

async function cached(key, url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, createHash('sha1').update(key).digest('hex').slice(0, 16) + (path.extname(new URL(url).pathname) || '.bin'));
  if (!REFETCH && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  console.log('  fetch', url.split('?')[0]);
  fs.writeFileSync(file, await get(url, 'buffer'));
  await sleep(2500);
  return file;
}

// The Studio page that states the licence must still say so (one fetch per page).
const pageText = new Map();
async function checkLicensePage(img) {
  if (!img.licenseSource || !img.licenseQuote) throw new Error(`${img.file}: a Studio image needs licenseSource and licenseQuote`);
  if (!pageText.has(img.licenseSource)) pageText.set(img.licenseSource, plain(await get(img.licenseSource)));
  if (!pageText.get(img.licenseSource).includes(plain(img.licenseQuote))) throw new Error(`${img.file}: "${img.licenseQuote}" not found on ${img.licenseSource}`);
}

async function studioSource(img) {
  const s = img.studio;
  await checkLicensePage(img);
  if (s.asset) {
    const html = strip(await get(`https://studio.blender.org/projects/api/assets/${s.asset}/`));
    const lic = /License (CC[-\w.]*)/.exec(html)?.[1];
    if (lic !== 'CC-BY' && lic !== 'CC0') throw new Error(`Studio asset ${s.asset} is "${lic}", not CC BY / CC0`);
  }
  if (s.blog) {
    const html = await get(s.blog);
    const url = [...html.matchAll(/https:\/\/studio\.blender\.org\/files\/[0-9a-f]{2}\/([0-9a-f]{32})\/\1\.(?:png|jpe?g)[^"' )]*/g)].map((m) => m[0].replace(/&amp;/g, '&')).find((u) => u.includes(s.hash));
    if (!url) throw new Error(`Image ${s.hash} not found in ${s.blog}`);
    return { file: await cached(s.hash, url), download: url.split('?')[0] };
  }
  return { file: await cached(s.url, s.url), download: s.url };
}

// Runs in the hidden window: decode, crop, step-down resample, JPEG encode, BlurHash.
const RENDERER = String.raw`
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const enc83 = (n, len) => { let s = ''; for (let i = 1; i <= len; i++) s += B83[Math.floor(n / 83 ** (len - i)) % 83]; return s; };
const toLin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => { const x = Math.max(0, Math.min(1, v)); return x <= 0.0031308 ? Math.trunc(x * 12.92 * 255 + 0.5) : Math.trunc((1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5); };
const spow = (v, e) => Math.sign(v) * Math.abs(v) ** e;
function blurhash(px, w, h, cx, cy) {
  const f = [];
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const norm = x === 0 && y === 0 ? 1 : 2; let r = 0, g = 0, b = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = norm * Math.cos((Math.PI * x * i) / w) * Math.cos((Math.PI * y * j) / h); const p = 4 * (i + j * w);
      r += k * toLin(px[p]); g += k * toLin(px[p + 1]); b += k * toLin(px[p + 2]);
    }
    const s = 1 / (w * h); f.push([r * s, g * s, b * s]);
  }
  const [dc, ...ac] = f;
  let hash = enc83(cx - 1 + (cy - 1) * 9, 1), max = 1;
  if (ac.length) { const q = Math.max(0, Math.min(82, Math.floor(Math.max(...ac.flat().map(Math.abs)) * 166 - 0.5))); max = (q + 1) / 166; hash += enc83(q, 1); } else hash += enc83(0, 1);
  hash += enc83((toSrgb(dc[0]) << 16) + (toSrgb(dc[1]) << 8) + toSrgb(dc[2]), 4);
  const qa = (v) => Math.max(0, Math.min(18, Math.floor(spow(v / max, 0.5) * 9 + 9.5)));
  for (const [r, g, b] of ac) hash += enc83(qa(r) * 361 + qa(g) * 19 + qa(b), 2);
  return hash;
}
async function processImage({ src, W, H, crop, focus, quality }) {
  const img = new Image(); img.src = src; await img.decode();
  const sw = img.naturalWidth, sh = img.naturalHeight, target = W / H;
  let r = crop ? { x: crop.x * sw, y: crop.y * sh, w: crop.w * sw, h: crop.h * sh } : { x: 0, y: 0, w: sw, h: sh };
  // Fit the rectangle to the target aspect ratio around the focus point (centre by default).
  const fx = focus?.x ?? 0.5, fy = focus?.y ?? 0.5;
  if (r.w / r.h > target) { const w = r.h * target; r.x = Math.min(Math.max(r.x + r.w * fx - w / 2, r.x), r.x + r.w - w); r.w = w; }
  else if (r.w / r.h < target) { const h = r.w / target; r.y = Math.min(Math.max(r.y + r.h * fy - h / 2, r.y), r.y + r.h - h); r.h = h; }
  r = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  let c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  let g = c.getContext('2d'); g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  while (c.width >= W * 2 && c.height >= H * 2) {
    const n = document.createElement('canvas'); n.width = Math.round(c.width / 2); n.height = Math.round(c.height / 2);
    const ng = n.getContext('2d'); ng.imageSmoothingQuality = 'high'; ng.drawImage(c, 0, 0, n.width, n.height); c = n;
  }
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const og = out.getContext('2d'); og.imageSmoothingQuality = 'high'; og.fillStyle = '#000'; og.fillRect(0, 0, W, H); og.drawImage(c, 0, 0, W, H);
  const bw = 32, bh = Math.round((32 * H) / W);
  const t = document.createElement('canvas'); t.width = bw; t.height = bh;
  const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(out, 0, 0, bw, bh);
  const hash = blurhash(tg.getImageData(0, 0, bw, bh).data, bw, bh, W > H ? 4 : 3, W > H ? 3 : 4);
  return { jpeg: out.toDataURL('image/jpeg', quality).split(',')[1], source: { width: sw, height: sh }, rect: r, blurHash: hash };
}`;

async function main() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, webSecurity: false, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(`${RENDERER}; window.processImage = processImage; true`);

  const wide = IMAGES.filter((i) => i.commons && (i.kind !== 'poster' || i.crop)).map((i) => i.commons);
  const narrow = IMAGES.filter((i) => i.commons && i.kind === 'poster' && !i.crop).map((i) => i.commons);
  console.log('Reading Wikimedia Commons licence metadata...');
  const info = new Map([...(await commonsInfo(narrow, 1280)), ...(await commonsInfo(wide, 3840))]);

  const films = new Map(FILMS.map((f) => [f.slug, f]));
  const records = [];
  for (const img of IMAGES) {
    const film = films.get(img.film);
    let rec;
    if (img.commons) {
      const c = info.get(img.commons);
      if (!ALLOWED.test(c.license)) throw new Error(`${img.commons}: licence "${c.license}" is not CC BY / CC0`);
      const unacknowledged = c.restrictions.filter((r) => !img.restrictions?.[r]);
      if (unacknowledged.length) throw new Error(`${img.commons}: Commons restrictions "${unacknowledged.join(', ')}" are not acknowledged in sources.mjs (restrictions: { <name>: 'how it is handled' })`);
      const file = await cached(c.download, c.download);
      rec = {
        local: file, license: c.license, licenseUrl: c.licenseUrl, usageTerms: c.usageTerms,
        restrictions: c.restrictions.length ? Object.fromEntries(c.restrictions.map((r) => [r, img.restrictions[r]])) : null,
        author: img.author ?? c.author, credit: img.credit ?? c.credit, attribution: img.author ? null : c.attribution,
        commonsArtist: c.author, commonsCredit: c.credit,
        sourceUrl: c.page, originalUrl: c.original, downloadUrl: c.download, origin: 'Wikimedia Commons', licenseSource: c.page,
      };
    } else {
      if (!ALLOWED.test(img.license)) throw new Error(`${img.file}: licence "${img.license}" is not CC BY / CC0`);
      const s = await studioSource(img);
      rec = { local: s.file, license: img.license, licenseUrl: img.licenseUrl, usageTerms: null, restrictions: null, author: img.author, credit: img.credit, attribution: null, sourceUrl: img.studio.page, originalUrl: s.download, downloadUrl: s.download, origin: 'Blender Studio (studio.blender.org)', licenseSource: img.licenseSource, licenseNote: img.licenseNote };
    }
    const [W, H] = SIZES[img.kind];
    const res = await win.webContents.executeJavaScript(`processImage(${JSON.stringify({ src: pathToFileURL(rec.local).href, W, H, crop: img.crop ?? null, focus: img.focus ?? null, quality: JPEG_QUALITY[img.kind] })})`);
    const outFile = path.join(ROOT, img.file);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const data = Buffer.from(res.jpeg, 'base64');
    fs.writeFileSync(outFile, data);
    const { x, y, w, h } = res.rect;
    const cropped = x !== 0 || y !== 0 || w !== res.source.width || h !== res.source.height;
    const scale = w < W || h < H ? 'upscaled' : 'resized';
    console.log(`${img.file.padEnd(36)} ${String(Math.round(data.length / 1024)).padStart(5)} KB  ${rec.license}`);
    const { local, ...keep } = rec;
    records.push({
      file: img.file.replace(/\\/g, '/'), film: film.slug, title: film.title, year: film.year, kind: img.kind, role: img.role ?? img.kind, label: img.label ?? null,
      ...keep,
      removed: img.removed ?? null,
      width: W, height: H, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), blurHash: res.blurHash,
      modifications: `${cropped ? `cropped to ${w}x${h} at (${x},${y}) of the ${res.source.width}x${res.source.height} source${img.removed ? `; removed: ${img.removed}` : ''}; ` : ''}${scale} to ${W}x${H}, re-encoded as JPEG`,
    });
  }
  win.destroy();

  const total = records.reduce((a, r) => a + r.bytes, 0);
  const json = {
    description: 'Demo artwork for the Wicaby mock server (MOCK_DATASET=demo). Every image is from a Blender Foundation open movie and is licensed CC BY (or CC0); logos and trademarks are not covered by that licence and have been cropped out of the posters. See ATTRIBUTION.md.',
    generatedBy: 'scripts/build-demo-assets.mjs',
    generatedAt: new Date().toISOString(),
    policy: 'Only CC BY (any version) or CC0. No ShareAlike, NoDerivatives or NonCommercial material. Logos and trademarks (Blender, film title logos, Creative Commons, sponsors) are not covered by the CC licence and remain the property of their owners: the published posters carry them, so each poster is cropped to its artwork (title treatment, credit block and logo strip cut away; see "removed") and Wing It! uses its textless paintover preview. A Wikimedia Commons "Restrictions" value (e.g. trademarked) fails the build unless sources.mjs records how it is handled (see "restrictions"). Blender Studio licence pages are re-read at build time.',
    excluded: [{ title: 'Agent 327: Operation Barbershop', year: 2017, reason: 'All artwork published on studio.blender.org for this project is CC BY-ND (the character is licensed from Martin Lodewijk); cropping and resizing would be a derivative.' }],
    totalBytes: total,
    images: records,
  };
  fs.writeFileSync(path.join(ROOT, 'ATTRIBUTION.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'ATTRIBUTION.md'), markdown(json));
  console.log(`\n${records.length} images, ${(total / 1048576).toFixed(1)} MB. Wrote ATTRIBUTION.json and ATTRIBUTION.md.`);
}

function markdown(j) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const byFilm = new Map();
  for (const r of j.images) (byFilm.get(r.film) ?? byFilm.set(r.film, []).get(r.film)).push(r);
  let md = `# Demo artwork attribution

The images in this folder are used by the Wicaby mock server (\`MOCK_DATASET=demo\`) and the README
screenshots. They come from the **Blender Foundation open movies** and are published under
**Creative Commons Attribution** licences (CC BY 2.5, 3.0 or 4.0). Each one has been cropped and/or
resized to a poster (600x900) or backdrop (1920x1080) JPEG; nothing else was changed.

General credit: **(CC) Blender Foundation | blender.org / studio.blender.org**

**Logos and trademarks are not covered by the CC licence.** The Blender logo, the films' title logos,
the Creative Commons logo and sponsor logos remain the property of their owners (Blender Studio
licensing pages: "Excluded from the Creative Commons license is: all logos ... and associated
trademarks"; studio.blender.org terms: "Trademarks and logos - including the Blender logo - are
copyrighted properties, with all rights reserved"). The published posters carry these marks, so every
poster here is a crop of the artwork alone: the title treatment, the credit block and the logo strip
are cut away (the *Changes* column says what was removed). The Wing It! poster is the textless
paintover preview from the "Creating the poster" article. Glass Half and Hero have no CC poster and
use portrait crops of film frames. Wikimedia Commons tags *Tears of Steel*'s poster as "trademarked";
the build fails on such a tag unless the entry records how it is handled (here: the marks are cropped out).

Licences are verified at build time: Wikimedia Commons licence and restriction metadata is read live,
each Blender Studio licence page is re-read for the quoted sentence, and Studio asset 2351 (the
Caminandes poster) is re-checked for "License CC-BY".

${j.excluded.map((e) => `*${e.title}* is not included: ${e.reason}`).join(' ')}

`;
  for (const [, rows] of byFilm) {
    md += `## ${rows[0].title} (${rows[0].year})\n\n| File | Licence | Author / credit | Source | Changes |\n|---|---|---|---|---|\n`;
    for (const r of rows) {
      const lic = r.licenseUrl ? `[${r.license}](${r.licenseUrl})` : r.license;
      const who = [r.attribution ?? r.author, r.credit && r.credit !== r.author && !/^https?:/.test(r.credit) ? r.credit : ''].filter(Boolean).join(' / ');
      const what = r.label ? `\`${r.file}\` (${r.label})` : `\`${r.file}\``;
      const restr = r.restrictions ? ` Commons restriction${Object.keys(r.restrictions).length > 1 ? 's' : ''}: ${Object.entries(r.restrictions).map(([k, v]) => `*${k}*: ${v}`).join('; ')}` : '';
      md += `| ${what} | ${lic} | ${esc(who)} | [${esc(r.origin)}](${r.sourceUrl}) | ${esc(r.modifications)}.${esc(restr)} |\n`;
    }
    const notes = [...new Set(rows.map((r) => r.licenseNote).filter(Boolean))];
    if (notes.length) md += `\n${notes.map((n) => `> ${n}`).join('\n>\n')}\n`;
    md += '\n';
  }
  md += `---\nGenerated by \`scripts/build-demo-assets.mjs\` from \`sources.mjs\`; total ${(j.totalBytes / 1048576).toFixed(1)} MB.\n`;
  return md;
}
