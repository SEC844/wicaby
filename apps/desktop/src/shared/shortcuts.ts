// X-04 shortcut table (feature-specs.md §4): the player's VOD actions plus the Live TV rows of
// livetv/keys.ts, in one context-aware table. Conflicts are checked per context, so the legal
// overlaps (Backspace, [ ], Ctrl+←/→) live in different contexts. Pure and erasable TypeScript
// (tools/checks/shortcuts-check.mjs runs it under plain Node). Combo grammar: see livetv/keys.ts.
import { comboText, keyConflicts, LIVE_KEYS, matches, parseCombo, resolveKey, type Combo, type KeyContext, type KeyLike, type KeyRow } from './livetv/keys';

export interface Shortcut extends KeyRow {
  fixed?: boolean; // not offered in the editor (the 0–9 jump row)
  noLive?: boolean; // disabled while a channel plays
}

// User overrides from Settings: action id -> combos, or null when the action is disabled.
export type ShortcutOverrides = Record<string, string[] | null>;

const vod = (id: string, keys: readonly string[], repeatable = false, extra: Partial<Shortcut> = {}): Shortcut => ({
  id: `vod.${id}`,
  context: 'vod',
  keys,
  repeatable,
  labelKey: `settings.general.shortcuts.action.${id}`,
  ...extra,
});

// The defaults equal the bindings of the fixed switch they replace, plus X-04's new rows
// (T, Ctrl+←/→, [ ], Backspace, FF/REW), Q (X-02 quality sheet) and Shift+S (X-03 subtitle search).
export const VOD_SHORTCUTS: readonly Shortcut[] = [
  vod('playPause', ['Space', 'K']),
  vod('seekBack', ['ArrowLeft', 'J'], true),
  vod('seekForward', ['ArrowRight', 'L'], true),
  vod('seekBackLong', ['Shift+ArrowLeft', 'Shift+J'], true),
  vod('seekForwardLong', ['Shift+ArrowRight', 'Shift+L'], true),
  vod('volumeUp', ['ArrowUp'], true),
  vod('volumeDown', ['ArrowDown'], true),
  vod('mute', ['M']),
  vod('fullscreen', ['F']),
  vod('next', ['N']),
  vod('previous', ['P']),
  vod('audioTrack', ['A']),
  vod('subtitleTrack', ['S']),
  // Symbols ignore Shift unless named: Ctrl++ also takes Ctrl+Shift++, as the old switch did.
  vod('audioDelayUp', ['Ctrl++', 'Ctrl+='], true),
  vod('audioDelayDown', ['Ctrl+-', 'Ctrl+_'], true),
  vod('subtitleDelayUp', ['Shift++', 'Shift+='], true),
  vod('subtitleDelayDown', ['Shift+-', 'Shift+_'], true),
  vod('jump', [...'0123456789'], false, { fixed: true }),
  vod('info', ['I']),
  vod('aspect', ['Z']),
  vod('skipSegment', ['Enter']),
  vod('escape', ['Escape']),
  vod('fastForward', ['MediaFastForward'], true),
  vod('rewind', ['MediaRewind'], true),
  vod('sleep', ['T']),
  vod('quality', ['Q']),
  vod('subtitleSearch', ['Shift+S']),
  vod('subSeekBack', ['Ctrl+ArrowLeft'], true),
  vod('subSeekForward', ['Ctrl+ArrowRight'], true),
  vod('speedDown', ['['], true, { noLive: true }),
  vod('speedUp', [']'], true, { noLive: true }),
  vod('speedReset', ['Backspace'], false, { noLive: true }),
];

const music = (id: string, keys: readonly string[], repeatable = false): Shortcut => ({
  id: `music.${id}`,
  context: 'music',
  keys,
  repeatable,
  labelKey: `settings.general.shortcuts.action.music${id[0].toUpperCase()}${id.slice(1)}`,
});

// Music in the main window (music-spec §4.3), while a track plays and no text field has focus. Unmodified
// arrows only act when nothing has focus: otherwise they move the focus (full-screen player included).
export const MUSIC_SHORTCUTS: readonly Shortcut[] = [
  music('playPause', ['Space']),
  music('next', ['Ctrl+ArrowRight']),
  music('previous', ['Ctrl+ArrowLeft']),
  music('seekBack', ['ArrowLeft'], true),
  music('seekForward', ['ArrowRight'], true),
  music('seekBackLong', ['Shift+ArrowLeft'], true),
  music('seekForwardLong', ['Shift+ArrowRight'], true),
  music('volumeUp', ['ArrowUp'], true),
  music('volumeDown', ['ArrowDown'], true),
  music('mute', ['M']),
  music('shuffle', ['S']),
  music('repeat', ['R']),
  music('lyrics', ['L']),
  music('queue', ['Q']),
  music('favorite', ['F']),
  music('close', ['Escape']),
];

export const SHORTCUTS: readonly Shortcut[] = [...VOD_SHORTCUTS, ...LIVE_KEYS, ...MUSIC_SHORTCUTS];

// Rows the editor offers (the Live TV rows stay read-only: LiveOverlay and the guide read keys.ts).
export const editable = (r: Shortcut): boolean => (r.context === 'vod' || r.context === 'music') && !r.fixed;

export function applyOverrides(overrides: ShortcutOverrides | undefined | null, rows: readonly Shortcut[] = SHORTCUTS): Shortcut[] {
  if (!overrides) return [...rows];
  return rows.map((r) => (editable(r) && Object.hasOwn(overrides, r.id) ? { ...r, keys: overrides[r.id] ?? [] } : r));
}

// VOD keeps the old switch's leniency: when no row matches exactly, extra Ctrl/Alt/Shift are dropped
// (Shift first kept, for the long seek), so Shift+Space, Ctrl+F or Ctrl+Shift+K act as before.
const LENIENT: readonly Partial<KeyLike>[] = [{ ctrlKey: false, altKey: false }, { shiftKey: false, altKey: false }, { ctrlKey: false, shiftKey: false, altKey: false }];

export function resolve(ev: KeyLike, context: KeyContext, rows: readonly Shortcut[]): Shortcut | null {
  const hit = resolveKey(ev, context, rows) as Shortcut | null;
  if (hit || context !== 'vod' || !(ev.ctrlKey || ev.altKey || ev.shiftKey)) return hit;
  for (const strip of LENIENT) {
    // Fields by name: a DOM KeyboardEvent keeps them on its prototype, which a spread drops.
    const r = resolveKey({ key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, altKey: ev.altKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey, ...strip }, context, rows) as Shortcut | null;
    if (r) return r;
  }
  return null;
}

export const conflicts = (rows: readonly Shortcut[] = SHORTCUTS) => keyConflicts(rows);

// The key press a combo stands for, so that two combos clash by the same rule the player matches with
// (Shift+0 and the jump row's 0 are one key: Shift is ignored on symbols and digits).
const pressOf = (c: Combo): KeyLike =>
  c.key.startsWith('code:')
    ? { key: '', code: c.key.slice(5), ctrlKey: c.ctrl, altKey: c.alt, shiftKey: c.shift }
    : { key: c.key === 'Space' ? ' ' : c.key, code: '', ctrlKey: c.ctrl, altKey: c.alt, shiftKey: c.shift };
const clash = (a: string, b: string): boolean => {
  const ca = parseCombo(a);
  const cb = parseCombo(b);
  return matches(pressOf(ca), cb) || matches(pressOf(cb), ca);
};

// The row of the same context that already takes `combo`, other than `id` (the editor's refusal).
export function conflictWith(rows: readonly Shortcut[], id: string, combo: string): Shortcut | null {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  return rows.find((r) => r.id !== id && r.context === row.context && r.keys.some((k) => clash(k, combo))) ?? null;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Unidentified', 'Process']);

// "Record key": the combo a key press stands for, or null for a lone modifier.
export function comboFromEvent(ev: KeyLike): string | null {
  if (MODIFIER_KEYS.has(ev.key) || ev.metaKey) return null;
  const key = ev.key === ' ' ? 'Space' : /^[a-z]$/i.test(ev.key) ? ev.key.toUpperCase() : ev.key;
  return `${ev.ctrlKey ? 'Ctrl+' : ''}${ev.altKey ? 'Alt+' : ''}${ev.shiftKey ? 'Shift+' : ''}${key}`;
}

const COMBO = /^((Ctrl|Alt|Shift)\+)*(\+|[^+]{1,32})$/;
const MAX_KEYS = 4;

// Settings file and JSON import: the whole map or nothing. Unknown or read-only ids, malformed
// combos and any conflict inside a context make it invalid.
export function validateImport(doc: unknown, rows: readonly Shortcut[] = SHORTCUTS): ShortcutOverrides | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const out: ShortcutOverrides = {};
  for (const [id, v] of Object.entries(doc)) {
    const row = rows.find((r) => r.id === id);
    if (!row || !editable(row)) return null;
    if (v === null) {
      out[id] = null;
      continue;
    }
    if (!Array.isArray(v) || v.length > MAX_KEYS || !v.every((k) => typeof k === 'string' && COMBO.test(k))) return null;
    out[id] = [...new Set(v.map((k: string) => comboText(parseCombo(k))))];
  }
  const applied = applyOverrides(out, rows);
  if (conflicts(applied).length) return null;
  return Object.entries(out).some(([id, ks]) => ks?.some((k) => conflictWith(applied, id, k))) ? null : out;
}
