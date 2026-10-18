// Builds the web TV demo's catalogue (docs/webtv.md): starts tools/mock-server/mock-emby.mjs with MOCK_DATASET=demo
// (the Blender open movies, CC BY artwork, listed in tools/mock-server/demo/ATTRIBUTION.md) on 127.0.0.1, reads
// what the app browses, and writes apps/webtv/dist/demo-public/demo/: catalog.json, the images as static files
// (Items/<id>/Images/<Type>, the paths the app asks for) and the test clip. No real media, no network beyond
// loopback. The in-browser demo server (src/demo.ts) answers from these files.
// Run: node apps/webtv/scripts/demo-data.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const here = import.meta.dirname;
const repo = path.resolve(here, '../../..');
const out = path.join(here, '../dist/demo-public/demo');
const USER = 'u-wika';
// The libraries the TV app shows in the demo: films, series and collections.
const KINDS = new Set(['movies', 'tvshows', 'boxsets']);
const DETAIL = 'PrimaryImageAspectRatio,ProductionYear,ChildCount,RecursiveItemCount,OfficialRating,CommunityRating,Overview,Width,Height,ProviderIds,DateCreated,Etag,PremiereDate,Genres,Studios,People,MediaSources,MediaStreams,Chapters,Taglines,ParentId,RemoteTrailers';

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const mock = spawn(process.execPath, [path.join(repo, 'tools/mock-server/mock-emby.mjs'), String(port)], {
  env: { ...process.env, MOCK_DATASET: 'demo', MOCK_DEMO_LANG: 'en', MOCK_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const base = `http://127.0.0.1:${port}/emby`;
let token = '';
const headers = () => ({ Accept: 'application/json', 'X-Emby-Authorization': 'Emby Client="Wicaby demo build", Device="build", DeviceId="demo-build", Version="1"', ...(token ? { 'X-Emby-Token': token } : {}) });
async function get(p) {
  const r = await fetch(`${base}${p}`, { headers: headers() });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/System/Info/Public`);
      break;
    } catch {
      if (i > 100) throw new Error('mock-emby did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const auth = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) }).then((r) => r.json());
  token = auth.AccessToken;

  const views = (await get(`/Users/${USER}/Views`)).Items.filter((v) => KINDS.has(v.CollectionType));
  const items = new Map();
  const add = (it, view) => {
    const prev = items.get(it.Id);
    items.set(it.Id, { ...prev, ...it, _view: prev?._view ?? view });
  };
  for (const v of views) {
    const res = await get(`/Users/${USER}/Items?ParentId=${v.Id}&Recursive=true&Fields=${DETAIL}&Limit=1000`);
    for (const it of res.Items) if (['Movie', 'Series', 'BoxSet'].includes(it.Type)) add(it, v.Id);
  }
  for (const s of [...items.values()].filter((i) => i.Type === 'Series')) {
    for (const season of (await get(`/Shows/${s.Id}/Seasons?UserId=${USER}&Fields=${DETAIL}`)).Items) add(season, s._view);
    for (const ep of (await get(`/Shows/${s.Id}/Episodes?UserId=${USER}&Fields=${DETAIL}`)).Items) add(ep, s._view);
  }
  const children = {};
  for (const b of [...items.values()].filter((i) => i.Type === 'BoxSet')) {
    const res = await get(`/Users/${USER}/Items?ParentId=${b.Id}&Fields=${DETAIL}`);
    children[b.Id] = res.Items.map((i) => i.Id).filter((id) => items.has(id));
  }
  // Full detail (people, chapters, media sources) of each one.
  for (const id of items.keys()) add(await get(`/Users/${USER}/Items/${id}?Fields=${DETAIL}`), items.get(id)._view);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Images at the paths the app requests (src/demo.ts mediaBase): <id>/Images/<Type>, no extension.
  let images = 0;
  const all = [...views, ...items.values()];
  for (const it of all) {
    const types = Object.keys(it.ImageTags ?? {}).filter((t) => ['Primary', 'Thumb', 'Logo', 'Banner'].includes(t));
    if (it.BackdropImageTags?.length) types.push('Backdrop');
    for (const type of types) {
      const r = await fetch(`${base}/Items/${it.Id}/Images/${type}`, { headers: headers() });
      if (!r.ok) continue;
      const file = path.join(out, 'Items', it.Id, 'Images', type);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      images++;
    }
  }
  const info = await get('/System/Info/Public');
  const strip = (it) => {
    delete it.UserData;
    delete it.ServerId;
    return it;
  };
  const catalog = {
    server: { Id: info.Id, ServerName: 'Wicaby Demo', Version: info.Version, ProductName: 'Emby Server' },
    user: { Id: USER, Name: 'Wika' },
    views: views.map(strip),
    items: Object.fromEntries([...items].map(([id, it]) => [id, strip(it)])),
    children,
  };
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog));
  fs.copyFileSync(path.join(here, '../demo/demo.mp4'), path.join(out, 'video.mp4'));
  fs.copyFileSync(path.join(repo, 'tools/mock-server/demo/ATTRIBUTION.md'), path.join(out, 'ATTRIBUTION.md'));
  console.log(`demo-data: ${views.length} libraries, ${items.size} items, ${images} images -> ${path.relative(repo, out)}`);
} finally {
  mock.kill();
}
