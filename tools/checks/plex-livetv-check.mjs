// Plex Live TV and DVR on the desktop (plex-spec §7, PX-11), with the real ConnectionManager and PlexClient (bundled
// for Node) against tools/mock-server/mock-plex.mjs (MOCK_PLEX_LIVETV=1) on loopback, signed in as the owner. The
// renderer's own Live TV calls (shared/livetv/dialect.ts with kind 'plex'), Emby-shaped in and out:
// - the gate: Live TV (the 'livetv' view, /LiveTv/Info IsEnabled) only with Plex Pass and a tuner; without Plex Pass
//   (MOCK_PLEX_PASS=0) or without a DVR it stays hidden;
// - the guide: 8 enabled channels of 9 (the ChannelMapping), a programmes tile, now/next, "on now", films only,
//   search, a programme's detail; an unmapped category answers 404 PLEX-UNMAPPED, never a wrong list;
// - the DVR: record one airing and a series rule (defaults, then create), the timer overlay marks them, the rule
//   lists and updates, one airing of a rule cannot be cancelled alone, a timer reads back (the record-options sheet)
//   and its padding updates, cancel the airing, delete the rule;
// - recordings: a subscribed show's own library episodes are not recordings (nothing listed, a delete answers 404 and
//   sends no DELETE); a finished recording (one more mpegts version) is listed, and its delete removes that version only;
// - the global search's Live TV half: channels and programmes (Plex Live TV on), nothing without it;
// - tune: PlaybackInfo on a channel tunes it (HLS through start.m3u8, picked as a transcode), the Stopped report and
//   /LiveStreams/Close stop the transcode;
// - /Mock/State: zero UNMAPPED, GRID-NO-WINDOW, BAD-SUBSCRIPTION, TOKEN-IN-URL, NO-CLIENT-ID.
// Every PMS shape here is unverified against a real server (PLEX-LIVETV-UNVERIFIED): this proves the mapping.
// Usage: node tools/checks/plex-livetv-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';
import { bundlePlex, identity, quiet, refused } from './plex-bundle.mjs';

const F = await bundlePlex();
const D = F.liveDialect;
const K = 'plex';
let n = 0;
const ok = (c, msg) => (assert.ok(c, msg), n++);
const HOUR = 3_600_000;

async function signIn(env) {
  const mock = await quiet(() => startMockPlex({ port: 0, tvPort: 0, relayPort: 0, env: { MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0', ...env } }));
  process.env.WICABY_PLEXTV_BASE = mock.plextv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plexlive-'));
  const vault = await F.CredentialVault.open(path.join(dir, 'vault.bin'));
  const cm = new F.ConnectionManager(path.join(dir, 'servers.json'), vault, identity);
  const pin = await cm.plexLink();
  await fetch(`${mock.plextv}/Mock/Pin/Link?code=${pin.code}`, { method: 'POST' });
  for (let i = 0; i < 100 && (await cm.plexPoll()).status !== 'linked'; i++) await new Promise((r) => setTimeout(r, 50));
  await cm.select(MACHINE_ID);
  await cm.plexConfirm(MACHINE_ID, cm.session.sessions[0].confirm);
  await cm.login('Wika', '', MACHINE_ID);
  const api = cm.apiFor(MACHINE_ID);
  const run = (r) => (r ? api.request(r.method, r.path, r.query, r.body) : Promise.reject(new Error('no request for this op')));
  return { mock, cm, api, run, uid: cm.sessionFor(MACHINE_ID).user.id };
}

const status = (p) => p.then(
  () => 200,
  (e) => e.status ?? -1,
);

try {
  await quiet(async () => {
    // ---- The gate ----
    for (const [env, why] of [
      [{ MOCK_PLEX_LIVETV: '1', MOCK_PLEX_PASS: '0' }, 'without Plex Pass'],
      [{ MOCK_PLEX_LIVETV: '0' }, 'without a DVR tuner'],
    ]) {
      const s = await signIn(env);
      try {
        const views = (await s.api.request('GET', `/Users/${s.uid}/Views`)).Items;
        ok(!views.some((v) => v.CollectionType === 'livetv'), `${why}: no Live TV view`);
        ok((await s.run(D.info(K))).IsEnabled === false, `${why}: /LiveTv/Info says IsEnabled false`);
        ok((await s.api.request('GET', `/Users/${s.uid}/Items`, { SearchTerm: 'studio', IncludeItemTypes: 'TvChannel,LiveTvProgram' })).Items.length === 0, `${why}: the global search finds no Live TV`);
      } finally {
        await s.cm.logout(MACHINE_ID).catch(() => {});
        await s.mock.close();
      }
    }

    const { mock, cm, api, run, uid } = await signIn({ MOCK_PLEX_LIVETV: '1' });
    try {
      const views = (await api.request('GET', `/Users/${uid}/Views`)).Items;
      ok(views.some((v) => v.CollectionType === 'livetv' && v.Id === 'livetv'), 'Plex Pass and a tuner: the Live TV view is listed');
      const info = await run(D.info(K));
      ok(info.IsEnabled === true && info.Services[0].Tuners.length === 2 && info.PlexPass === true, '/LiveTv/Info: enabled, 2 tuners');
      ok(typeof (await run(D.guideInfo(K))) === 'object', '/LiveTv/GuideInfo answers (the guide keeps its default range)');

      // ---- Guide ----
      const page = await run(D.channelsPage(K, { userId: uid, startIndex: 0, limit: 500 }));
      const rows = page.Items.map((c, i) => F.normalizeChannel(c, MACHINE_ID, i)).filter(Boolean);
      ok(page.TotalRecordCount === 8 && rows.length === 8, '8 enabled channels of the 9 in the lineup (ChannelMapping)');
      ok(rows.some((r) => r.number === '5.1' && /^[A-Za-z0-9-]{1,64}$/.test(r.id)), "channel '5.1' keeps its number and gets a valid id");
      ok(!rows.some((r) => r.name === 'Hors bouquet'), 'the disabled channel is left out');
      const second = await run(D.channelsPage(K, { userId: uid, startIndex: 5, limit: 5 }));
      ok(second.Items.length === 3 && second.StartIndex === 5, 'channel pages page');

      const now = Date.now();
      const from = Math.floor(now / HOUR) * HOUR;
      const ids = rows.slice(0, 4).map((r) => r.id);
      const tile = (await run(D.programsTile(K, { userId: uid, channelIds: ids, from, to: from + 3 * HOUR, genres: true }))).Items.map((p) => F.normalizeProgram(p, { kind: K })).filter(Boolean);
      ok(tile.length > 0 && tile.every((p) => ids.includes(p.channelId) && p.end > from && p.start <= from + 3 * HOUR), 'a tile: only its channels, inside its window');
      ok(tile.filter((p) => p.channelId === rows[0].id).length >= 6, 'the news channel airs every 30 min');
      const film = tile.find((p) => p.channelId === rows[1].id);
      ok(film && (film.flags & 32) !== 0, 'a film carries the Movie flag');
      const episode = tile.find((p) => p.channelId === rows[2].id);
      ok(episode && episode.episodeTitle && episode.season === 1 && (episode.flags & 512) !== 0, 'an episode carries its title, numbers and the Series flag');

      const nowNext = (await run(D.programNowNext(K, { userId: uid, channelId: rows[1].id, now }))).Items;
      ok(nowNext.length >= 2 && nowNext.length <= 4 && Date.parse(nowNext[0].StartDate) <= now && Date.parse(nowNext[0].EndDate) > now, 'now/next: the airing now first, at most 4');
      const onNow = (await run(D.onNow(K, { userId: uid, now }))).Items;
      ok(onNow.length === 8 && onNow.every((p) => Date.parse(p.StartDate) <= now && Date.parse(p.EndDate) > now), '"On now": one airing per channel, all airing now');
      const films = (await run(D.onLater(K, { userId: uid, now, category: 'movies' }))).Items;
      ok(films.length > 0 && films.every((p) => p.IsMovie === true), 'films later: films only (the grid type)');
      ok((await status(run(D.onNow(K, { userId: uid, now, category: 'sports' })))) === 404, 'an unmapped category answers 404 PLEX-UNMAPPED, not every programme');
      ok((await status(run(D.channelCategorySet(K, { userId: uid, category: 'movies' })))) === 404, 'channel categories: 404 (unmapped)');
      const found = (await run(D.searchPrograms(K, { userId: uid, query: 'studio diaries', now, guideEnd: now + 24 * HOUR }))).Items;
      ok(found.length > 0 && found.every((p) => p.Name === 'Studio Diaries'), 'search finds a show by name');
      const detail = await run(D.programDetail(K, { userId: uid, id: episode.id }));
      ok(detail.Id === episode.id && typeof detail.Overview === 'string', 'a programme detail has its overview');

      // ---- DVR ----
      const later = tile.filter((p) => p.channelId === rows[1].id && p.start > now)[0] ?? (await run(D.programNowNext(K, { userId: uid, channelId: rows[1].id, now }))).Items.map((p) => F.normalizeProgram(p, { kind: K }))[1];
      const defaults = await run(D.timerDefaults(K, { programId: later.id }));
      ok(defaults.ProgramId === later.id && defaults.ChannelId === later.channelId, 'timer defaults from the guide programme');
      await run(D.createTimer(K, { body: { ...defaults, PrePaddingSeconds: 120, PostPaddingSeconds: 300 } }));
      const sd = tile.find((p) => p.channelId === rows[2].id && p.start > now) ?? episode;
      const ruleDefaults = await run(D.timerDefaults(K, { programId: sd.id }));
      await run(D.createSeriesTimer(K, { body: { ...ruleDefaults, RecordAnyChannel: true, RecordNewOnly: false } }));
      ok(mock.state.liveSubs.length === 2 && mock.state.liveSubs.some((s) => s.type === 1 && s.Setting.some((x) => x.id === 'startOffsetMinutes' && x.value === '2')), 'two subscriptions: the film (padding in minutes) and the series');
      ok((await status(run(D.createTimer(K, { body: defaults })))) === 400, 'the same film again: 400 (already scheduled)');

      const timers = F.normalizeTimers((await run(D.timers(K))).Items);
      const overlay = F.buildOverlay(timers);
      const one = overlay.get(later.id);
      ok(one && one.status === 'scheduled' && one.prePaddingS === 120 && one.postPaddingS === 300 && !one.seriesTimerId, 'the overlay marks the film, with its padding');
      const ruleTimers = timers.filter((x) => x.seriesTimerId);
      ok(ruleTimers.length > 3 && ruleTimers.every((x) => x.channelId === rows[2].id), 'the series rule schedules its airings');
      const rules = (await run(D.seriesTimers(K))).Items;
      ok(rules.length === 1 && rules[0].Name === 'Studio Diaries' && rules[0].RecordAnyChannel === true, 'one series rule');
      const ruleId = rules[0].Id;
      ok((await run(D.timersOfRule(K, { id: ruleId }))).Items.length === ruleTimers.length, "a rule's timers");
      const current = await run(D.seriesTimer(K, { id: ruleId }));
      await run(D.updateSeriesTimer(K, { id: ruleId, body: { ...current, RecordNewOnly: true } }));
      ok((await run(D.seriesTimer(K, { id: ruleId }))).RecordNewOnly === true, 'the rule updates (new airings only)');
      const fewer = F.normalizeTimers((await run(D.timers(K))).Items).filter((x) => x.seriesTimerId);
      ok(fewer.length > 0 && fewer.length < ruleTimers.length, 'new only: fewer airings');
      ok((await status(run(D.cancelTimer(K, { id: fewer[0].id })))) === 404, 'one airing of a rule cannot be cancelled alone (404 PLEX-UNMAPPED)');
      // The record-options sheet (RecordOptionsSheet.svelte, RecordOptions.kt, RecordOptionsSheet.kt) reads the timer first.
      const read = await api.request('GET', `/LiveTv/Timers/${encodeURIComponent(one.id)}`);
      ok(read.Id === one.id && read.PrePaddingSeconds === 120 && read.PostPaddingSeconds === 300, 'GET /LiveTv/Timers/{id}: the timer and its padding');
      ok((await status(api.request('GET', '/LiveTv/Timers/rec-999999'))) === 404, 'an unknown timer: 404');
      await run(D.updateTimer(K, { id: one.id, body: { ...read, PrePaddingSeconds: 0, PostPaddingSeconds: 600 } }));
      ok(F.normalizeTimers((await run(D.timers(K))).Items).find((x) => x.id === one.id)?.postPaddingS === 600, "a timer's padding updates");

      // Recordings: subscribing records nothing yet, so the show's own library episodes are not recordings.
      ok((await run(D.recordings(K, { userId: uid }))).Items.length === 0, 'recordings: none before the DVR recorded anything (own library episodes are not listed)');
      ok((await status(run(D.deleteRecording(K, { id: '2102' })))) === 404 && mock.state.deletes.length === 0, "a subscribed show's own episode cannot be deleted as a recording: 404, no DELETE sent");
      await fetch(`${mock.pms}/Mock/LiveTv/Record?ratingKey=2103`, { method: 'POST' });
      const recs = (await run(D.recordings(K, { userId: uid }))).Items;
      ok(recs.length === 1 && recs[0].SeriesName === 'Studio Diaries' && /2103/.test(recs[0].Id), 'recordings: the item the DVR recorded, only');
      await run(D.deleteRecording(K, { id: recs[0].Id }));
      ok(mock.state.deletes.length === 1 && mock.state.deletes[0] === '/library/metadata/2103/media/21039', 'deleting a recording removes its recorded version only, never the item');
      ok((await run(D.recordings(K, { userId: uid }))).Items.length === 0 && (await api.request('GET', `/Users/${uid}/Items/${recs[0].Id}`)).Name === 'Storyboard', "the user's own version stays");
      ok((await run(D.recordings(K, { userId: uid, inProgress: true }))).Items.length === 0, 'no recording in progress listed as an item');
      ok(Array.isArray((await run(D.recordingOptions(K, { userId: uid }))).Items), 'recording folders: none to pick (PMS chooses)');

      // The global search's Live TV half (renderer/lib/api.ts searchLive).
      const searchLive = (term) => api.request('GET', `/Users/${uid}/Items`, { SearchTerm: term, Recursive: true, Limit: 20, IncludeItemTypes: 'TvChannel,LiveTvProgram', Fields: 'ChannelInfo', EnableImages: false });
      const liveFound = (await searchLive('studio')).Items;
      ok(liveFound.some((x) => x.Type === 'TvChannel' && x.Name === 'Studio TV') && liveFound.some((x) => x.Type === 'Program' && x.Name === 'Studio Diaries' && x.ChannelName === 'Studio TV'), 'global search: the channel and its programmes');
      ok(liveFound.length <= 20 && liveFound.filter((x) => x.Type === 'Program').every((x) => Date.parse(x.EndDate) > Date.now()), 'global search: within the limit, nothing ended');

      await run(D.cancelTimer(K, { id: one.id }));
      await run(D.deleteSeriesTimer(K, { id: ruleId }));
      ok(mock.state.liveSubs.length === 0 && (await run(D.timers(K))).Items.length === 0, 'cancel the film and delete the rule: nothing scheduled');

      // ---- Tune ----
      const ch = rows[3];
      const pb = await run(D.tune(K, { userId: uid, channelId: ch.id, maxBitrate: 20_000_000, rung: 0, deviceProfile: {} }));
      const src = pb.MediaSources[0];
      ok(mock.state.tunes.at(-1) === '4' && src.LiveStreamId === pb.PlaySessionId && src.RequiresOpening === false, 'PlaybackInfo on a channel tunes it on its DVR');
      const pick = F.pickPlay(src, { channelId: ch.id, rung: 0, deviceId: identity.deviceId, playSessionId: pb.PlaySessionId, staticOk: true, kind: K });
      ok(pick?.play.kind === 'transcode' && pick.isHls && /^\/video\/:\/transcode\/universal\/start\.m3u8\?/.test(pick.play.url) && /path=%2Flivetv%2Fsessions%2F/.test(pick.play.url), 'the live ladder plays HLS through start.m3u8 (path = the live session)');
      ok(/maxVideoBitrate=20000/.test(pick.play.url) && !/X-Plex-Token/i.test(pick.play.url), 'the cap rides along, never the token');
      const m3u8 = await fetch(`${mock.pms}${pick.play.url}`, { headers: { 'X-Plex-Token': mock.serverToken(), 'X-Plex-Client-Identifier': identity.deviceId } });
      ok(m3u8.status === 200 && (await m3u8.text()).startsWith('#EXTM3U'), 'start.m3u8 answers a playlist');
      const report = { itemId: ch.id, mediaSourceId: src.Id, playSessionId: pb.PlaySessionId, liveStreamId: src.LiveStreamId, playMethod: 'Transcode' };
      await run(D.reportPlaying(K, report));
      await run(D.reportProgress(K, report));
      ok(mock.state.timelines.length === 0, 'live reports send no library timeline');
      await run(D.reportStopped(K, report));
      ok(mock.state.stops.includes(pb.PlaySessionId), 'the Stopped report stops the transcode (the tuner is free)');
      const pb2 = await run(D.tune(K, { userId: uid, channelId: rows[0].id, maxBitrate: 8_000_000, rung: 2, deviceProfile: {}, autoOpen: false }));
      ok(/directStream=0/.test(pb2.MediaSources[0].TranscodingUrl), 'rung 2: a full transcode');
      await run(D.close(K, { liveStreamId: pb2.MediaSources[0].LiveStreamId, playSessionId: pb2.PlaySessionId }));
      ok(mock.state.stops.includes(pb2.PlaySessionId), '/LiveStreams/Close stops that transcode');
      ok((await status(run(D.open(K, { userId: uid, itemId: ch.id, playSessionId: 'x', maxBitrate: 1, openToken: 't' })))) === 404, '/LiveStreams/Open is never needed: 404');

      const tags = mock.state.tags.filter((t) => ['UNMAPPED', 'GRID-NO-WINDOW', 'BAD-SUBSCRIPTION', 'TOKEN-IN-URL', 'NO-CLIENT-ID', 'NO-TOKEN', 'ACCOUNT-TOKEN-ON-PMS'].includes(t));
      ok(tags.length === 0, `mock tags: ${tags.join(', ') || 'none'}`);
    } finally {
      await cm.logout(MACHINE_ID).catch(() => {});
      await mock.close();
    }
  });
  ok(refused.length === 0, `nothing left loopback (${refused.join(', ')})`);
  console.log(`plex-livetv-check: ok (${n} assertions)`);
  process.exit(0);
} catch (err) {
  console.error('plex-livetv-check: FAILED');
  console.error(err);
  process.exit(1);
}
