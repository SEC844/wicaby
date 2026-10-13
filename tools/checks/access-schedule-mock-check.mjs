// Parental access schedules on the Emby mock (TP-11, Policy.AccessSchedules as the desktop admin edits them; the
// Android TV explains a refusal and counts down the end, core AccessSchedules.kt): outside the hours, sign-in and
// authenticated calls answer 401 with Emby's wording, public calls still answer, and POST /Mock/AccessSchedules
// sets or lifts them, per user (?userId=). A saved account (TP-10 "Who is watching?") is checked the way the TV does it
// (core AccessSchedules.verify: Emby GET /Users/{id}, Jellyfin GET /Users/Me): refused for that user only. The Jellyfin mock (spawned on 8966) answers like Jellyfin: sign-in and every call a bare 403,
// but GET /Users/{id} ([Authorize(IgnoreParentalControl)]) and /Users/Public carry the policy.
// Usage: node tools/checks/access-schedule-mock-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};

// The same vectors as AccessSchedulesTest.kt (2026-10-12 is a Monday; the mock's "Enfants" user).
const kids = [{ DayOfWeek: 'Weekday', StartHour: 16, EndHour: 20 }, { DayOfWeek: 'Weekend', StartHour: 9, EndHour: 21 }];
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m);
assert.equal(E.scheduleAllows([], at(12, 3)), true, 'no schedule: no limit');
assert.equal(E.scheduleAllows(kids, at(12, 17)), true, 'Monday 17:00 allowed');
assert.equal(E.scheduleAllows(kids, at(12, 10)), false, 'Monday 10:00 refused');
assert.equal(E.scheduleAllows(kids, at(12, 20)), false, 'the end is not allowed');
assert.equal(E.scheduleAllows(kids, at(17, 10)), true, 'Saturday 10:00 allowed');

const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="schedule-check", Version="1"' };
const login = () => fetch(`${base}/emby/Users/AuthenticateByName`, { method: 'POST', headers: auth, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
const setSchedules = (list) => fetch(`${base}/Mock/AccessSchedules`, { method: 'POST', body: JSON.stringify(list) });
try {
  const ok = await login();
  assert.equal(ok.status, 200, 'sign-in without a schedule');
  const { AccessToken, User } = await ok.json();
  const H = { 'X-Emby-Token': AccessToken };

  // A one-hour window twelve hours away: now is outside it.
  const h = new Date().getHours();
  const away = (h + 12) % 24;
  const closed = [{ DayOfWeek: 'Everyday', StartHour: away, EndHour: away + 1 }];
  assert.equal((await setSchedules(closed)).status, 200, 'POST /Mock/AccessSchedules');
  assert.equal((await fetch(`${base}/Mock/AccessSchedules`, { method: 'POST', body: '{}' })).status, 400, 'not an array: 400');

  const refused = await login();
  assert.equal(refused.status, 401, 'sign-in refused outside the hours');
  assert.match(await refused.text(), /not allowed access at this time/, "Emby's wording at sign-in");
  const call = await fetch(`${base}/emby/Users/${User.Id}`, { headers: H });
  assert.equal(call.status, 401, 'an authenticated call refused');
  assert.match(await call.text(), /not allowed access at this time/, "Emby's wording on other calls");
  assert.equal((await fetch(`${base}/emby/Users/Public`)).status, 200, 'public calls still answer');
  assert.equal((await fetch(`${base}/emby/Items/movie-1/Images/Primary`, { headers: H })).status, 200, 'images stay public');

  // Allowed now: the policy carries the schedule the TV keeps.
  const open = [{ DayOfWeek: 'Everyday', StartHour: 0, EndHour: 24 }];
  await setSchedules(open);
  const me = await fetch(`${base}/emby/Users/${User.Id}`, { headers: H });
  assert.equal(me.status, 200, 'allowed again');
  assert.deepEqual((await me.json()).Policy.AccessSchedules, open, 'Policy.AccessSchedules served');
  assert.equal((await login()).status, 200, 'sign-in allowed again');

  // A saved account: Léa signed in earlier; now her hours (only hers) are closed.
  const lea = await (await fetch(`${base}/emby/Users/AuthenticateByName`, { method: 'POST', headers: auth, body: JSON.stringify({ Username: 'Léa', Pw: 'wicaby' }) })).json();
  assert.equal((await fetch(`${base}/Mock/AccessSchedules?userId=u-lea`, { method: 'POST', body: JSON.stringify(closed) })).status, 200, 'per-user schedule');
  const leaCheck = await fetch(`${base}/emby/Users/u-lea`, { headers: { 'X-Emby-Token': lea.AccessToken } });
  assert.equal(leaCheck.status, 401, "her saved token's check is refused");
  assert.match(await leaCheck.text(), /not allowed access at this time/, "with Emby's wording");
  assert.equal((await fetch(`${base}/emby/Users/${User.Id}`, { headers: H })).status, 200, "Wika's hours are his own");
  await fetch(`${base}/Mock/AccessSchedules?userId=u-lea`, { method: 'POST', body: '[]' });
  assert.equal((await fetch(`${base}/emby/Users/u-lea`, { headers: { 'X-Emby-Token': lea.AccessToken } })).status, 200, 'her token works again');

  await setSchedules([]);
} finally {
  server.close();
}

// Jellyfin.
const JF = 8966;
const jf = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-jellyfin.mjs'), String(JF)], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((resolve, reject) => {
    jf.on('exit', (code) => reject(new Error(`mock-jellyfin exited (${code}): is port ${JF} taken?`)));
    jf.stdout.on('data', (d) => String(d).includes(`:${JF}`) && resolve());
  });
  const jbase = `http://127.0.0.1:${JF}`;
  const DEVICE = 'Client="checks", Device="c", DeviceId="schedule-check-jf", Version="1"';
  const jlogin = (Pw) => fetch(`${jbase}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser ${DEVICE}` }, body: JSON.stringify({ Username: 'Wika', Pw }) });
  const ok = await jlogin('wicaby');
  assert.equal(ok.status, 200, 'jellyfin: sign-in without a schedule');
  const { AccessToken, User } = await ok.json();
  const H = { Authorization: `MediaBrowser ${DEVICE}, Token="${AccessToken}"` };
  const away = (new Date().getHours() + 12) % 24;
  const closed = [{ DayOfWeek: 'Everyday', StartHour: away, EndHour: away + 1 }];
  assert.equal((await fetch(`${jbase}/Mock/AccessSchedules`, { method: 'POST', body: JSON.stringify(closed) })).status, 200, 'jellyfin: POST /Mock/AccessSchedules');

  assert.equal((await jlogin('nope')).status, 401, 'jellyfin: a wrong password stays 401');
  const refused = await jlogin('wicaby');
  assert.equal(refused.status, 403, 'jellyfin: sign-in refused outside the hours with 403');
  assert.doesNotMatch(await refused.text(), /not allowed access/, 'jellyfin: no wording outside Development');
  const pub = await (await fetch(`${jbase}/Users/Public`)).json();
  assert.deepEqual(pub.find((u) => u.Id === User.Id).Policy.AccessSchedules, closed, 'jellyfin: /Users/Public carries the schedule');
  const byId = await fetch(`${jbase}/Users/${User.Id}`, { headers: H });
  assert.equal(byId.status, 200, 'jellyfin: GET /Users/{id} ignores the parental hours');
  assert.deepEqual((await byId.json()).Policy.AccessSchedules, closed, 'jellyfin: the policy carries the schedule');
  for (const p of ['/Users/Me', '/UserViews', `/Items?userId=${User.Id}`]) {
    const r = await fetch(jbase + p, { headers: H });
    assert.equal(r.status, 403, `jellyfin: ${p} refused with 403`);
    assert.equal(await r.text(), '', `jellyfin: ${p} bare 403`);
  }
  assert.equal((await fetch(`${jbase}/Items/movie-1/Images/Primary`)).status, 200, 'jellyfin: images stay anonymous');

  await fetch(`${jbase}/Mock/AccessSchedules`, { method: 'POST', body: '[]' });
  assert.equal((await fetch(`${jbase}/Users/Me`, { headers: H })).status, 200, 'jellyfin: allowed again');

  // A saved account: Léa signed in earlier, then only her hours close. /Users/Me (her token) is the refused check,
  // /Users/{id} still tells her hours; Wika is not affected.
  const leaIn = await (await fetch(`${jbase}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser ${DEVICE}` }, body: JSON.stringify({ Username: 'Léa', Pw: 'wicaby' }) })).json();
  const LH = { Authorization: `MediaBrowser ${DEVICE}, Token="${leaIn.AccessToken}"` };
  const meLea = await (await fetch(`${jbase}/Users/Me`, { headers: LH })).json();
  assert.equal(meLea.Id, leaIn.User.Id, "jellyfin: /Users/Me is the token's own user");
  await fetch(`${jbase}/Mock/AccessSchedules?userId=${leaIn.User.Id}`, { method: 'POST', body: JSON.stringify(closed) });
  const leaMe = await fetch(`${jbase}/Users/Me`, { headers: LH });
  assert.equal(leaMe.status, 403, "jellyfin: her saved token's check is refused");
  assert.equal(await leaMe.text(), '', 'jellyfin: a bare 403');
  const leaById = await fetch(`${jbase}/Users/${leaIn.User.Id}`, { headers: LH });
  assert.equal(leaById.status, 200, 'jellyfin: /Users/{id} still answers her');
  assert.deepEqual((await leaById.json()).Policy.AccessSchedules, closed, 'jellyfin: with her hours');
  const leaPub = (await (await fetch(`${jbase}/Users/Public`)).json()).find((u) => u.Id === leaIn.User.Id);
  assert.deepEqual(leaPub.Policy.AccessSchedules, closed, 'jellyfin: /Users/Public carries her hours');
  const leaAgain = await fetch(`${jbase}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `MediaBrowser ${DEVICE}` }, body: JSON.stringify({ Username: 'Léa', Pw: 'wicaby' }) });
  assert.equal(leaAgain.status, 403, 'jellyfin: her sign-in is refused with 403');
  assert.equal((await fetch(`${jbase}/Users/Me`, { headers: H })).status, 200, "jellyfin: Wika's hours are his own");
  await fetch(`${jbase}/Mock/AccessSchedules?userId=${leaIn.User.Id}`, { method: 'POST', body: '[]' });
  assert.equal((await fetch(`${jbase}/Users/Me`, { headers: LH })).status, 200, 'jellyfin: her token works again');
  assert.equal((await jlogin('wicaby')).status, 200, 'jellyfin: sign-in allowed again');
} finally {
  jf.kill();
}
console.log('access-schedule-mock-check: schedules, Emby and Jellyfin refusals, per-user saved-account checks and the mock control OK');
