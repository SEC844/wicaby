// Watch history on the Emby mock (TP-08, desktop History page and Android TV History screen):
// the History query (SortBy=DatePlayed, Descending) lists played items newest first, and marking one
// unplayed (DELETE PlayedItems, the TV's "Remove from History") clears its last play date, as both servers do.
// Usage: node tools/checks/history-mock-check.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const { recentFirst } = await import(pathToFileURL(path.join(root, 'apps/desktop/src/shared/history.ts')).href);
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};
const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
try {
  const login = await fetch(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="history-check", Version="1"' },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  }).then((r) => r.json());
  const H = { 'X-Emby-Token': login.AccessToken };
  const uid = login.User.Id;
  const q = `${base}/Users/${uid}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DatePlayed&SortOrder=Descending`;
  // History.svelte's two queries; the unfiltered one is what an Emby 4.10 answered with no history in it.
  const history = async () => {
    const [p, r] = await Promise.all(['IsPlayed', 'IsResumable'].map((f) => fetch(`${q}&Limit=200&Filters=${f}`, { headers: H }).then((x) => x.json())));
    return recentFirst([...p.Items, ...r.Items]).map((x) => x.Id);
  };
  const unfiltered = await fetch(`${q}&Limit=3`, { headers: H }).then((x) => x.json());
  assert.equal(recentFirst(unfiltered.Items).length, 0, 'the mock puts never-played items first, as Emby did');

  const before = await history();
  assert.deepEqual(before.slice(0, 6), ['ep-1-3', 'movie-2', 'ep-1-2', 'ep-1-1', 'movie-1', 'movie-5'], `newest first (got ${before})`);
  assert.ok((await fetch(`${base}/Users/${uid}/PlayedItems/movie-1`, { method: 'DELETE', headers: H })).ok, 'DELETE PlayedItems answers');
  assert.ok(!(await history()).includes('movie-1'), 'marked unplayed: out of the history');
  assert.ok((await fetch(`${base}/Users/${uid}/PlayedItems/movie-1`, { method: 'POST', headers: H })).ok, 'POST PlayedItems answers');
  assert.equal((await history())[0], 'movie-1', 'marked played again: back, newest');
  console.log('history-mock-check: History query and Remove from History OK');
} finally {
  server.close();
}
