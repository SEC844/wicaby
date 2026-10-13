// The Plex mock (plex-spec §10, PX-01) behaves as the dialect's checks need: PIN link, resources, /identity,
// sections, metadata with markers, editions and a missing part, the decision (direct play and transcode), the
// remote cap 500 and the remote-pass 403, the timeline's duplicate detection, terminate, the https-required refusal,
// the Home switch with a wrong and a right PIN, and the Plezy tags. Loopback only, free ports; nothing reaches
// plex.tv or a real server. Usage: node tools/checks/plex-mock-check.mjs
import assert from 'node:assert/strict';
import https from 'node:https';
import { ACCOUNT_TOKEN, MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';

let n = 0;
const ok = (c, msg) => (assert.ok(c, msg), n++);
const CLIENT = { 'X-Plex-Client-Identifier': 'check-device', 'X-Plex-Product': 'Wicaby', Accept: 'application/json' };
const ports = { port: 0, tvPort: 0, relayPort: 0, secondPort: 0, tlsPort: 0 };
const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const start = (env = {}) => quiet(() => startMockPlex({ ...ports, env: { MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0', ...env } }));
const call = async (base, path, { token, method = 'GET', headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...CLIENT, ...(token ? { 'X-Plex-Token': token } : {}), ...headers } });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers };
};

const m = await start();
const tv = (p, o) => call(m.plextv, p, o);
const pms = (p, o = {}) => quiet(() => call(m.pms, p, { token: m.serverToken(), ...o }));
const MC = (r) => r.body.MediaContainer;

// ---- plex.tv: PIN link, user, resources ----
const pin = await tv('/api/v2/pins?strong=false', { method: 'POST' });
ok(pin.status === 201 && /^[A-Z0-9]{4}$/.test(pin.body.code) && pin.body.authToken === null, 'PIN: a 4-character code');
ok((await tv(`/api/v2/pins/${pin.body.id}`)).body.authToken === null, 'PIN: not linked yet');
ok((await call(m.plextv, `/Mock/Pin/Link?code=${pin.body.code}`, { method: 'POST' })).status === 200, 'PIN: linked through the mock route');
const linked = await tv(`/api/v2/pins/${pin.body.id}`);
ok(linked.body.authToken === ACCOUNT_TOKEN, 'PIN: the poll returns the account token');
const me = await tv('/api/v2/user', { token: ACCOUNT_TOKEN });
ok(me.body.title === 'Wika' && me.body.subscription.active === true && me.body.profile.autoSelectSubtitle === 1, 'user: account, Plex Pass, subtitle prefs');
const res = await tv('/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', { token: ACCOUNT_TOKEN });
const servers = res.body.filter((r) => r.provides.split(',').includes('server'));
const maison = servers.find((r) => r.clientIdentifier === MACHINE_ID);
ok(servers.length === 2 && res.body.length === 3, 'resources: two servers and a player');
ok(maison.owned && maison.accessToken === m.serverToken() && maison.accessToken !== ACCOUNT_TOKEN, 'resources: an owned server with its own token');
ok(servers.find((r) => !r.owned)?.sourceTitle === 'Léa', 'resources: a server shared by Léa');
const kinds = maison.connections.map((c) => `${c.local ? 'L' : 'R'}${c.relay ? '+relay' : ''}:${c.address}`);
ok(kinds.includes('L:127.0.0.1') && kinds.includes('L:172.17.0.2') && kinds.includes('R:203.0.113.5') && kinds.some((k) => k.startsWith('R+relay')), `resources: local, Docker decoy, remote, relay (${kinds.join(' ')})`);
ok((await tv('/api/v2/resources', { token: 'nope' })).status === 401, 'resources: a bad account token is 401');

// ---- Home users ----
const home = await tv('/api/v2/home/users', { token: ACCOUNT_TOKEN });
const ado = home.body.users.find((u) => u.title === 'Ado');
const guest = home.body.users.find((u) => u.title === 'Invité');
ok(ado.protected && !guest.protected, 'Home: Ado is protected, Invité is not');
ok((await tv(`/api/v2/home/users/${ado.uuid}/switch?pin=0000`, { token: ACCOUNT_TOKEN, method: 'POST' })).status === 401, 'Home: a wrong PIN is 401');
const sw = await tv(`/api/v2/home/users/${ado.uuid}/switch?pin=1234`, { token: ACCOUNT_TOKEN, method: 'POST' });
ok(sw.status === 201 && sw.body.authToken && sw.body.authToken !== ACCOUNT_TOKEN, 'Home: the right PIN gives Ado a token');
const adoRes = await tv('/api/v2/resources', { token: sw.body.authToken });
const adoTok = adoRes.body.find((r) => r.clientIdentifier === MACHINE_ID).accessToken;
ok(adoTok !== m.serverToken() && !adoRes.body[0].owned, "Home: Ado's own server token, not owned");
ok((await pms('/library/sections', { token: adoTok })).status === 200, "Home: Ado's server token works on the PMS");
ok((await tv(`/api/v2/home/users/${guest.uuid}/switch`, { token: ACCOUNT_TOKEN, method: 'POST' })).status === 201, 'Home: Invité needs no PIN');
await call(m.plextv, `/Mock/Home/SetPin?user=${ado.uuid}&pin=4321`, { method: 'POST' });
ok((await pms('/library/sections', { token: adoTok })).status === 401, "Home: a PIN changed upstream: Ado's old token is 401 (Plezy #553)");

// ---- PMS: identity, auth, tags ----
const id = await call(m.pms, '/identity');
ok(MC(id).machineIdentifier === MACHINE_ID && MACHINE_ID.length === 40, '/identity without auth: the 40-hex machine id');
ok((await pms('/library/sections', { token: ACCOUNT_TOKEN })).status === 401 && m.state.tags.includes('ACCOUNT-TOKEN-ON-PMS'), 'the account token is refused by the PMS and tagged');
ok((await pms('/library/sections', { headers: { 'X-Plex-Client-Identifier': '' } })).status === 400 && m.state.tags.includes('NO-CLIENT-ID'), 'no X-Plex-Client-Identifier: 400, tagged');
ok((await quiet(() => call(m.pms, `/library/sections?X-Plex-Token=${m.serverToken()}`))).status === 200 && m.state.tags.includes('TOKEN-IN-URL'), 'a token in the URL works but is tagged TOKEN-IN-URL');
ok((await pms('/no/such/route')).status === 404 && m.state.tags.includes('UNMAPPED'), 'an unknown route is a 404 tagged UNMAPPED');

// ---- Sections and metadata ----
const sections = MC(await pms('/library/sections')).Directory;
ok(sections.map((s) => `${s.key}:${s.type}`).join() === '1:movie,2:show,3:artist', 'sections: Films, Séries, Musique');
const films = MC(await pms('/library/sections/1/all?type=1', { headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '5' } }));
ok(films.totalSize === 12 && films.size === 5 && films.Metadata[0].thumb, 'Films: 12 films, paged, with posters');
ok(MC(await pms('/library/sections/1/all?type=1&includeCollections=1')).Metadata.some((x) => x.type === 'collection'), 'Films with includeCollections: the Sagas collection replaces its members');
const bbb = MC(await pms('/library/metadata/1000?includeMarkers=1&includeExtras=1&checkFiles=1')).Metadata[0];
ok(bbb.Media.length === 2 && bbb.Media.map((x) => x.editionTitle).join() === "Theatrical,Director's Cut", 'metadata: two editions');
ok(bbb.Marker.some((x) => x.type === 'intro') && bbb.Extras.Metadata.some((x) => x.extraType === 1), 'metadata: markers and a trailer extra');
ok(bbb.guid.startsWith('com.plexapp.agents.imdb://tt'), 'metadata: a legacy agent guid');
const ed = MC(await pms('/library/metadata/1001?checkFiles=1')).Metadata[0];
ok(ed.Media[1].Part[0].exists === false && ed.Media[0].Part[0].exists !== false, 'metadata: a second version whose part is missing');
ok(MC(await pms('/library/metadata/1001')).Metadata[0].Media[1].Part[0].exists === undefined, 'metadata: exists is sent only with checkFiles=1');
const cam = MC(await pms('/library/metadata/2002?includeMarkers=1')).Metadata[0];
ok(cam.Marker.map((x) => x.type).join() === 'intro,credits' && cam.Media[0].Part[0].indexes === 'sd', 'show A: intro and credits markers, a BIF index');
ok(cam.Media[0].Part[0].Stream.find((s) => s.selected && s.streamType === 2)?.languageCode === 'fre', 'show A: the per-show audio memory (selected French)');
ok(MC(await pms('/library/metadata/2100')).Metadata[0].flattenSeasons === 1, 'show B: flattenSeasons');
const finale = MC(await pms('/library/metadata/2210,2211')).Metadata;
ok(finale.length === 2 && finale[0].Media[0].Part[0].id === finale[1].Media[0].Part[0].id, 'show C: s02e17 and e18 share one part');
const bif = await fetch(`${m.pms}/library/parts/${cam.Media[0].Part[0].id}/indexes/sd`, { headers: { ...CLIENT, 'X-Plex-Token': m.serverToken() } });
const bifBytes = Buffer.from(await bif.arrayBuffer());
ok(bif.status === 200 && bifBytes.subarray(1, 4).toString() === 'BIF', 'the BIF index of a part');
const search = MC(await pms('/hubs/search?query=agent&limit=5'));
ok(search.Hub.some((h) => h.Metadata.some((x) => x.ratingKey === '1100')), 'search finds the single shared item (Plezy #702)');
ok(MC(await pms('/hubs/search?query=agent&limit=5&sectionId=999')).Hub.length === 0, 'search: sectionId scopes the hits');
const deck = MC(await pms('/library/metadata/2000?includeOnDeck=1')).Metadata[0].OnDeck?.Metadata ?? [];
ok(deck.length === 1 && deck[0].type === 'episode' && deck[0].grandparentRatingKey === '2000', "includeOnDeck: the show's own next episode (Series page NextUp)");
ok(MC(await pms('/library/onDeck')).Metadata.some((x) => x.type === 'movie'), 'onDeck holds movies too: NextUp keeps episodes only');
const promoted = MC(await pms('/hubs/promoted')).Hub.map((h) => h.hubIdentifier);
ok(promoted.includes('home.continue') && promoted.includes('home.television.recent') && promoted.includes('custom.collection.5000'), 'hubs/promoted: Continue, Recently added TV, the pinned collection');
const img = await fetch(`${m.pms}/photo/:/transcode?${new URLSearchParams({ url: films.Metadata[0].thumb, width: '300', height: '450', minSize: '0' })}`, { headers: { ...CLIENT, 'X-Plex-Token': m.serverToken() } });
ok(img.status === 200 && /image\//.test(img.headers.get('content-type')), 'a poster through /photo/:/transcode');

// ---- Decision ----
const profile = { 'X-Plex-Client-Profile-Extra': 'add-direct-play-profile(type=videoProfile&container=mkv&videoCodec=h264&audioCodec=aac,eac3)' };
const dec = (rk, extra = '', headers = profile) => pms(`/video/:/transcode/universal/decision?path=/library/metadata/${rk}&mediaIndex=0&partIndex=0&protocol=hls&directPlay=1&directStream=1&session=s-${rk}${extra}`, { headers });
const direct = MC(await dec(1006));
ok(direct.Metadata[0].Media[0].Part[0].decision === 'directplay' && direct.directPlayDecisionCode === 1000, 'decision: h264 MKV plays direct');
ok(MC(await dec(1002)).Metadata[0].Media[0].Part[0].decision === 'transcode', 'decision: HEVC with an h264-only profile transcodes');
ok(MC(await dec(1004, '&subtitles=burn')).Metadata[0].Media[0].Part[0].decision === 'transcode', 'decision: burning PGS transcodes');
const capped = await start({ MOCK_REMOTE_CAP_KBPS: '4000' });
const cappedDec = (q) => quiet(() => call(capped.pms, `/video/:/transcode/universal/decision?path=/library/metadata/1006&mediaIndex=0&session=c&remote=1${q}`, { token: capped.serverToken(), headers: profile }));
const over = await cappedDec('');
ok(over.status === 500 && over.body === 'Cannot make a decision', 'remote cap: Original over the cap is 500 "Cannot make a decision"');
ok((await cappedDec('&maxVideoBitrate=3000')).status === 200, 'remote cap: under the cap it plays');
ok((await quiet(() => call(capped.pms, '/video/:/transcode/universal/decision?path=/library/metadata/1006&session=l', { token: capped.serverToken(), headers: profile }))).status === 200, 'remote cap: a local request is not capped');
const viaRelay = await quiet(() => call(capped.relay, '/video/:/transcode/universal/decision?path=/library/metadata/1006&session=r', { token: capped.serverToken(), headers: profile }));
ok(viaRelay.status === 500, 'the relay is remote (and capped)');
await capped.close();
const nopass = await start({ MOCK_REMOTE_PASS: '0' });
const denied = await quiet(() => call(nopass.pms, '/video/:/transcode/universal/decision?path=/library/metadata/1006&remote=1', { token: nopass.serverToken(), headers: profile }));
ok(denied.status === 403 && /Plex Pass/.test(denied.body.errors[0].message), 'remote pass: a remote decision is 403 with the reason');
await nopass.close();

// ---- Transcoder: offset start ----
const master = (await pms('/video/:/transcode/universal/start.m3u8?session=s1&offset=600')).body;
const media = (await pms(`/video/:/transcode/universal/${master.split('\n')[2]}`)).body;
ok(/#EXT-X-MEDIA-SEQUENCE:100/.test(media) && /\n100\.ts/.test(media), 'start.m3u8 starts at the offset (600 s = segment 100)');
const before = m.state.tags.length;
await pms('/video/:/transcode/universal/session/s1/base/100.ts?offset=600');
ok(!m.state.tags.slice(before).includes('SEEK-AFTER-OFFSET'), 'a segment at the offset is fine');
await pms('/video/:/transcode/universal/session/s1/base/0.ts?offset=600');
ok(m.state.tags.includes('SEEK-AFTER-OFFSET'), 'a segment before the offset is tagged SEEK-AFTER-OFFSET');

// ---- Timeline, scrobble, terminate, part PUT ----
const tl = (state, time, session = 'sess-1', rk = 1008) => pms(`/:/timeline?ratingKey=${rk}&key=/library/metadata/${rk}&state=${state}&time=${time}&duration=600000`, { headers: { 'X-Plex-Session-Identifier': session } });
for (const [st, t] of [['playing', 1000], ['paused', 5000], ['playing', 6000], ['stopped', 580_000]]) await tl(st, t);
ok(m.state.timelines.filter((x) => x.session === 'sess-1').map((x) => x.state).join() === 'playing,paused,playing,stopped', 'timeline: every state recorded');
ok(!m.state.tags.includes('DUP-STOPPED') && !m.state.tags.includes('DUP-SCROBBLE'), 'timeline: one stopped, no duplicate');
ok(MC(await pms('/library/metadata/1008')).Metadata[0].viewCount === 1, 'timeline: stopped past 90 % marks it watched (no scrobble needed)');
await tl('stopped', 580_000);
ok(m.state.tags.includes('DUP-STOPPED'), 'timeline: a second stopped is tagged DUP-STOPPED');
await pms('/:/scrobble?key=1008&identifier=com.plexapp.plugins.library');
ok(m.state.tags.includes('DUP-SCROBBLE'), 'a scrobble right after a stopped past 90 % is tagged DUP-SCROBBLE');
await call(m.pms, '/Mock/Terminate?session=sess-2&reason=Server%20maintenance', { method: 'POST' });
const term = MC(await tl('playing', 1000, 'sess-2', 1009));
ok(term.terminationCode && term.terminationText === 'Server maintenance', 'terminate: the next timeline carries the reason');
await pms(`/library/parts/${cam.Media[0].Part[0].id}?audioStreamID=${cam.Media[0].Part[0].Stream.find((s) => s.streamType === 2 && !s.selected).id}&allParts=1`, { method: 'PUT' });
ok(m.state.partPuts.length === 1 && MC(await pms('/library/metadata/2002')).Metadata[0].Media[0].Part[0].Stream.find((s) => s.selected && s.streamType === 2).languageCode === 'eng', 'track choice: PUT /library/parts/{id} stores the audio stream');
ok(MC(await pms('/livetv/dvrs')).size === 0, 'Live TV: no DVR by default');

// ---- Switches: https required, PIN expiry, flaky, no Plex Pass ----
const secure = await start({ MOCK_PLEX_HTTPS_REQUIRED: '1', MOCK_PLEX_TLS: '1', MOCK_PIN_TTL_S: '0', MOCK_PLEX_PASS: '0' });
ok((await quiet(() => call(secure.pms, '/library/sections', { token: secure.serverToken() }))).status === 403 && secure.state.tags.includes('HTTP-REFUSED'), 'https required: a plain-http call is 403 HTTP-REFUSED');
const secRes = (await call(secure.plextv, '/api/v2/resources', { token: ACCOUNT_TOKEN })).body[0];
ok(secRes.httpsRequired === true && secRes.connections.some((c) => c.protocol === 'https' && c.uri.includes('.plex.direct:')), 'https required: resources say so and list a plex.direct https connection');
// The TEST ONLY self-signed pair: verification off for this one request.
const tlsOk = await new Promise((resolve) => {
  https.request(`${secure.pmsTls}/library/sections`, { headers: { ...CLIENT, 'X-Plex-Token': secure.serverToken() }, rejectUnauthorized: false }, (r) => (r.resume(), resolve(r.statusCode))).on('error', () => resolve(0)).end();
});
ok(tlsOk === 200, 'https required: the TLS listener answers');
const expiring = await call(secure.plextv, '/api/v2/pins', { method: 'POST' });
await new Promise((r) => setTimeout(r, 20));
ok((await call(secure.plextv, `/api/v2/pins/${expiring.body.id}`)).status === 404, 'MOCK_PIN_TTL_S: an expired PIN is 404');
ok((await call(secure.plextv, '/api/v2/user', { token: ACCOUNT_TOKEN })).body.subscription.active === false, 'MOCK_PLEX_PASS=0: no Plex Pass on the account');
await secure.close();
const flaky = await start({ MOCK_PLEX_FLAKY: '1', MOCK_PLEX_PASS: '0' });
const f1 = await quiet(() => call(flaky.pms, '/library/sections', { token: flaky.serverToken() }));
const f2 = await quiet(() => call(flaky.pms, '/library/sections', { token: flaky.serverToken() }));
ok(f1.status === 500 && f2.status === 200, 'MOCK_PLEX_FLAKY: the first call of the minute is 500, the retry works');
ok((await quiet(() => call(flaky.pms, '/livetv/dvrs', { token: flaky.serverToken() }))).status === 403, 'MOCK_PLEX_PASS=0: /livetv/dvrs is 403');
await flaky.close();

// No call ever left loopback: every URL the mock listed is 127.0.0.1, a documentation address or a plex.direct name.
ok(maison.connections.every((c) => /^(127\.0\.0\.1|172\.17\.0\.2|203\.0\.113\.5)$/.test(c.address)), 'resources list only loopback, Docker-bridge and documentation addresses');
await m.close();
console.log(`plex-mock-check: ok (${n} checks)`);
