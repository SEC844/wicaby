// Live TV accessibility gate (livetv-spec-final.md §12, §21.6 S33/S34, §21.7, §6.7, §8.5).
// Reads the guide's accessibility tree through the Chrome DevTools Protocol (Accessibility.getFullAXTree, no new
// dependency) and checks it against the contract below; with forced colours emulated (Emulation.setEmulatedMedia)
// it also checks the focus outline and the shape of the recording marks.
//
// Contract the desktop guide (Guide.svelte, D-4) must meet; fixtures/a11y/guide.html is a reference page:
//   grid       one role="grid", named (livetv.guide.aria.grid), aria-rowcount = rows in the lens + 1, aria-colcount="-1",
//              no aria-activedescendant (focus moves between real elements)
//   rows       role="row" with a unique aria-rowindex in 1..aria-rowcount; aria-busy="true" while the row's slab loads
//   channel    one role="rowheader" per programme row, named "Chaîne {number}, {name}" (livetv.guide.aria.channel)
//   cells      role="gridcell", focusable, named "{titre}, {chaîne}, de {début} à {fin}" plus badge and mark words
//              (the channel is a comma-separated segment of its own after the title, which may itself start with
//              or contain the channel name), or "{chaîne}, aucune information de programme" for a gap filler
//              (livetv.guide.aria.filler, naming the row's channel)
//   names      no unresolved {placeholder}, no i18n key (t() returns the key when one is missing)
//   focus      the focused node inside the grid is a gridcell or a rowheader, never the grid or a row
//   banner     (--banner) role="status" with aria-live="polite" and some text
//   forced     (S34) under forced-colors: active the focused cell (and channel cell) has a solid outline of at
//   colours    least 2 px in the system Highlight colour; each recording mark, an element with data-mark="<state>"
//              (timer, series, recording, conflict-wont, conflict-ok, error, reminder), keeps a visible shape
//              (border, outline, glyph or SVG stroke: backgrounds and shadows vanish) and the states differ by
//              shape alone (timer and conflict-ok share the dot by design, §6.7)
//
// Usage:
//   node tools/checks/livetv-a11y-check.mjs                  self-test: fixtures/a11y/guide-ax.json passes, and each
//                                                            seeded bad string or attribute fails with its rule
//   node tools/checks/livetv-a11y-check.mjs --tree=<file>    check a saved snapshot (exit 1 on any violation)
//   node tools/checks/livetv-a11y-check.mjs --cdp=<port> [--forced-colors] [--banner] [--osd] [--rows=N]
//        [--require-focus] [--allow-no-marks] [--save=<file>]
//                                                            S33 / S34: check a running Wicaby started with
//                                                            --remote-debugging-port, on the page showing the guide
//                                                            (--osd: the OSD window, for the banner)
//   node tools/checks/livetv-a11y-check.mjs --html=<file> [--save=<file>]   render a page in Electron and check it
//   node tools/checks/livetv-a11y-check.mjs --record         re-render fixtures/a11y/guide.html into guide-ax.json
// S33 / S34 scenario scripts may import analyzeGuide, analyzeForcedColors and captureSnapshot instead of spawning this.
// Snapshot format: { lang, nodes: AXNode[] (CDP, InlineTextBox dropped), attributes: { backendDOMNodeId: { aria-* } },
//                    forcedColors: { active, highlight, focused, focusedHeader, marks: [{ kind, signature, ink }] } | null }
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const FIXTURE_HTML = path.join(here, 'fixtures', 'a11y', 'guide.html');
const FIXTURE_TREE = path.join(here, 'fixtures', 'a11y', 'guide-ax.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Templates from the catalogues when they exist, else the §21.8 values (the check must work before D-4 lands them).
const DEFAULT_TEMPLATES = {
  channel: ['Chaîne {number}, {name}', 'Channel {number}, {name}'],
  filler: ['{channel}, aucune information de programme', '{channel}, no program information'],
};
function loadTemplates() {
  const out = { channel: [...DEFAULT_TEMPLATES.channel], filler: [...DEFAULT_TEMPLATES.filler] };
  for (const lang of ['fr', 'en']) {
    try {
      const aria = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'locales', lang, 'livetv.json'), 'utf8'))?.guide?.aria ?? {};
      for (const k of ['channel', 'filler']) if (typeof aria[k] === 'string' && !out[k].includes(aria[k])) out[k].unshift(aria[k]);
    } catch {
      // keep the defaults
    }
  }
  return out;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Chaîne {number}, {name}" → /^Chaîne\s(?<number>.+?),\s(?<name>.+)$/ (any space matches plain, NBSP or NNBSP).
function templateRe(template) {
  let src = '';
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    src += escapeRe(template.slice(last, m.index)).replace(/\s+/g, '\\s+');
    src += `(?<${m[1]}>.+?)`;
    last = m.index + m[0].length;
  }
  src += escapeRe(template.slice(last)).replace(/\s+/g, '\\s+');
  return new RegExp(`^${src.replace(/\.\+\?\)$/, '.+)')}$`, 'iu');
}

// Clock times in a label: 20:50, 20 h 50, 8:50 PM, 8:50 p.m.
const TIME_RE = /(?<![\d:])\d{1,2}(?::|\s?h\s?)\d{2}(?:\s?[ap]\.?\s?m\.?)?(?![\d:])/giu;
const PLACEHOLDER_RE = /\{\s*\w+\s*(?:,[^}]*)?\}/;
const I18N_KEY_RE = /\b(?:livetv|player|settings|common|main|errors|shell|browse|item)\.[a-z]\w*(?:\.\w+)+\b/;

// ---------------------------------------------------------------- tree helpers

const role = (n) => n?.role?.value ?? '';
// Names compare with any run of spaces (plain, U+00A0, U+202F) as one plain space.
const nameOf = (n) => (n?.name?.value ?? '').replace(/\s+/gu, ' ').trim();
const prop = (n, key) => n?.properties?.find((p) => p.name === key)?.value?.value;
const truthy = (v) => v === true || v === 1 || v === 'true';
// Offsets where `segment` stands alone between commas in a label ("A, B, C": B at 3); names are space-normalised.
function segmentsAt(label, segment) {
  if (!segment) return [];
  const re = new RegExp(`(?:^|,\\s)(${escapeRe(segment)})(?=,|$)`, 'gu');
  const out = [];
  for (const m of label.matchAll(re)) out.push(m.index + m[0].length - m[1].length);
  return out;
}

function indexTree(snapshot) {
  const nodes = snapshot.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const children = (n) => (n.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  const attrs = (n) => snapshot.attributes?.[String(n.backendDOMNodeId)] ?? {};
  // Descendants, not entering nodes for which stop(node) is true (their own subtree is still yielded once).
  const descendants = (n, stop = () => false) => {
    const out = [];
    const walk = (x) => {
      for (const c of children(x)) {
        out.push(c);
        if (!stop(c)) walk(c);
      }
    };
    walk(n);
    return out;
  };
  const text = (n) =>
    descendants(n)
      .filter((c) => role(c) === 'StaticText')
      .map(nameOf)
      .join(' ')
      .trim();
  return { nodes: nodes.filter((n) => !n.ignored), byId, children, attrs, descendants, text };
}

// ---------------------------------------------------------------- S33: the tree

export function analyzeGuide(snapshot, opts = {}) {
  const errors = [];
  const fail = (rule, msg) => errors.push({ rule, msg });
  const t = indexTree(snapshot);
  const templates = opts.templates ?? loadTemplates();
  const channelRes = templates.channel.map(templateRe);
  const fillerRes = templates.filler.map(templateRe);
  const stats = { rows: 0, cells: 0, fillers: 0, busy: 0 };

  const checkName = (n, what) => {
    const name = nameOf(n);
    if (PLACEHOLDER_RE.test(name)) fail('name.placeholder', `${what} "${name}" has an unresolved placeholder`);
    const key = I18N_KEY_RE.exec(name);
    if (key) fail('name.key', `${what} "${name}" shows the i18n key ${key[0]} (missing translation)`);
  };

  if (opts.banner) {
    const banners = t.nodes.filter((n) => role(n) === 'status');
    const live = banners.filter((n) => prop(n, 'live') === 'polite');
    if (!live.length) fail('banner.live', `no role="status" with aria-live="polite" (found ${banners.length} status node(s) with live=${banners.map((n) => prop(n, 'live') ?? 'none').join('/') || '-'})`);
    for (const b of live) {
      const text = nameOf(b) || t.text(b);
      if (!text) fail('banner.text', 'the banner live region is empty');
      else {
        if (PLACEHOLDER_RE.test(text)) fail('name.placeholder', `banner "${text}" has an unresolved placeholder`);
        if (I18N_KEY_RE.test(text)) fail('name.key', `banner "${text}" shows an i18n key`);
      }
    }
  }

  const grids = t.nodes.filter((n) => role(n) === 'grid');
  if (grids.length !== 1) {
    fail('grid.single', `expected one role="grid", found ${grids.length}`);
    if (!grids.length) return { errors, stats };
  }
  const grid = grids[0];
  const ga = t.attrs(grid);
  if (!nameOf(grid)) fail('grid.name', 'the grid has no accessible name');
  checkName(grid, 'grid name');
  const rowcount = Number(ga['aria-rowcount']);
  if (!Number.isInteger(rowcount) || rowcount < 1) fail('grid.rowcount', `aria-rowcount is ${JSON.stringify(ga['aria-rowcount'])}, want an integer (rows in the lens + 1)`);
  else if (opts.rows !== undefined && rowcount !== opts.rows + 1) fail('grid.rowcount', `aria-rowcount is ${rowcount}, want ${opts.rows + 1} (${opts.rows} rows + 1)`);
  if (ga['aria-colcount'] !== '-1') fail('grid.colcount', `aria-colcount is ${JSON.stringify(ga['aria-colcount'])}, want "-1"`);

  const inGrid = t.descendants(grid);
  for (const n of [grid, ...inGrid]) if (prop(n, 'activedescendant')) fail('grid.activedescendant', `${role(n)} "${nameOf(n)}" uses aria-activedescendant; focus must move between real elements`);

  const focused = inGrid.filter((n) => truthy(prop(n, 'focused')));
  if (truthy(prop(grid, 'focused'))) fail('focus.target', 'the grid itself has focus; focus a cell');
  for (const n of focused) if (!['gridcell', 'rowheader'].includes(role(n))) fail('focus.target', `focus is on a ${role(n)} ("${nameOf(n)}"), want a gridcell or rowheader`);
  if (opts.requireFocus && !focused.some((n) => ['gridcell', 'rowheader'].includes(role(n)))) fail('focus.required', 'no gridcell or rowheader has focus');

  const rows = inGrid.filter((n) => role(n) === 'row');
  if (!rows.length) fail('grid.rows', 'the grid has no role="row"');
  const seen = new Map();
  for (const row of rows) {
    const ra = t.attrs(row);
    const idx = Number(ra['aria-rowindex']);
    const inRow = t.descendants(row, (c) => role(c) === 'row');
    const headers = inRow.filter((n) => role(n) === 'rowheader');
    const cells = inRow.filter((n) => role(n) === 'gridcell');
    const isHeaderRow = inRow.some((n) => role(n) === 'columnheader') && !cells.length && !headers.length;
    const label = headers[0] ? `row "${nameOf(headers[0])}"` : `row ${ra['aria-rowindex'] ?? '?'}`;
    if (!Number.isInteger(idx) || idx < 1 || (Number.isInteger(rowcount) && idx > rowcount)) fail('row.index', `${label}: aria-rowindex is ${JSON.stringify(ra['aria-rowindex'])}, want 1..${rowcount}`);
    else if (seen.has(idx)) fail('row.index', `${label}: aria-rowindex ${idx} repeats ${seen.get(idx)}`);
    else seen.set(idx, label);
    if (truthy(prop(row, 'busy')) || ra['aria-busy'] === 'true') stats.busy++;
    if (isHeaderRow) continue;
    stats.rows++;
    if (headers.length !== 1) {
      fail('row.header', `${label}: ${headers.length} rowheader(s), want exactly one channel cell`);
      if (!headers.length) continue;
    }
    const header = headers[0];
    const hname = nameOf(header);
    checkName(header, 'channel cell');
    if (!hname) fail('rowheader.name', `row ${idx}: the channel cell has no accessible name`);
    if (!truthy(prop(header, 'focusable'))) fail('cell.focusable', `${label}: the channel cell is not focusable`);
    // The channel name the programme cells must repeat.
    let channel = hname;
    for (const re of channelRes) {
      const m = re.exec(hname);
      if (m?.groups?.name) {
        channel = m.groups.name.trim();
        break;
      }
    }
    if (channel === hname) channel = hname.replace(/^[\d.\s]+/, '').trim() || hname;
    const channelShort = channel.split(',')[0].trim();
    for (const cell of cells) {
      stats.cells++;
      const name = nameOf(cell);
      const what = `cell "${name}" (${label})`;
      if (!name) {
        fail('cell.name', `${label}: a gridcell has no accessible name`);
        continue;
      }
      checkName(cell, 'cell');
      if (!truthy(prop(cell, 'focusable'))) fail('cell.focusable', `${what} is not focusable`);
      const fillerMatch = fillerRes.map((re) => re.exec(name)).find(Boolean);
      if (fillerMatch) {
        stats.fillers++;
        const named = (fillerMatch.groups?.channel ?? '').trim();
        if (named !== channel && named !== channelShort) fail('cell.channel', `${what} does not name the channel "${channel}"`);
        continue;
      }
      // "{title}, {channel}, de {start} à {end}…": the channel is a comma-separated segment of its own after the
      // title, so a title that starts with or contains the channel name ("ARTE Journal" on ARTE) neither passes
      // for the channel nor hides it.
      const at = segmentsAt(name, channel).concat(channelShort !== channel ? segmentsAt(name, channelShort) : []);
      if (!at.some((i) => i > 0)) {
        if (at.includes(0)) fail('cell.title', `${what} does not start with the programme title`);
        else fail('cell.channel', `${what} does not name the channel "${channel}" as its own segment after the title`);
      }
      const times = name.match(TIME_RE) ?? [];
      if (times.length < 2) fail('cell.times', `${what} lacks the start and end times`);
    }
  }
  return { errors, stats };
}

// ---------------------------------------------------------------- S34: forced colours

// Mark states that may look the same (§6.7: conflict-ok is the plain timer dot; the sheet tells them apart).
const SAME_SHAPE = [['timer', 'conflict-ok']];
const sameAllowed = (a, b) => SAME_SHAPE.some((g) => g.includes(a) && g.includes(b));

export function analyzeForcedColors(probe, opts = {}) {
  const errors = [];
  const fail = (rule, msg) => errors.push({ rule, msg });
  if (!probe) return [{ rule: 'fc.probe', msg: 'no forced-colours probe in the snapshot' }];
  if (!probe.active) fail('fc.active', 'forced-colors: active did not apply (matchMedia is false)');
  const px = (v) => parseFloat(v) || 0;
  for (const [what, f] of [
    ['focused cell', probe.focused],
    ['focused channel cell', probe.focusedHeader],
  ]) {
    if (!f) {
      if (what === 'focused cell') fail('fc.focus', 'no gridcell could be focused');
      continue;
    }
    if (f.outlineStyle !== 'solid' || px(f.outlineWidth) < 2) fail('fc.focus', `${what}: outline is "${f.outlineStyle} ${f.outlineWidth}", want a solid outline of at least 2px`);
    else if (probe.highlight && f.outlineColor !== probe.highlight) fail('fc.focus', `${what}: outline colour ${f.outlineColor} is not Highlight (${probe.highlight})`);
  }
  const marks = probe.marks ?? [];
  if (!marks.length && !opts.allowNoMarks) fail('fc.marks', 'no [data-mark] element in the grid; the mark rule was not exercised (--allow-no-marks to skip)');
  for (const m of marks) if (!m.ink) fail('fc.ink', `mark "${m.kind}" has no visible shape under forced colours (a background or shadow alone disappears)`);
  const byKind = new Map();
  for (const m of marks) {
    if (!byKind.has(m.kind)) byKind.set(m.kind, new Set());
    byKind.get(m.kind).add(m.signature);
  }
  const kinds = [...byKind.keys()];
  for (let i = 0; i < kinds.length; i++)
    for (let j = i + 1; j < kinds.length; j++) {
      const [a, b] = [kinds[i], kinds[j]];
      if (sameAllowed(a, b)) continue;
      if ([...byKind.get(a)].some((s) => byKind.get(b).has(s))) fail('fc.distinct', `marks "${a}" and "${b}" have the same shape under forced colours; they differ only by colour`);
    }
  return errors;
}

// ---------------------------------------------------------------- capture over CDP

async function connect(port, wantOsd) {
  let targets = [];
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((x) => x.type === 'page')) break;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  const pages = targets.filter((x) => x.type === 'page' && !x.url.startsWith('devtools:'));
  const page = (wantOsd ? pages.find((x) => x.url.includes('osd=1')) : pages.find((x) => !x.url.includes('osd=1'))) ?? pages[0];
  if (!page) throw new Error(`no page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`cannot open ${page.webSocketDebuggerUrl}`)));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`${m.error.message} (${m.error.code})`));
    else resolve(m.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { call, close: () => ws.close(), url: page.url };
}

// Runs in the page: forced-colours probe of the focus outline and the marks' shapes.
const PROBE = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const active = matchMedia('(forced-colors: active)').matches;
  const ref = document.createElement('div');
  ref.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;outline:1px solid Highlight';
  document.body.append(ref);
  const highlight = getComputedStyle(ref).outlineColor;
  ref.remove();
  const grid = document.querySelector('[role="grid"]');
  const before = document.activeElement;
  const px = (v) => Math.round((parseFloat(v) || 0) * 2) / 2;
  const edges = (s) => ['Top', 'Right', 'Bottom', 'Left'].map((k) => (s['border' + k + 'Style'] === 'none' || s['border' + k + 'Style'] === 'hidden' || !parseFloat(s['border' + k + 'Width']) ? '-' : s['border' + k + 'Style'] + px(s['border' + k + 'Width']))).join('/');
  const outline = (s) => (s.outlineStyle === 'none' || !parseFloat(s.outlineWidth) ? '-' : s.outlineStyle + px(s.outlineWidth));
  const ownText = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
  const svgShape = (svg) => svg.innerHTML.replace(/\\s(class|style|fill|stroke|color)="[^"]*"/g, '').replace(/\\s+/g, ' ').trim();
  let ink = false;
  const part = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo);
    if (pseudo && (s.content === 'none' || s.content === 'normal')) return '';
    if (s.display === 'none' || s.visibility === 'hidden') return '';
    const r = pseudo ? null : el.getBoundingClientRect();
    const b = edges(s), o = outline(s), txt = pseudo ? s.content.replace(/^["']|["']$/g, '') : ownText(el);
    const svg = el.tagName.toLowerCase() === 'svg' ? svgShape(el) : '';
    const strokes = svg && (s.stroke !== 'none' || s.fill !== 'none');
    if (b !== '-/-/-/-' || o !== '-' || txt || strokes) ink = true;
    if (s.forcedColorAdjust === 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)') ink = true;
    return [pseudo || el.tagName.toLowerCase(), b, s.borderTopLeftRadius, o, txt, svg, r ? Math.round(r.width) + 'x' + Math.round(r.height) : ''].join(' ');
  };
  const signature = (m) => {
    ink = false;
    const parts = [];
    for (const el of [m, ...m.querySelectorAll('*')]) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      parts.push(part(el), part(el, '::before'), part(el, '::after'));
    }
    const cell = m.closest('[role="gridcell"]');
    if (cell) { const s = getComputedStyle(cell); parts.push('cell ' + edges(s) + ' ' + outline(s)); }
    return { signature: parts.filter(Boolean).join(' | '), ink };
  };
  if (before && before !== document.body) before.blur();
  await frame();
  const marks = grid ? [...grid.querySelectorAll('[data-mark]')].map((m) => ({ kind: m.dataset.mark, ...signature(m) })) : [];
  const focusRead = async (el) => {
    if (!el) return null;
    el.focus({ preventScroll: true });
    await frame();
    const s = getComputedStyle(el);
    return { label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80), focused: document.activeElement === el, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset };
  };
  const cell = before && before.getAttribute && before.getAttribute('role') === 'gridcell' ? before : grid && grid.querySelector('[role="gridcell"]');
  const focusedHeader = await focusRead(grid && grid.querySelector('[role="rowheader"]'));
  const focused = await focusRead(cell);
  if (before && before.focus) before.focus({ preventScroll: true });
  return { active, highlight, focused, focusedHeader, marks };
})()`;

export async function captureSnapshot(port, opts = {}) {
  const cdp = await connect(port, opts.osd);
  try {
    if (opts.settleMs) await sleep(opts.settleMs);
    await cdp.call('Accessibility.enable');
    const { nodes } = await cdp.call('Accessibility.getFullAXTree');
    const kept = nodes
      .filter((n) => role(n) !== 'InlineTextBox')
      .map(({ nodeId, parentId, childIds, ignored, role: r, name, properties, backendDOMNodeId }) => ({
        nodeId,
        parentId,
        childIds,
        ignored,
        role: r ? { value: r.value } : undefined,
        name: name ? { value: name.value } : undefined,
        // The url property would put local paths in saved snapshots.
        properties: properties?.length ? properties.filter((p) => p.name !== 'url').map((p) => ({ name: p.name, value: { value: p.value?.value } })) : undefined,
        backendDOMNodeId,
      }));
    // ARIA attributes the AX properties do not carry (rowcount, colcount, rowindex).
    await cdp.call('DOM.getDocument', { depth: 0 });
    const attributes = {};
    for (const n of kept) {
      if (!['grid', 'row', 'treegrid'].includes(role(n)) || !n.backendDOMNodeId) continue;
      const { node } = await cdp.call('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
      const a = {};
      for (let i = 0; i + 1 < (node.attributes ?? []).length; i += 2) if (/^aria-|^data-/.test(node.attributes[i])) a[node.attributes[i]] = node.attributes[i + 1];
      attributes[n.backendDOMNodeId] = a;
    }
    const lang = (await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.lang', returnByValue: true })).result.value;
    let forcedColors = null;
    if (opts.forcedColors) {
      await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
      // :focus only matches in a focused page; a hidden or background window is not one.
      await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      try {
        const r = await cdp.call('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'probe failed');
        forcedColors = r.result.value;
      } finally {
        await cdp.call('Emulation.setEmulatedMedia', { features: [] });
        await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false });
      }
    }
    return { source: cdp.url.startsWith('file:') ? path.basename(fileURLToPath(cdp.url)) : cdp.url, lang, nodes: kept, attributes, forcedColors };
  } finally {
    cdp.close();
  }
}

const handedOut = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      // Never the same port twice: a closed port can be handed out again before its mock binds it.
      srv.close(() => (handedOut.has(port) ? freePort().then(resolve, reject) : (handedOut.add(port), resolve(port))));
    });
  });
}

// Renders a local page in a hidden Electron window (no audio, throwaway profile) and captures it.
async function captureHtml(file) {
  const electron = createRequire(path.join(ROOT, 'apps', 'desktop', 'package.json'))('electron');
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-a11y-'));
  const main = path.join(tmp, 'main.cjs');
  fs.writeFileSync(
    main,
    `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'profile'))});
app.commandLine.appendSwitch('mute-audio');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  w.loadURL(${JSON.stringify(pathToFileURL(path.resolve(file)).href)});
});
app.on('window-all-closed', () => app.quit());
`,
  );
  const child = spawn(electron, [`--remote-debugging-port=${port}`, main], { stdio: 'ignore', windowsHide: true });
  try {
    return await captureSnapshot(port, { forcedColors: true, settleMs: 600 });
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------- self-test: seeded failures

const clone = (x) => structuredClone(x);
function mutate(snapshot, fn) {
  const s = clone(snapshot);
  fn(s, indexTree(s));
  return s;
}
const setName = (n, v) => (n.name = { value: v });
const byRole = (t, r) => t.nodes.filter((n) => role(n) === r);

const SEEDS = [
  ['cell label with an unresolved placeholder', 'name.placeholder', (s, t) => setName(byRole(t, 'gridcell')[0], 'Le Journal, {channel}, de 20:00 à 20:40')],
  ['cell label is a missing i18n key', 'name.key', (s, t) => setName(byRole(t, 'gridcell')[1], 'livetv.guide.aria.cell')],
  ['cell label without the times', 'cell.times', (s, t) => setName(byRole(t, 'gridcell')[0], 'Le Journal, Ciné Club')],
  ['cell label without the channel', 'cell.channel', (s, t) => setName(byRole(t, 'gridcell')[0], 'Le Journal, de 20:00 à 20:40')],
  ['cell label starts with the channel', 'cell.title', (s, t) => setName(byRole(t, 'gridcell')[0], 'Ciné Club, de 20:00 à 20:40')],
  ['only the title contains the channel name', 'cell.channel', (s, t) => setName(byRole(t, 'gridcell')[0], 'Ciné Club Classique, de 20:00 à 20:40, Direct')],
  ['the channel name only inside the title', 'cell.channel', (s, t) => setName(byRole(t, 'gridcell')[0], 'Le Ciné Club du dimanche, de 20:00 à 20:40')],
  ['filler names another channel', 'cell.channel', (s, t) => setName(byRole(t, 'gridcell').find((c) => /aucune information/.test(nameOf(c))), 'Euro 3, aucune information de programme')],
  ['empty cell label', 'cell.name', (s, t) => setName(byRole(t, 'gridcell')[0], '')],
  ['empty channel label', 'rowheader.name', (s, t) => setName(byRole(t, 'rowheader')[0], '')],
  ['banner announced assertively', 'banner.live', (s, t) => byRole(t, 'status').forEach((n) => (n.properties.find((p) => p.name === 'live').value.value = 'assertive')), { banner: true }],
  ['empty banner', 'banner.text', (s, t) => byRole(t, 'status').forEach((n) => t.descendants(n).forEach((c) => setName(c, ''))), { banner: true }],
  ['no aria-rowcount', 'grid.rowcount', (s, t) => delete s.attributes[byRole(t, 'grid')[0].backendDOMNodeId]['aria-rowcount']],
  ['aria-rowcount off by the header row', 'grid.rowcount', () => {}, { rows: 4 + 1 }],
  ['aria-colcount missing', 'grid.colcount', (s, t) => delete s.attributes[byRole(t, 'grid')[0].backendDOMNodeId]['aria-colcount']],
  ['two rows share an aria-rowindex', 'row.index', (s, t) => (s.attributes[byRole(t, 'row')[2].backendDOMNodeId]['aria-rowindex'] = '2')],
  ['grid uses aria-activedescendant', 'grid.activedescendant', (s, t) => (byRole(t, 'grid')[0].properties = [...(byRole(t, 'grid')[0].properties ?? []), { name: 'activedescendant', value: { value: 'x' } }])],
  ['focus left on a row', 'focus.target', (s, t) => (byRole(t, 'row')[1].properties = [{ name: 'focused', value: { value: true } }])],
  ['row without a channel cell', 'row.header', (s, t) => (byRole(t, 'rowheader')[0].role.value = 'gridcell')],
  ['no grid role', 'grid.single', (s, t) => (byRole(t, 'grid')[0].role.value = 'table')],
  ['forced colours: focus outline not Highlight', 'fc.focus', (s) => (s.forcedColors.focused.outlineColor = 'rgb(1, 2, 3)'), { fc: true }],
  ['forced colours: no focus outline', 'fc.focus', (s) => (s.forcedColors.focused.outlineStyle = 'none'), { fc: true }],
  ['forced colours: a mark drawn by background only', 'fc.ink', (s) => (s.forcedColors.marks[0].ink = false), { fc: true }],
  ['forced colours: series looks like recording', 'fc.distinct', (s) => (s.forcedColors.marks.find((m) => m.kind === 'series').signature = s.forcedColors.marks.find((m) => m.kind === 'recording').signature), { fc: true }],
];

// Variants of the reference that must still pass (English labels, 12-hour clock with U+202F, NBSP in templates,
// programme titles that start with, equal or contain a comma like the channel name).
const GOOD_VARIANTS = [
  ['a programme title that starts with the channel name ("ARTE Journal" on ARTE)', (s, t) => setName(byRole(t, 'gridcell')[0], 'Ciné Club Classique, Ciné Club, de 20:00 à 20:40, Direct')],
  ['a programme title equal to the channel name', (s, t) => setName(byRole(t, 'gridcell')[0], 'Ciné Club, Ciné Club, de 20:00 à 20:40')],
  ['a programme title with a comma', (s, t) => setName(byRole(t, 'gridcell')[0], 'Paris, je t’aime, Ciné Club, de 20:00 à 20:40')],
  [
    'English labels with a 12-hour clock',
    (s, t) => {
      s.lang = 'en';
      byRole(t, 'rowheader').forEach((h) => setName(h, nameOf(h).replace('Chaîne', 'Channel')));
      setName(byRole(t, 'gridcell')[0], 'Le Journal, Ciné Club, 8:00 PM to 8:40 PM, Live, scheduled');
      setName(byRole(t, 'gridcell').find((c) => /aucune information/.test(nameOf(c))), 'Équipe 21, no program information');
    },
  ],
  [
    'non-breaking spaces and "20 h 00" times in the labels',
    (s, t) => {
      setName(byRole(t, 'rowheader')[0], 'Chaîne 1, Ciné Club');
      setName(byRole(t, 'gridcell')[0], 'Le Journal, Ciné Club, de 20 h 00 à 20 h 40');
    },
  ],
];

function runAll(snapshot, opts) {
  const tree = analyzeGuide(snapshot, opts);
  const fc = opts.fc ? analyzeForcedColors(snapshot.forcedColors, opts) : [];
  return { errors: [...tree.errors, ...fc], stats: tree.stats };
}

function selfTest() {
  if (!fs.existsSync(FIXTURE_TREE)) {
    console.log(`missing ${path.relative(ROOT, FIXTURE_TREE)}; run with --record`);
    return 1;
  }
  const good = JSON.parse(fs.readFileSync(FIXTURE_TREE, 'utf8'));
  const base = { banner: true, fc: true, requireFocus: true, rows: 4 };
  const fails = [];
  console.log('livetv-a11y-check self-test (the reference guide passes; each seeded bad string or attribute fails with its rule):');
  const g = runAll(good, base);
  const ok = g.errors.length === 0 && g.stats.cells >= 6 && g.stats.fillers >= 1 && good.forcedColors?.marks?.length >= 6;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} reference guide: ${g.stats.rows} rows, ${g.stats.cells} cells (${g.stats.fillers} filler), ${g.stats.busy} busy, ${good.forcedColors?.marks?.length ?? 0} marks`);
  for (const e of g.errors) console.log(`         ${e.rule}: ${e.msg}`);
  if (!ok) fails.push('reference');
  for (const [title, fn] of GOOD_VARIANTS) {
    const r = runAll(mutate(good, fn), base);
    console.log(`  ${r.errors.length ? 'FAIL' : 'ok  '} ${title} pass${r.errors.length ? ` (got ${r.errors.map((e) => `${e.rule}: ${e.msg}`).join('; ')})` : ''}`);
    if (r.errors.length) fails.push(title);
  }
  for (const [title, rule, fn, extra = {}] of SEEDS) {
    const r = runAll(mutate(good, fn), { ...base, ...extra });
    const hit = r.errors.some((e) => e.rule === rule);
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${title} → ${rule}${hit ? '' : ` (got ${r.errors.map((e) => e.rule).join(', ') || 'no error'})`}`);
    if (!hit) fails.push(title);
  }
  console.log(fails.length ? `\n${fails.length} self-test expectation(s) failed.` : `\nlivetv-a11y-check self-test passed (${SEEDS.length} seeds).`);
  return fails.length ? 1 : 0;
}

// ---------------------------------------------------------------- CLI

function report(snapshot, opts) {
  const { errors, stats } = runAll(snapshot, opts);
  console.log(`${snapshot.source ?? 'snapshot'} (${snapshot.lang || '?'}): ${stats.rows} rows, ${stats.cells} cells (${stats.fillers} filler), ${stats.busy} busy${snapshot.forcedColors ? `, ${snapshot.forcedColors.marks?.length ?? 0} marks under forced colours` : ''}`);
  if (!errors.length) {
    console.log('Accessibility OK.');
    return 0;
  }
  console.log(`\n${errors.length} accessibility error(s):`);
  for (const e of errors) console.log(`  ${e.rule}: ${e.msg}`);
  return 1;
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const flag = (name) => argv.includes(`--${name}`);
  const opts = {
    banner: flag('banner'),
    requireFocus: flag('require-focus'),
    allowNoMarks: flag('allow-no-marks'),
    rows: opt('rows') !== undefined ? Number(opt('rows')) : undefined,
  };
  let code;
  try {
    if (flag('record')) {
      const snap = await captureHtml(FIXTURE_HTML);
      fs.writeFileSync(FIXTURE_TREE, `${JSON.stringify(snap, null, 1)}\n`);
      console.log(`Wrote ${path.relative(ROOT, FIXTURE_TREE)} (${snap.nodes.length} nodes).`);
      code = report(snap, { banner: true, fc: true, requireFocus: true, rows: 4 });
    } else if (opt('html') || opt('cdp') || opt('tree')) {
      let snap;
      if (opt('tree')) snap = JSON.parse(fs.readFileSync(opt('tree'), 'utf8'));
      else if (opt('html')) snap = await captureHtml(opt('html'));
      else snap = await captureSnapshot(Number(opt('cdp')), { forcedColors: flag('forced-colors'), osd: flag('osd') });
      if (opt('save')) fs.writeFileSync(opt('save'), `${JSON.stringify(snap, null, 1)}\n`);
      code = report(snap, { ...opts, fc: Boolean(snap.forcedColors) && (flag('forced-colors') || Boolean(opt('html')) || Boolean(opt('tree'))) });
    } else code = selfTest();
  } catch (err) {
    console.log(`livetv-a11y-check: ${err.message}`);
    code = 1;
  }
  process.exit(code);
}
