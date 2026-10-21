// Screenshots of the phone web app in WebKit (Playwright's build of Safari's engine), at an iPhone 15 Pro Max's
// size as a Home Screen app: 430 × 932 pt at 3×, touch, with its safe areas (59 pt top, 34 pt bottom) applied
// through the app's own --safe-* variables, since a desktop WebKit reports none. Runs against the mock Emby server
// (demo dataset) and the dev server, signs in once, then walks each scene. Fails on any page error or console error.
//
//   npm run shots -w apps/mobile-web [-- scene…]      scenes: login home homeScrolled detail series library folder
//                                                      search settings
//   SHOTS_VIDEO=.dev/media/x.mkv for the player scene; SHOTS_DARK=0 for the light scheme first; SHOTS_EVAL='<js expression>' prints its value on each scene (debug).
//   Output in .dev/shots/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT = path.join(ROOT, '.dev', 'shots');
const APP = path.resolve(import.meta.dirname, '..');
const SAFE = { top: 59, bottom: 34 };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startMock(port) {
  // SHOTS_VIDEO: the file the mock serves for every title (the player scenes).
  const video = process.env.SHOTS_VIDEO ? [path.resolve(ROOT, process.env.SHOTS_VIDEO)] : [];
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(port), ...video], {
    env: { ...process.env, MOCK_DATASET: 'demo' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-emby: not listening after 10 s')), 10_000);
    child.stdout.on('data', (d) => /listening|Mock Emby/i.test(String(d)) && (clearTimeout(timer), resolve()));
    child.once('exit', (code) => reject(new Error(`mock-emby exited with ${code}`)));
  });
  return child;
}

// Scene: what to do from the signed-in Home before the screenshot.
const SCENES = {
  async home() {},
  async homeScrolled(page) {
    await page.locator('[data-screen-top] .scroller, [data-screen-top] [data-scroll]').first().evaluate((el) => el.scrollTo(0, 700));
    await page.waitForTimeout(500);
  },
  async detail(page) {
    await page.locator('[data-screen-top] button.card').nth(2).click();
    await page.waitForTimeout(1200);
  },
  async series(page) {
    await page.locator('[data-screen-top] section.shelf', { hasText: 'TV Shows' }).locator('button.card').first().click();
    await page.waitForTimeout(1200);
  },
  async library(page) {
    await page.locator('nav button').nth(1).click();
    await page.waitForTimeout(800);
  },
  async folder(page) {
    await page.locator('nav button').nth(1).click();
    await page.waitForTimeout(500);
    await page.locator('[data-screen-top] button.lib').first().click();
    await page.waitForTimeout(1500);
  },
  async search(page) {
    await page.locator('nav button[aria-label]').last().click();
    await page.waitForTimeout(500);
  },
  // A Continue card plays; the controls stay up for the screenshot (a tap shows them).
  async player(page) {
    await page.locator('[data-screen-top] section.shelf').first().locator('button.card').first().click();
    await page.waitForTimeout(6000);
  },
  async settings(page) {
    await page.locator('nav button').nth(3).click();
    await page.waitForTimeout(500);
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  fs.mkdirSync(OUT, { recursive: true });
  const mockPort = await freePort();
  const mock = await startMock(mockPort);
  const vite = await createServer({ configFile: path.join(APP, 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await vite.listen();
  const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  const browser = await webkit.launch();
  const errors = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 430, height: 932 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: process.env.SHOTS_DARK === '0' ? 'light' : 'dark',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(({ top, bottom }) => {
      const set = () => {
        document.documentElement.style.setProperty('--safe-top', `${top}px`);
        document.documentElement.style.setProperty('--safe-bottom', `${bottom}px`);
      };
      if (document.documentElement) set();
      else document.addEventListener('DOMContentLoaded', set);
    }, SAFE);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

    // Sign in through the real flow.
    await page.goto(appUrl);
    if (!wanted.length || wanted.includes('login')) await page.screenshot({ path: path.join(OUT, 'login.png') });
    await page.getByRole('textbox').first().fill(`http://127.0.0.1:${mockPort}`);
    await page.keyboard.press('Enter');
    await page.getByText('Wika', { exact: true }).click();
    await page.locator('input[type=password]').fill('wicaby');
    await page.keyboard.press('Enter');
    await page.locator('nav').waitFor();
    await page.waitForTimeout(1500);
    const state = await context.storageState();

    for (const [name, run] of Object.entries(SCENES)) {
      if (wanted.length && !wanted.includes(name)) continue;
      const p = await context.newPage();
      await context.addCookies(state.cookies);
      p.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
      await p.goto(appUrl);
      await p.locator('nav').waitFor();
      await p.waitForTimeout(1200);
      await run(p);
      if (process.env.SHOTS_EVAL) console.log(name, JSON.stringify(await p.evaluate(process.env.SHOTS_EVAL)));
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log(`shot ${name}`);
      await p.close();
    }
  } finally {
    await browser.close();
    await vite.close();
    mock.kill();
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`shots in ${OUT}`);
}

await main();
