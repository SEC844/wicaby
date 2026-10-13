// Self-check for the track-selection engine (src/main/playback/track-selection.ts).
// Run: node tools/checks/track-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchIntent, migrateChoice, normLang, pickAudio, pickSubtitle, rememberChoice, sameLang, selectTracks } from '../../apps/desktop/src/main/playback/track-selection.ts';
import { readScoped, writeScoped } from '../../apps/desktop/src/main/playback/scoped-prefs.ts';

const a = (Index, Language, extra = {}) => ({ Index, Type: 'Audio', Language, ...extra });
const s = (Index, Language, extra = {}) => ({ Index, Type: 'Subtitle', Language, ...extra });
const prefs = (mode, audioLanguage = 'fre', subtitleLanguage = 'fre') => ({ mode, audioLanguage, subtitleLanguage });

// Languages
assert.equal(normLang('fr-FR'), 'fre');
assert.equal(normLang('FRA'), 'fre');
assert.equal(normLang('und'), '');
assert.ok(sameLang('en', 'eng'));
assert.ok(!sameLang(undefined, ''));
assert.ok(!sameLang('und', 'und'));

// An anime: Japanese and French audio, French full + forced, English full.
const anime = [
  { Index: 0, Type: 'Video' },
  a(1, 'jpn', { IsDefault: true }),
  a(2, 'fre'),
  a(3, 'fre', { Title: 'Commentaire' }),
  s(4, 'fre', { IsForced: true }),
  s(5, 'fre', { Title: 'SDH' }),
  s(6, 'fre'),
  s(7, 'eng'),
];

// Audio: preferred language, skipping the commentary; then server default; then the file default.
assert.equal(pickAudio(anime, {}, prefs('foreign')), 2);
assert.equal(pickAudio(anime, { audio: 1 }, prefs('foreign', 'ger')), 1);
assert.equal(pickAudio(anime, {}, prefs('foreign', '')), 1);
assert.equal(pickAudio([], {}, prefs('foreign')), null);

// Foreign: French audio gets the forced track only, Japanese audio gets full French (not SDH).
assert.equal(pickSubtitle(anime, 2, {}, prefs('foreign')), 4);
assert.equal(pickSubtitle(anime, 1, {}, prefs('foreign')), 6);
// Unknown audio language is not foreign.
assert.equal(pickSubtitle([a(1, 'und'), s(2, 'fre')], 1, {}, prefs('foreign')), null);
// No language preference at all: server default.
assert.equal(pickSubtitle(anime, 1, { subtitle: 7 }, prefs('foreign', '', '')), 7);

// Manual: forced only, whatever the audio.
assert.equal(pickSubtitle(anime, 1, {}, prefs('manual')), 4);
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'fre')], 1, {}, prefs('manual')), null);
// Forced flag spelled in the title only.
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'fre', { Title: 'Français (forcés)' })], 1, {}, prefs('manual')), 2);

// Always: full track in my language, else forced, else server default.
assert.equal(pickSubtitle(anime, 2, {}, prefs('always')), 6);
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'eng'), s(3, 'ger')], 1, { subtitle: 3 }, prefs('always')), 3);
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'eng')], 1, {}, prefs('always')), null);
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'eng', { IsForced: true }), s(3, 'ger')], 1, {}, prefs('always', '', '')), 2);
assert.equal(pickSubtitle([a(1, 'eng'), s(2, 'ger')], 1, {}, prefs('always', '', '')), 2);

// Default: the server's choice, validated against the list.
assert.equal(pickSubtitle(anime, 1, { subtitle: 7 }, prefs('default')), 7);
assert.equal(pickSubtitle(anime, 1, { subtitle: 99 }, prefs('default')), null);
assert.equal(pickSubtitle(anime, 1, { subtitle: -1 }, prefs('default')), null);

// Per-series memory overrides the mode, and falls back when the episode lacks that track.
let doc = {};
doc = rememberChoice(doc, 'series', 'subtitle', s(7, 'eng'), 1);
doc = rememberChoice(doc, 'series', 'audio', a(1, 'jpn'), 2);
assert.deepEqual(doc.series, { audio: { language: 'jpn', commentary: false, ordinal: -1, forced: false }, subtitle: { language: 'eng', commentary: false, ordinal: -1, forced: false, sdh: false }, at: 2 });
assert.deepEqual(selectTracks(anime, {}, prefs('foreign'), doc.series), { audio: 1, subtitle: 7, applied: true });
assert.equal(pickSubtitle([a(1, 'jpn'), s(2, 'fre')], 1, {}, prefs('foreign'), doc.series), 2);
doc = rememberChoice(doc, 'series', 'subtitle', null, 3);
assert.equal(pickSubtitle(anime, 1, {}, prefs('always'), doc.series), null);
// Untagged audio is not remembered.
assert.equal(rememberChoice(doc, 'series', 'audio', a(1, undefined), 4), doc);
// Cap at 300 series, oldest dropped.
let big = {};
for (let i = 0; i < 305; i++) big = rememberChoice(big, `s${i}`, 'subtitle', null, i);
assert.equal(Object.keys(big).length, 300);
assert.ok(!('s0' in big) && 's304' in big);

// Explicit request indexes win; -1 means no subtitles.
assert.deepEqual(selectTracks(anime, {}, prefs('always'), undefined, 1, -1), { audio: 1, subtitle: null, applied: false });
assert.deepEqual(selectTracks(anime, {}, prefs('manual'), undefined, 2, 7), { audio: 2, subtitle: 7, applied: false });
// Explicit audio drives the foreign check.
assert.deepEqual(selectTracks(anime, {}, prefs('foreign'), undefined, 1), { audio: 1, subtitle: 6, applied: false });
// A memory that picks what the mode would have picked anyway raises no toast.
assert.equal(selectTracks(anime, {}, prefs('foreign'), rememberChoice({}, 's', 'audio', anime[2], 1, anime).s).applied, false);

// ---- X-05 golden vectors, shared with TrackMemoryTest.kt ----
const fxPath = path.join(import.meta.dirname, 'fixtures', 'track', 'track-fixtures.json');
const fxRaw = fs.readFileSync(fxPath, 'utf8');
const fx = JSON.parse(fxRaw);
const copy = path.join(import.meta.dirname, '..', '..', 'apps', 'android', 'core', 'src', 'test', 'resources', 'track-fixtures.json');
assert.equal(fs.readFileSync(copy, 'utf8'), fxRaw, 'the Kotlin copy differs: run node tools/checks/sync-track-fixtures.mjs');

// The shared contract: the index the memory picks, -1 = subtitles off, null = no match (the mode decides).
const viaMemory = (kind, choice, streams) => {
  const c = migrateChoice(choice);
  const intent = kind === 'audio' ? c?.audio : c?.subtitle;
  if (intent === null) return -1;
  return intent ? (matchIntent(streams, kind === 'audio' ? 'Audio' : 'Subtitle', intent) ?? null) : null;
};
for (const m of fx.matching) {
  const picked = m.picked === null ? null : m.episode1.find((s) => s.Index === m.picked);
  const mem = rememberChoice({}, 'x', m.kind, picked, 1, m.episode1).x;
  assert.equal(viaMemory(m.kind, mem, m.episode2), m.expect, m.name);
  // Round trip through the file.
  assert.equal(viaMemory(m.kind, JSON.parse(JSON.stringify(mem)), m.episode2), m.expect, `${m.name} (reloaded)`);
}
for (const l of fx.legacy) assert.equal(viaMemory(l.kind, l.choice, l.streams), l.expect, l.name);
// Acceptance 4: an old file still drives selectTracks.
assert.deepEqual(selectTracks(fx.legacy[0].streams, {}, prefs('manual', 'fre', 'fre'), fx.legacy[0].choice), { audio: 2, subtitle: 4, applied: true });
for (const sc of fx.scopes) {
  let d = {};
  sc.steps.forEach((st, i) => {
    if (st.op === 'set') d = writeScoped(d, st.prop, st.scope, st.ctx, st.value, i);
    else assert.deepEqual(readScoped(d, st.prop, st.scope, st.ctx) ?? null, st.expect, `${sc.name}, step ${i}`);
  });
}
// At most 300 entries per scope, oldest out.
let sd = {};
for (let i = 0; i < 305; i++) sd = writeScoped(sd, 'speed', 'title', { title: `t${i}` }, 1.5, i);
assert.equal(Object.keys(sd.speed.title).length, 300);
assert.ok(!('t0' in sd.speed.title) && 't304' in sd.speed.title);

console.log('track-selection: all checks passed');
