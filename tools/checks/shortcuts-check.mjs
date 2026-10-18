// X-04 shortcut table (apps/desktop/src/shared/shortcuts.ts), feature-specs.md §4 and
// livetv-spec-final.md §21.10: the defaults have no conflict inside any context, keep the keys of the
// fixed switch they replaced, absorb the Live TV rows, and import validation is all-or-nothing.
// Run: node tools/checks/shortcuts-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const shared = path.resolve(here, '../../apps/desktop/src/shared');
const localesDir = path.resolve(here, '../../apps/desktop/src/renderer/locales');

// The shared modules import each other without an extension; Node's type stripping needs the '.ts'.
const sharedUrl = pathToFileURL(shared).href + '/';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sharedUrl) && !/\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
  },
});
const sc = await import(pathToFileURL(path.join(shared, 'shortcuts.ts')).href);
const keys = await import(pathToFileURL(path.join(shared, 'livetv', 'keys.ts')).href);

let failures = 0;
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
};

// 1. No conflict inside any context; ids unique.
check('defaults have no conflict in any context', () => assert.deepEqual(sc.conflicts(), []));
check('row ids are unique', () => assert.equal(new Set(sc.SHORTCUTS.map((r) => r.id)).size, sc.SHORTCUTS.length));

// 2. Today's bindings (the old Osd.svelte switch) resolve to the same actions, plus X-04's new keys.
const ev = (key, mods = {}) => ({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const TODAY = [
  [ev(' '), 'playPause'], [ev('k'), 'playPause'], [ev('K', { shiftKey: true }), 'playPause'],
  // The old switch ignored modifiers: they still fall back to the plain key when no row takes them.
  [ev(' ', { shiftKey: true }), 'playPause'], [ev(' ', { ctrlKey: true }), 'playPause'], [ev('K', { ctrlKey: true, shiftKey: true }), 'playPause'],
  [ev('ArrowUp', { shiftKey: true }), 'volumeUp'], [ev('ArrowDown', { ctrlKey: true }), 'volumeDown'],
  [ev('f', { ctrlKey: true }), 'fullscreen'], [ev('M', { shiftKey: true }), 'mute'], [ev('N', { shiftKey: true }), 'next'], [ev('S', { shiftKey: true }), 'subtitleSearch'],
  [ev('5', { ctrlKey: true }), 'jump'], [ev('ArrowLeft', { ctrlKey: true, shiftKey: true }), 'seekBackLong'],
  [ev('ArrowLeft'), 'seekBack'], [ev('j'), 'seekBack'], [ev('ArrowLeft', { shiftKey: true }), 'seekBackLong'], [ev('J', { shiftKey: true }), 'seekBackLong'],
  [ev('ArrowRight'), 'seekForward'], [ev('l'), 'seekForward'], [ev('ArrowRight', { shiftKey: true }), 'seekForwardLong'], [ev('L', { shiftKey: true }), 'seekForwardLong'],
  [ev('ArrowUp'), 'volumeUp'], [ev('ArrowDown'), 'volumeDown'],
  [ev('m'), 'mute'], [ev('f'), 'fullscreen'], [ev('Enter'), 'skipSegment'], [ev('Escape'), 'escape'],
  [ev('n'), 'next'], [ev('p'), 'previous'], [ev('a'), 'audioTrack'], [ev('s'), 'subtitleTrack'], [ev('i'), 'info'], [ev('z'), 'aspect'],
  ...[...'0123456789'].map((d) => [ev(d), 'jump']),
  [ev('0', { shiftKey: true }), 'jump'], // AZERTY digits need Shift
  [ev('+', { ctrlKey: true }), 'audioDelayUp'], [ev('=', { ctrlKey: true }), 'audioDelayUp'], [ev('+', { ctrlKey: true, shiftKey: true }), 'audioDelayUp'],
  [ev('-', { ctrlKey: true }), 'audioDelayDown'], [ev('_', { ctrlKey: true, shiftKey: true }), 'audioDelayDown'],
  [ev('+', { shiftKey: true }), 'subtitleDelayUp'], [ev('_', { shiftKey: true }), 'subtitleDelayDown'],
  // X-04 additions.
  // Q opens the X-02 quality sheet, Shift+S the X-03 subtitle search (S alone still cycles subtitles).
  [ev('q'), 'quality'], [ev('t'), 'sleep'],
  [ev('ArrowLeft', { ctrlKey: true }), 'subSeekBack'], [ev('ArrowRight', { ctrlKey: true }), 'subSeekForward'],
  [ev('['), 'speedDown'], [ev(']'), 'speedUp'], [ev('Backspace'), 'speedReset'],
  [ev('MediaFastForward'), 'fastForward'], [ev('MediaRewind'), 'rewind'],
];
const table = sc.applyOverrides({});
for (const [e, want] of TODAY) {
  const mods = ['ctrlKey', 'shiftKey'].filter((m) => e[m]).join('+');
  check(`vod ${mods ? mods + '+' : ''}${e.key} -> ${want}`, () => assert.equal(sc.resolve(e, 'vod', table)?.id ?? null, want && `vod.${want}`));
}

// 3. The Live TV rows are absorbed; the legal overlaps live in different contexts.
check('every Live TV row is in the table', () => {
  for (const r of keys.LIVE_KEYS) assert.ok(sc.SHORTCUTS.includes(r), r.id);
});
check('Backspace: VOD speed reset vs live last channel', () => {
  assert.equal(sc.resolve(ev('Backspace'), 'vod', table)?.id, 'vod.speedReset');
  assert.equal(sc.resolve(ev('Backspace'), 'live', table)?.id, 'live.lastChannel');
});
check('[ ]: VOD speed vs guide lens', () => {
  assert.equal(sc.resolve(ev('['), 'guide', table)?.id, 'guide.prevLens');
  assert.equal(sc.resolve(ev(']'), 'guide', table)?.id, 'guide.nextLens');
});
check('Ctrl+←/→: VOD sub-seek vs guide day', () => assert.equal(sc.resolve(ev('ArrowLeft', { ctrlKey: true }), 'guide', table)?.id, 'guide.prevDay'));
check('speed and subtitle search are disabled in live', () => {
  for (const id of ['speedDown', 'speedUp', 'speedReset']) assert.ok(sc.SHORTCUTS.find((r) => r.id === `vod.${id}`).noLive, id);
});
check('a seeded duplicate inside live fails', () => {
  const seeded = [...sc.SHORTCUTS, { id: 'live.seeded', context: 'live', keys: ['G'], repeatable: false, labelKey: 'x' }];
  assert.ok(sc.conflicts(seeded).some((c) => c.context === 'live' && c.combo === 'G'));
});

// 4. The editor: a conflict is refused (rebinding to a key another action holds), the own key is not one.
check('rebinding Info to M names Mute', () => assert.equal(sc.conflictWith(table, 'vod.info', 'M')?.id, 'vod.mute'));
check('rebinding Mute to its own M is no conflict', () => assert.equal(sc.conflictWith(table, 'vod.mute', 'M'), null));
check('Shift+0 clashes with the jump row (same key on AZERTY)', () => assert.equal(sc.conflictWith(table, 'vod.mute', 'Shift+0')?.id, 'vod.jump'));
check('Shift+M is not M', () => assert.equal(sc.conflictWith(table, 'vod.info', 'Shift+M'), null));
check('import rejects a Shift+digit binding', () => assert.equal(sc.validateImport({ 'vod.mute': ['Shift+3'] }), null));
check('rebinding to a live-only key is no conflict in vod', () => assert.equal(sc.conflictWith(table, 'vod.mute', 'G'), null));
check('comboFromEvent', () => {
  assert.equal(sc.comboFromEvent(ev('m')), 'M');
  assert.equal(sc.comboFromEvent(ev(' ')), 'Space');
  assert.equal(sc.comboFromEvent(ev('+', { ctrlKey: true })), 'Ctrl++');
  assert.equal(sc.comboFromEvent(ev('Shift', { shiftKey: true })), null);
});

// 5. Import validation: the whole file or nothing; an export round-trips.
check('a valid map is kept, combos canonical', () => assert.deepEqual(sc.validateImport({ 'vod.mute': ['u'], 'vod.info': null }), { 'vod.mute': ['U'], 'vod.info': null }));
for (const [name, doc] of [
  ['not an object', [1]],
  ['null', null],
  ['unknown id', { 'vod.nope': ['U'] }],
  ['a Live TV row (read-only)', { 'live.record': ['U'] }],
  ['the fixed jump row', { 'vod.jump': ['U'] }],
  ['a non-array value', { 'vod.mute': 'U' }],
  ['too many keys', { 'vod.mute': ['U', 'V', 'W', 'X', 'Y'] }],
  ['a malformed combo', { 'vod.mute': ['Ctrl+'] }],
  ['a conflict (Mute on F)', { 'vod.mute': ['F'] }],
  ['one good row and one bad', { 'vod.mute': ['U'], 'vod.info': ['F'] }],
]) {
  check(`import rejects ${name}`, () => assert.equal(sc.validateImport(doc), null));
}
check('swapping two keys is valid', () => assert.ok(sc.validateImport({ 'vod.mute': ['F'], 'vod.fullscreen': ['M'] })));
check('export -> import reproduces the bindings', () => {
  const mine = sc.validateImport({ 'vod.mute': ['U'], 'vod.sleep': null, 'vod.fullscreen': ['Ctrl+F'] });
  const back = sc.validateImport(JSON.parse(JSON.stringify(mine)));
  assert.deepEqual(sc.applyOverrides(back), sc.applyOverrides(mine));
  assert.equal(sc.resolve(ev('u'), 'vod', sc.applyOverrides(back))?.id, 'vod.mute');
  assert.equal(sc.resolve(ev('t'), 'vod', sc.applyOverrides(back)), null);
});

// 6. Every VOD label in fr and en.
const cat = (lang) => JSON.parse(fs.readFileSync(path.join(localesDir, lang, 'settings.json'), 'utf8'));
for (const lang of ['fr', 'en']) {
  const doc = cat(lang);
  check(`labels in ${lang}`, () => {
    for (const r of sc.VOD_SHORTCUTS) {
      const v = r.labelKey.split('.').slice(1).reduce((o, k) => o?.[k], doc);
      assert.equal(typeof v, 'string', `${r.labelKey} missing`);
    }
  });
}

// 7. Music context (music-spec MU-04 AC6): no conflict inside it (part of 1), the spec's keys, labels in fr and en.
const MUSIC = [
  [ev(' '), 'playPause'], [ev('ArrowRight', { ctrlKey: true }), 'next'], [ev('ArrowLeft', { ctrlKey: true }), 'previous'],
  [ev('ArrowLeft'), 'seekBack'], [ev('ArrowRight'), 'seekForward'], [ev('ArrowLeft', { shiftKey: true }), 'seekBackLong'], [ev('ArrowRight', { shiftKey: true }), 'seekForwardLong'],
  [ev('ArrowUp'), 'volumeUp'], [ev('ArrowDown'), 'volumeDown'], [ev('m'), 'mute'], [ev('s'), 'shuffle'], [ev('r'), 'repeat'],
  [ev('l'), 'lyrics'], [ev('q'), 'queue'], [ev('f'), 'favorite'], [ev('Escape'), 'close'],
];
for (const [e, want] of MUSIC) check(`music ${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key} -> ${want}`, () => assert.equal(sc.resolve(e, 'music', table)?.id ?? null, `music.${want}`));
check('the music context has no conflict', () => assert.deepEqual(sc.conflicts().filter((c) => c.context === 'music'), []));
check('music rows are editable, a music key does not clash with vod', () => {
  assert.ok(sc.MUSIC_SHORTCUTS.every(sc.editable));
  assert.equal(sc.conflictWith(table, 'music.mute', 'F')?.id, 'music.favorite');
  assert.equal(sc.conflictWith(table, 'vod.mute', 'R'), null);
});
check('a music override imports', () => assert.deepEqual(sc.validateImport({ 'music.lyrics': ['Shift+L'] }), { 'music.lyrics': ['Shift+L'] }));
// Stored settings on start: one stale binding (here a key a newer default took) drops alone.
check('repairOverrides keeps the bindings that still fit', () => {
  const stored = { 'vod.mute': ['U'], 'music.lyrics': ['Ctrl+L'], 'gone.action': ['X'], 'music.queue': ['Shift+Q'] };
  assert.equal(sc.validateImport(stored), null);
  assert.deepEqual(sc.repairOverrides(stored), { 'vod.mute': ['U'], 'music.queue': ['Shift+Q'] });
  assert.deepEqual(sc.repairOverrides(null), {});
});
check('repairOverrides keeps a valid map whole (two actions with swapped keys)', () => {
  const swapped = { 'music.queue': ['L'], 'music.lyrics': ['Q'] };
  assert.deepEqual(sc.validateImport(swapped), swapped);
  assert.deepEqual(sc.repairOverrides(swapped), swapped);
});
for (const lang of ['fr', 'en']) {
  const doc = cat(lang);
  check(`music labels in ${lang}`, () => {
    assert.equal(typeof doc.general.shortcuts.context?.music, 'string', 'context.music');
    for (const r of sc.MUSIC_SHORTCUTS) assert.equal(typeof r.labelKey.split('.').slice(1).reduce((o, k) => o?.[k], doc), 'string', `${r.labelKey} missing`);
  });
}

console.log(`shortcuts-check: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
