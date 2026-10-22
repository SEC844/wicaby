// Comics library Folders view (desktop routes/Library.svelte) against both mocks: the queries the page sends.
// Root: folders first, then the books left at the root; a folder lists its books and subfolders; a nested folder
// is reached by ParentId; "All Books" (Recursive + IncludeItemTypes=Book) still finds every book at any depth;
// an imageless folder's first book (its cover fallback). The Jellyfin mock is spawned on 8983.
// Usage: node tools/checks/comic-folders-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};
const BOOKS = Object.keys(E.COMICS).length;

async function run(label, get) {
  const names = (r) => r.Items.map((x) => x.Name);
  const rootList = await get({ ParentId: 'lib-books', SortBy: 'IsFolder,SortName', SortOrder: 'Ascending' });
  const firstBook = rootList.Items.findIndex((x) => !x.IsFolder);
  assert.ok(firstBook >= 2, `${label}: the root lists its folders first (${names(rootList)})`);
  assert.ok(rootList.Items.slice(firstBook).every((x) => x.Type === 'Book'), `${label}: then its books`);
  const formats = rootList.Items.find((x) => x.Name === 'Formats');
  assert.equal(formats?.Type, 'Folder', `${label}: a Folder item at the root`);
  assert.ok(rootList.Items.find((x) => x.Name === 'Romans')?.ImageTags?.Primary, `${label}: a folder with its own image`);

  const inside = await get({ ParentId: formats.Id, SortBy: 'IsFolder,SortName', SortOrder: 'Ascending' });
  assert.equal(inside.Items[0].Type, 'Folder', `${label}: a subfolder first`);
  assert.ok(inside.Items.slice(1).length >= 2 && inside.Items.slice(1).every((x) => x.Type === 'Book'), `${label}: then the folder's books`);
  const nested = await get({ ParentId: inside.Items[0].Id, SortBy: 'IsFolder,SortName' });
  assert.ok(nested.Items.length >= 2 && nested.Items.every((x) => x.Type === 'Book'), `${label}: the nested folder's books`);

  const all = await get({ ParentId: 'lib-books', Recursive: 'true', IncludeItemTypes: 'Book', SortBy: 'SortName' });
  assert.equal(all.TotalRecordCount, BOOKS, `${label}: All Books finds every book at any depth`);
  const cover = await get({ ParentId: formats.Id, Recursive: 'true', IncludeItemTypes: 'Book', SortBy: 'SortName', Limit: '1' });
  assert.equal(cover.Items.length, 1, `${label}: an imageless folder's first book`);
  console.log(`comic-folders-check: ${label} OK (root: ${names(rootList).join(', ')})`);
}

const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
const JF = 8983;
const jf = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-jellyfin.mjs'), String(JF)], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const login = await fetch(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="folders-check", Version="1"' },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  }).then((r) => r.json());
  await run('emby', (q) => fetch(`${base}/Users/${login.User.Id}/Items?${new URLSearchParams(q)}`, { headers: { 'X-Emby-Token': login.AccessToken } }).then((r) => r.json()));

  await new Promise((resolve, reject) => {
    jf.on('exit', (code) => reject(new Error(`mock-jellyfin exited (${code}): is port ${JF} taken?`)));
    jf.stdout.on('data', (d) => String(d).includes(`:${JF}`) && resolve());
  });
  const jbase = `http://127.0.0.1:${JF}`;
  const DEVICE = 'Client="checks", Device="c", DeviceId="folders-check-jf", Version="1"';
  const jl = await fetch(`${jbase}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser ${DEVICE}` }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) }).then((r) => r.json());
  const H = { Authorization: `MediaBrowser ${DEVICE}, Token="${jl.AccessToken}"` };
  await run('jellyfin', (q) => fetch(`${jbase}/Items?${new URLSearchParams({ ...q, userId: jl.User.Id })}`, { headers: H }).then((r) => r.json()));
} finally {
  jf.kill();
  server.close();
}
