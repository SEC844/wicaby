// Live TV key table (spec §10.1, §21.10 D-5, feature-specs X-04): one table feeds the OSD, the
// guide, the mini-guide and the Settings shortcut list. Rows are context-aware so that X-04's
// shortcuts.ts can absorb them; a key may repeat across contexts but never inside one
// (tools/checks/livetv-check.mjs fails on a duplicate). Pure and erasable TypeScript only.
//
// Combo grammar: [Ctrl+][Alt+][Shift+]<key>. <key> is a KeyboardEvent.key value (letters in upper
// case, 'Space' for ' '), or `code:<KeyboardEvent.code>` for physical keys (digits by e.code, so
// number entry works on AZERTY). Shift is ignored for single-symbol keys ('/', '[', '.') and for
// code: keys unless the combo names it, because the layout decides whether they need Shift.

// 'music': the music shortcuts of the main window (shortcuts.ts, music-spec §4.3).
export type KeyContext = 'vod' | 'live' | 'guide' | 'miniguide' | 'music';

export interface KeyRow {
  id: string;
  context: KeyContext;
  keys: readonly string[];
  repeatable: boolean;
  labelKey: string; // i18n key (fr + en)
}

const DIGIT_CODES: readonly string[] = [...'0123456789'].flatMap((d) => [`code:Digit${d}`, `code:Numpad${d}`]);

const row = (context: KeyContext, id: string, keys: readonly string[], label: string, repeatable = false): KeyRow => ({ id: `${context}.${id}`, context, keys, repeatable, labelKey: `livetv.keys.${label}` });

export const LIVE_KEYS: readonly KeyRow[] = [
  // Player in live mode (Osd.svelte asks LiveOverlay first). ⚑ = remaps a VOD key.
  row('live', 'zapUp', ['PageUp', 'Ctrl+ArrowUp', 'N', 'MediaTrackNext'], 'zapUp', true), // ⚑ N
  row('live', 'zapDown', ['PageDown', 'Ctrl+ArrowDown', 'P', 'MediaTrackPrevious'], 'zapDown', true), // ⚑ P
  row('live', 'digits', DIGIT_CODES, 'digits'), // ⚑ 0-9
  row('live', 'separator', ['.', '-', 'code:NumpadDecimal'], 'separator'),
  row('live', 'enter', ['Enter'], 'enter'),
  row('live', 'channelList', ['G'], 'channelList'),
  row('live', 'guideOverlay', ['Shift+G'], 'guideOverlay'),
  row('live', 'pip', ['Shift+P'], 'pip'),
  row('live', 'lastChannel', ['Backspace'], 'lastChannel'),
  row('live', 'info', ['I'], 'info'), // ⚑ I
  row('live', 'stats', ['Shift+I'], 'stats'),
  row('live', 'record', ['R'], 'record'),
  row('live', 'recordOptions', ['Shift+R'], 'recordOptions'),
  row('live', 'favorite', ['Ctrl+D'], 'favorite'),
  row('live', 'search', ['/'], 'search'),
  row('live', 'pause', ['Space', 'K'], 'pause'),
  row('live', 'back', ['ArrowLeft', 'J'], 'seekBack', true),
  row('live', 'forward', ['ArrowRight', 'L'], 'seekForward', true),
  row('live', 'backLong', ['Shift+ArrowLeft', 'Shift+J'], 'seekBackLong', true),
  row('live', 'forwardLong', ['Shift+ArrowRight', 'Shift+L'], 'seekForwardLong', true),
  row('live', 'liveEdge', ['End'], 'backToLive'),
  row('live', 'bufferStart', ['Home'], 'bufferStart'),
  row('live', 'close', ['Escape'], 'close'),

  // Guide (Guide.svelte onKey).
  row('guide', 'left', ['ArrowLeft'], 'moveLeft', true),
  row('guide', 'right', ['ArrowRight'], 'moveRight', true),
  row('guide', 'up', ['ArrowUp'], 'moveUp', true),
  row('guide', 'down', ['ArrowDown'], 'moveDown', true),
  row('guide', 'pageUp', ['PageUp'], 'pageUp', true),
  row('guide', 'pageDown', ['PageDown'], 'pageDown', true),
  row('guide', 'earlier', ['Shift+ArrowLeft'], 'earlier', true),
  row('guide', 'later', ['Shift+ArrowRight'], 'later', true),
  row('guide', 'prevDay', ['Ctrl+ArrowLeft'], 'prevDay'),
  row('guide', 'nextDay', ['Ctrl+ArrowRight'], 'nextDay'),
  row('guide', 'now', ['Home'], 'now'),
  row('guide', 'firstChannel', ['Ctrl+Home'], 'firstChannel'),
  row('guide', 'lastChannel', ['Ctrl+End'], 'lastRow'),
  row('guide', 'digits', DIGIT_CODES, 'jump'),
  row('guide', 'separator', ['.', 'code:NumpadDecimal'], 'separator'),
  row('guide', 'open', ['Enter'], 'open'),
  row('guide', 'watch', ['Ctrl+Enter'], 'watch'),
  row('guide', 'search', ['/', 'Ctrl+F'], 'search'),
  row('guide', 'favorite', ['F'], 'favorite'),
  row('guide', 'record', ['R'], 'record'),
  row('guide', 'recordOptions', ['Shift+R'], 'recordOptions'),
  row('guide', 'reminder', ['B'], 'reminder'),
  row('guide', 'prevLens', ['['], 'prevLens'),
  row('guide', 'nextLens', [']'], 'nextLens'),
  row('guide', 'menu', ['ContextMenu', 'Shift+F10'], 'menu'),
  row('guide', 'close', ['Escape'], 'close'),

  // Mini-guide over the video (LiveOverlay).
  row('miniguide', 'up', ['ArrowUp'], 'moveUp', true),
  row('miniguide', 'down', ['ArrowDown'], 'moveDown', true),
  row('miniguide', 'pageUp', ['PageUp', 'Ctrl+ArrowUp'], 'pageUp', true),
  row('miniguide', 'pageDown', ['PageDown', 'Ctrl+ArrowDown'], 'pageDown', true),
  row('miniguide', 'prevLens', ['ArrowLeft'], 'prevLens'),
  row('miniguide', 'nextLens', ['ArrowRight'], 'nextLens'),
  row('miniguide', 'tune', ['Enter'], 'tune'),
  row('miniguide', 'digits', DIGIT_CODES, 'jump'),
  row('miniguide', 'favorite', ['F'], 'favorite'),
  row('miniguide', 'record', ['R'], 'record'),
  row('miniguide', 'filter', ['/'], 'filter'),
  row('miniguide', 'close', ['Escape'], 'close'),
];

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // normalised key, or 'code:…'
}

const isLetter = (k: string): boolean => /^[a-z]$/i.test(k);
const isSymbol = (k: string): boolean => k.length === 1 && !isLetter(k) && k !== ' ';

export function parseCombo(combo: string): Combo {
  const parts = combo.split('+');
  // A trailing '+' key ('Ctrl++') leaves an empty last part.
  let key = parts.pop() as string;
  if (key === '' && parts.length && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'), key: normKey(key) };
}

function normKey(key: string): string {
  if (key.startsWith('code:')) return key;
  if (key === ' ' || key === 'Space' || key === 'Spacebar') return 'Space';
  return isLetter(key) ? key.toUpperCase() : key;
}

// The canonical text of a combo (used by the duplicate check).
export function comboText(c: Combo): string {
  return `${c.ctrl ? 'Ctrl+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${c.key}`;
}

export function matches(ev: KeyLike, combo: string | Combo): boolean {
  const c = typeof combo === 'string' ? parseCombo(combo) : combo;
  if (!!ev.ctrlKey !== c.ctrl || !!ev.altKey !== c.alt || !!ev.metaKey) return false;
  if (c.key.startsWith('code:')) {
    if (ev.code !== c.key.slice(5)) return false;
    return c.shift ? !!ev.shiftKey : true;
  }
  if (normKey(ev.key) !== c.key) return false;
  if (isSymbol(c.key) && !c.shift) return true;
  return !!ev.shiftKey === c.shift;
}

// The first row of `context` whose combos match (table order: digits by code win over a symbol
// the same physical key types on another layout).
export function resolveKey(ev: KeyLike, context: KeyContext, rows: readonly KeyRow[] = LIVE_KEYS): KeyRow | null {
  for (const r of rows) if (r.context === context && r.keys.some((k) => matches(ev, k))) return r;
  return null;
}

// Duplicate bindings inside one context (the same canonical combo on two rows, or twice on one).
export function keyConflicts(rows: readonly KeyRow[] = LIVE_KEYS): { context: KeyContext; combo: string; ids: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const r of rows) {
    for (const k of r.keys) {
      const id = `${r.context} ${comboText(parseCombo(k))}`;
      const list = seen.get(id) ?? [];
      list.push(r.id);
      seen.set(id, list);
    }
  }
  const out: { context: KeyContext; combo: string; ids: string[] }[] = [];
  for (const [id, ids] of seen) {
    if (ids.length < 2) continue;
    const sp = id.indexOf(' ');
    out.push({ context: id.slice(0, sp) as KeyContext, combo: id.slice(sp + 1), ids });
  }
  return out;
}

// Rows of one context, for the Settings "TV en direct" shortcut list.
export function rowsFor(context: KeyContext, rows: readonly KeyRow[] = LIVE_KEYS): KeyRow[] {
  return rows.filter((r) => r.context === context);
}
