// Player check: the remux player end to end in a real MSE engine. Playwright's WebKit build on Windows has no
// MediaSource, so this drives an installed Chromium browser with the proprietary codecs (PLAYER_BROWSER, else
// Brave or Chrome where they install), on a fresh temporary profile: its MediaSource takes what the phone's
// ManagedMediaSource takes, as far as its codecs go. For each MKV of .dev/media it serves the file from the mock
// Emby server, signs in, plays a film from its page, and checks that:
// - the player says it remuxes on the phone (no server conversion),
// - the picture advances, then a seek far ahead plays on from there,
// - no page error was raised.
//   node apps/mobile-web/scripts/player-check.mjs [file.mkv…]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const APP = path.resolve(import.meta.dirname, '..');
const MEDIA = path.join(ROOT, '.dev', 'media');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startMock(port, video) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(port), video], {
    env: { ...process.env, MOCK_DATASET: 'demo', MOCK_DURATION_S: '30' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-emby: not listening after 10 s')), 10_000);
    child.stdout.on('data', (d) => /Mock Emby/i.test(String(d)) && (clearTimeout(timer), resolve()));
    child.once('exit', (code) => reject(new Error(`mock-emby exited with ${code}`)));
  });
  return child;
}

const state = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    return { t: v?.currentTime ?? -1, paused: v?.paused, err: v?.error?.message ?? null, mode: document.querySelector('.heading .footnote')?.textContent ?? '', msg: document.querySelector('.center .title-2')?.textContent ?? '' };
  });

const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(MEDIA).filter((f) => f.endsWith('.mkv'));
const vite = await createServer({ configFile: path.join(APP, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await vite.listen();
const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;
const CANDIDATES = [
  process.env.PLAYER_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('player-check: no Chromium browser with proprietary codecs found (set PLAYER_BROWSER)');
const browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
try {
  for (const name of files) {
    const port = await freePort();
    const mock = await startMock(port, path.join(MEDIA, name));
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    // iOS's ManagedMediaSource as the worst case: it never says "start streaming" (streaming stays false), so the
    // player must feed what it needs by itself (the iPhone's black screen of 2026-10-21).
    await page.addInitScript(() => {
      class ManagedMediaSource extends MediaSource {
        get streaming() {
          return false;
        }
      }
      Object.defineProperty(window, 'ManagedMediaSource', { value: ManagedMediaSource });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => /^remux:/.test(m.text()) && errors.push(m.text()));
    try {
      await page.goto(appUrl);
      await page.getByRole('textbox').first().fill(`http://127.0.0.1:${port}`);
      await page.keyboard.press('Enter');
      await page.getByText('Wika', { exact: true }).click();
      await page.locator('input[type=password]').fill('wicaby');
      await page.keyboard.press('Enter');
      await page.locator('nav').waitFor();
      await page.waitForTimeout(800);
      // A film from its page, from the start (a resume point could lie past the end of the short test file).
      await page.locator('[data-screen-top] section.shelf', { hasText: 'Movies' }).locator('button.card').first().click();
      await page.locator('[data-screen-top] button.play').click();
      await page.getByText(/Depuis le début|From the start/).click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(5000);
      // The controls hide while playing: a tap brings them (mode line, bar) back.
      const show = async () => {
        if (!(await page.locator('[data-screen-top] .player .bar').count())) await page.locator('[data-screen-top] .surface').click();
        await page.locator('[data-screen-top] .player .bar').waitFor({ timeout: 2000 });
      };
      await show();
      const a = await state(page);
      // A seek past what is buffered (the session's seek, as the bar does).
      await show();
      await page.locator('[data-screen-top] .player .bar').click({ position: { x: 300, y: 15 } });
      await page.waitForTimeout(4000);
      const b = await state(page);
      const remux = /remux/i.test(a.mode);
      const played = a.t > 0.5 && !a.paused;
      const sought = b.t > a.t + 3;
      const ok = remux && played && sought && !a.err && !b.err && !errors.length;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: "${a.mode}" · t ${a.t.toFixed(1)} s → after seek ${b.t.toFixed(1)} s${a.err || b.err ? ` · ${a.err ?? b.err}` : ''}${a.msg ? ` · ${a.msg}` : ''}${errors.length ? ` · ${errors.join(' | ')}` : ''}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    } finally {
      await page.close();
      mock.kill();
    }
  }
} finally {
  await browser.close();
  await vite.close();
}
if (failed) {
  console.error(`player-check: ${failed} file(s) failed`);
  process.exit(1);
}
console.log('player-check: ok');
