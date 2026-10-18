// Desktop motion rules from docs/design.md: hover, selection and focus colours switch instantly, only
// transform/opacity/filter animate, and every duration is a --t-* token (CSS) or dur() (script).
// Run: node tools/checks/motion-check.mjs   (--self-test runs the rule tests only)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../apps/desktop/src/renderer');

// Transitioned properties that repaint or relayout on the main thread.
const BANNED = /^(all|color|background(-color)?|border(-[a-z]+)*|box-shadow|outline(-color)?|fill|stroke|text-decoration(-color)?|caret-color|(max-|min-)?(width|height)|inset|top|right|bottom|left|margin(-[a-z]+)*|padding(-[a-z]+)*|gap|flex(-basis)?|grid-template-[a-z]+|font-size|letter-spacing)$/;
const TIME = /(?<![\w.-])\d*\.?\d+m?s\b/g;

// Split on commas outside parentheses (cubic-bezier, linear() and calc carry commas or spaces).
function parts(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

// Problems in one CSS block. `motion-ok: <why>` in a comment right before a declaration exempts it.
export function cssProblems(css) {
  const problems = [];
  const re = /(\/\*([\s\S]*?)\*\/\s*)?(?<![\w-])(transition|transition-property|transition-duration|transition-delay|animation|animation-duration|animation-delay)\s*:\s*([^;{}]+)/g;
  for (const m of css.matchAll(re)) {
    const [, , comment = '', prop, raw] = m;
    const value = raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const line = css.slice(0, m.index + (m[1]?.length ?? 0)).split('\n').length;
    const say = (why) => problems.push({ line, text: `${prop}: ${value.replace(/\s+/g, ' ')}`, why });
    if (prop === 'transition' || prop === 'transition-property') {
      for (const p of parts(value)) {
        const name = p.split(/\s+/)[0];
        if (BANNED.test(name)) say(`transitions ${name}: switch it instantly, or animate transform/opacity`);
      }
    }
    if (/motion-ok:/.test(comment)) continue;
    // Endless loops (spinners, shimmer, ambient drift) keep their own rhythm.
    if (prop === 'animation' && /\binfinite\b/.test(value)) continue;
    const times = [...value.matchAll(TIME)].map((t) => t[0]).filter((t) => parseFloat(t) !== 0);
    if (times.length) say(`duration ${times.join(', ')} is not a token: use var(--t-fast|--t-med|--t-slow)`);
  }
  return problems;
}

// Svelte/WAAPI durations in script: dur('fast'|'med'|'slow') from lib/motion.ts, or 0.
export function scriptProblems(code) {
  const problems = [];
  for (const m of code.matchAll(/\bduration\s*:\s*([^,}\n;]+)/g)) {
    const value = m[1].trim();
    // A number, a tempo product or a reduced-motion ternary; media durations (s.durationMs / 1000) are not motion.
    if (!/^\d|tempo|reducedMotion/.test(value) || /^0\b(?!\s*[*?])/.test(value)) continue;
    problems.push({ line: code.slice(0, m.index).split('\n').length, text: m[0], why: 'use dur() from lib/motion.ts' });
  }
  return problems;
}

function selfTest() {
  assert.equal(cssProblems('a{transition: opacity var(--t-fast) var(--ease), transform var(--t-med) var(--spring);}').length, 0);
  assert.equal(cssProblems('a{transition: background-color var(--t-fast) var(--ease);}').length, 1);
  assert.equal(cssProblems('a{transition:\n  box-shadow var(--t-fast),\n  width 1s;}').length, 3);
  assert.equal(cssProblems('a{transition-property: color, opacity;}').length, 1);
  assert.equal(cssProblems('a{transition: transform cubic-bezier(0.3, 0.7, 0, 1) var(--t-med);}').length, 0);
  assert.equal(cssProblems('a{animation: spin var(--t-spin) linear infinite;}').length, 0);
  assert.equal(cssProblems('a{animation: rise calc(420ms * var(--tempo)) both;}').length, 1);
  assert.equal(cssProblems('a{/* motion-ok: hand-off */ animation: vt-out calc(120ms * var(--tempo)) linear both;}').length, 0);
  assert.equal(cssProblems('a{transition-duration: 0s; animation-delay: calc(var(--i) * var(--t-stagger));}').length, 0);
  assert.equal(cssProblems('a{transition: none;}').length, 0);
  assert.equal(scriptProblems('fade(n, { duration: dur("med") })').length, 0);
  assert.equal(scriptProblems('fly(n, { y: 4, duration: 180 * tempo() })').length, 1);
  assert.equal(scriptProblems('fade(n, { duration: reducedMotion() ? 0 : 200 })').length, 1);
  assert.equal(scriptProblems('const duration = $derived(s?.runTimeTicks ?? 0)').length, 0);
  assert.equal(scriptProblems('navigator.mediaSession.setPositionState({ duration: s.durationMs / 1000 })').length, 0);
  assert.equal(scriptProblems('fade(n, { duration: 0 })').length, 0);
  assert.equal(scriptProblems('fade(n, { duration: 200 })').length, 1);
}

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(css|svelte|ts)$/.test(e.name)) yield p;
  }
}

selfTest();
if (!process.argv.includes('--self-test')) {
  const found = [];
  for (const file of files(root)) {
    const text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const rel = path.relative(root, file).replaceAll('\\', '/');
    const report = (list, offset = 0) => list.forEach((p) => found.push(`${rel}:${p.line + offset}  ${p.text}\n    ${p.why}`));
    if (file.endsWith('.css')) report(cssProblems(text));
    else if (file.endsWith('.ts')) report(scriptProblems(text));
    else {
      for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) report(cssProblems(m[1]), text.slice(0, m.index).split('\n').length - 1);
      for (const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) report(scriptProblems(m[1]), text.slice(0, m.index).split('\n').length - 1);
      // Markup: transition:fade={{ duration: … }} and friends.
      const markup = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (s) => s.replace(/[^\n]/g, ' '));
      report(scriptProblems(markup));
    }
  }
  if (found.length) {
    console.error(`motion-check: ${found.length} problem(s), see docs/design.md "Motion"\n${found.join('\n')}`);
    process.exit(1);
  }
}
console.log('motion-check: transitions and durations follow docs/design.md');
