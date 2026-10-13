// Rasterises the Wicaby icons from the brand SVG masters with Chromium
// (the project's own Electron, no extra dependency) and packs the result.
// Output: resources/icon.ico (16..256 px) and resources/icon.png (512 px);
// 16-32 px come from the small optical cut (brand/wicaby-app-icon-small.svg),
// 48 px and up from brand/wicaby-app-icon.svg. Also the Android legacy
// launcher PNGs, straight into apps/android/tv/src/main/res/mipmap-*dpi
// (mobile is minSdk 26 and needs only the adaptive icon).
// The SVGs themselves come from brand/scripts/make-brand.mjs.
// Usage: npm run icon, or node brand/scripts/make-icon.mjs (re-launches itself under Electron).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'apps', 'desktop', 'resources');
const LARGE = path.join(ROOT, 'brand', 'wicaby-app-icon.svg');
const SMALL = path.join(ROOT, 'brand', 'wicaby-app-icon-small.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ROUND = path.join(ROOT, 'brand', 'android', 'legacy-round.svg');
const TV_RES = path.join(ROOT, 'apps', 'android', 'tv', 'src', 'main', 'res');
const MIPMAPS = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

if (!process.versions.electron) {
  const { default: electronPath } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const { app, BrowserWindow } = await import('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// Not awaited at top level: Electron holds 'ready' until the ESM entry finishes evaluating.
app.whenReady().then(main);

let win;

// Chromium draws the vector straight at the target size, so small sizes get real hinting-free AA, not a downscale.
async function render(file, size) {
  const b64 = Buffer.from(fs.readFileSync(file)).toString('base64');
  const png = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  return Buffer.from(png, 'base64');
}

async function main() {
  try {
    win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<body></body>');
    fs.mkdirSync(OUT, { recursive: true });
    const images = [];
    for (const size of ICO_SIZES) images.push({ size, data: await render(size <= 32 ? SMALL : LARGE, size) });
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(images));
    fs.writeFileSync(path.join(OUT, 'icon.png'), await render(LARGE, 512));
    console.log(`wrote ${path.join(OUT, 'icon.ico')} (${ICO_SIZES.join(', ')}) and icon.png (512)`);
    for (const [dpi, size] of Object.entries(MIPMAPS)) {
      const dir = path.join(TV_RES, `mipmap-${dpi}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await render(LARGE, size));
      fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), await render(ROUND, size));
    }
    console.log(`wrote Android mipmaps (${Object.values(MIPMAPS).join(', ')}) under ${TV_RES}`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
}
