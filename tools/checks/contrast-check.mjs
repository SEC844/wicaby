// WCAG 2.2 contrast of every theme in packages/tokens/tokens.json (docs/design.md "Themes").
// Body text (label, label-2) needs 4.5:1 on every surface it sits on; the text on a filled accent control
// (semibold, Apple's "large" tier) and the accent itself as a UI mark need 3:1. label-3 and label-4 are for
// placeholders, disabled controls and decoration (exempt under WCAG 1.4.3) and are only printed.
// Non-text (WCAG 1.4.11, 3:1): the accent on the cards it marks, a switch or slider track ('control') on a
// light theme (its white knob does not stand out there), and in High Contrast the separators that outline
// controls and groups. Other fills and hairlines are decoration. Media surfaces (.on-media) use graphite's roles.
// Run: node tools/checks/contrast-check.mjs [--print]
import assert from 'node:assert/strict';
import { resolve, rgba } from '../../packages/tokens/build.mjs';

const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** A translucent colour composited over an opaque one. */
const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
export function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// Self-test against published values: black on white is 21:1, #767676 on white is the AA edge (4.54).
assert.equal(ratio([0, 0, 0, 1], [255, 255, 255, 1]).toFixed(2), '21.00');
assert.equal(ratio(rgba('#767676'), rgba('#fff')).toFixed(2), '4.54');
assert.equal(ratio(over(rgba('rgb(0 0 0 / 0.5)'), rgba('#fff')), rgba('#fff')).toFixed(2), '3.98');

const BODY = 4.5;
const LARGE = 3;
const failures = [];
const rows = [];
for (const t of resolve()) {
  const c = (k) => rgba(t.roles[k]);
  const bg = c('bg');
  // Opaque surfaces text sits on: the canvas, cards, sheets, and the materials and hover fills over the canvas.
  const surfaces = { bg, 'bg-elevated': c('bg-elevated'), 'bg-elevated-2': c('bg-elevated-2'), material: over(c('material'), bg), 'material-thick': over(c('material-thick'), bg), 'fill-3': over(c('fill-3'), c('bg-elevated')) };
  const check = (what, value, min) => {
    rows.push(`${t.id.padEnd(9)} ${what.padEnd(34)} ${value.toFixed(2).padStart(6)}${min ? `  (min ${min})` : ''}`);
    if (min && value < min) failures.push(`${t.id}: ${what} is ${value.toFixed(2)}:1, below ${min}:1`);
  };
  for (const [name, s] of Object.entries(surfaces)) {
    check(`label on ${name}`, ratio(over(c('label'), s), s), BODY);
    check(`label-2 on ${name}`, ratio(over(c('label-2'), s), s), BODY);
    check(`label-3 on ${name}`, ratio(over(c('label-3'), s), s), 0);
  }
  for (const a of t.accents) {
    const accent = rgba(a.color);
    check(`${a.id}: accent-fg on accent`, ratio(rgba(a.fg), accent), LARGE);
    check(`${a.id}: accent on bg`, ratio(accent, bg), LARGE);
    check(`${a.id}: accent on bg-elevated`, ratio(accent, c('bg-elevated')), LARGE);
  }
  for (const s of ['bg', 'bg-elevated']) {
    check(`control on ${s}`, ratio(over(c('control'), c(s)), c(s)), t.scheme === 'light' ? LARGE : 0);
    check(`separator on ${s}`, ratio(over(c('separator'), c(s)), c(s)), t.id === 'contrast' ? LARGE : 0);
  }
}

if (process.argv.includes('--print')) console.log(rows.join('\n'));
if (failures.length) {
  console.error(`contrast-check: ${failures.length} pair(s) below WCAG AA\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`contrast-check: ${rows.length} pairs, every theme meets WCAG AA`);
