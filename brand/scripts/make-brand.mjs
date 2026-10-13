// Builds every Wicaby brand vector from one geometry: the SVG masters in brand/
// and the Android XML drawables, written straight into apps/android/{tv,mobile}/src/main/res.
// Raster outputs (icon.ico, Android legacy mipmaps) come from brand/scripts/make-icon.mjs (npm run icon) afterwards.
//
// The mark is built from geometry, not traced:
// - The W is a thick polyline P1..P5 with round outer joins and sharp inner
//   crotches. Arms 1-3 share one half-width; the right arm tapers from R at P4
//   to R5 so it flicks into the play triangle.
// - The play triangle is an inner triangle offset by its corner radius.
// - The gap: the W is cut by the triangle offset by `gap`, which leaves the
//   concave notch under the triangle and a straight cut parallel to its lower
//   edge, finished with a small fillet at the arm's tip.
// The outline is computed analytically (lines and circular arcs), so every file
// carries the same plain path data and needs no masks or strokes.
//
// Coordinates live in the 1024-unit app-icon space (tile 64..960), fitted to the
// user's 1254 px PNG (tile 78..1176).
// Usage: node brand/scripts/make-brand.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// brand/scripts -> repo root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = path.join(ROOT, 'brand');
const appRes = (app) => path.join(ROOT, 'apps', 'android', app, 'src', 'main', 'res');

export const BLUE = '#0A84FF';
export const WHITE = '#FFFFFF';
const TILE_TOP = '#1C1C1F';
const TILE_BOTTOM = '#0B0B0D';

// Master geometry (regular cut, 48 px and up).
export const REGULAR = {
  P: [[245.5, 432], [367, 667], [516.5, 436.5], [637, 668.5], [759, 459.5]],
  R: 65, // half stroke of arms 1-3
  R5: 53.5, // half stroke at the right arm's (hidden) end
  tri: { x: 732.5, top: 334, bottom: 443, tip: [828, 388.5], r: 25 },
  gap: 19.5, // along the triangle's lower edge
  notch: 42.5, // radius of the notch under the triangle's bottom-left corner: tighter than r + gap, so the gap opens up a little there
  tipFillet: 11,
};

// Small cut for 16-24 px: a gap wide enough to survive at 1 px, a slightly
// bigger triangle, a touch more weight. Same skeleton.
export const SMALL = {
  ...REGULAR,
  R: 70,
  R5: 60,
  tri: scaleTri(REGULAR.tri, 1.12, [780, 388.5]),
  gap: 40,
  notch: 56,
  tipFillet: 12,
};

function scaleTri(t, k, [cx, cy]) {
  const s = ([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k];
  const [x, top] = s([t.x, t.top]);
  const [, bottom] = s([t.x, t.bottom]);
  return { x, top, bottom, tip: s(t.tip), r: t.r * k };
}

// ---- vector helpers ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / len(a));
const rightN = (d) => [-d[1], d[0]]; // right-hand normal of travel direction (y down)

// Line as {n, c}: points X with n·X = c.
function lineInter(l1, l2) {
  const det = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
  return [(l1.c * l2.n[1] - l2.c * l1.n[1]) / det, (l1.n[0] * l2.c - l2.n[0] * l1.c) / det];
}

// Side lines of a tapered segment A(ra) -> B(rb). side = +1 right-hand, -1 left-hand.
function side(A, ra, B, rb, s) {
  const L = len(sub(B, A));
  const d = unit(sub(B, A));
  const sa = (ra - rb) / L;
  const m = add(mul(rightN(d), s * Math.sqrt(1 - sa * sa)), mul(d, sa));
  return { n: m, c: dot(m, A) + ra, a: add(A, mul(m, ra)), b: add(B, mul(m, rb)) };
}

// Intersections of line {n,c} with circle (C, rad); returns the two points ordered along the line direction t = rightN(n)... both returned.
function lineCircle(l, C, rad) {
  const foot = add(C, mul(l.n, l.c - dot(l.n, C)));
  const h = Math.sqrt(rad * rad - (l.c - dot(l.n, C)) ** 2);
  const t = [-l.n[1], l.n[0]];
  return [add(foot, mul(t, h)), add(foot, mul(t, -h))];
}

const f = (v) => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const pt = (p) => `${f(p[0])} ${f(p[1])}`;

// Arc from p0 to p1 around C. cw = clockwise on screen (y down).
function arc(C, rad, p0, p1, cw) {
  const a0 = Math.atan2(p0[1] - C[1], p0[0] - C[0]);
  const a1 = Math.atan2(p1[1] - C[1], p1[0] - C[0]);
  let span = cw ? a1 - a0 : a0 - a1;
  while (span < 0) span += 2 * Math.PI;
  return `A${f(rad)} ${f(rad)} 0 ${span > Math.PI ? 1 : 0} ${cw ? 1 : 0} ${pt(p1)}`;
}

function triVerts(t) {
  return { Tt: [t.x, t.top], Tp: t.tip, Tb: [t.x, t.bottom] };
}

// Outward normals of the triangle Tt -> Tp -> Tb (clockwise on screen).
function triNormals(t) {
  const { Tt, Tp, Tb } = triVerts(t);
  const out = (A, B) => mul(rightN(unit(sub(B, A))), -1);
  return { n1: out(Tt, Tp), n2: out(Tp, Tb), n3: out(Tb, Tt) };
}

export function trianglePath(g) {
  const t = g.tri;
  const { Tt, Tp, Tb } = triVerts(t);
  const { n1, n2, n3 } = triNormals(t);
  const r = t.r;
  const o = (P, n) => add(P, mul(n, r));
  return [
    `M${pt(o(Tt, n3))}`,
    arc(Tt, r, o(Tt, n3), o(Tt, n1), true),
    `L${pt(o(Tp, n1))}`,
    arc(Tp, r, o(Tp, n1), o(Tp, n2), true),
    `L${pt(o(Tb, n2))}`,
    arc(Tb, r, o(Tb, n2), o(Tb, n3), true),
    'Z',
  ].join('');
}

export function wPath(g) {
  const [P1, P2, P3, P4, P5] = g.P;
  const { R, R5 } = g;
  const s1L = side(P1, R, P2, R, -1), s1R = side(P1, R, P2, R, 1);
  const s2L = side(P2, R, P3, R, -1), s2R = side(P2, R, P3, R, 1);
  const s3L = side(P3, R, P4, R, -1), s3R = side(P3, R, P4, R, 1);
  const s4L = side(P4, R, P5, R5, -1), s4R = side(P4, R, P5, R5, 1);
  const C1 = lineInter(s1L, s2L);
  const C2 = lineInter(s3L, s4L);
  const C3 = lineInter(s3R, s2R);

  // The cut: the triangle offset by r + gap, with its bottom-left corner rounded wider (radius `notch`).
  const t = g.tri;
  const { Tb } = triVerts(t);
  const { n2, n3 } = triNormals(t);
  const cutR = t.r + g.gap;
  const Q = lineInter({ n: n2, c: dot(n2, Tb) + cutR - g.notch }, { n: n3, c: dot(n3, Tb) + cutR - g.notch });
  // s4's left side meets the notch arc: take the intersection nearer C2.
  const [qa, qb] = lineCircle(s4L, Q, g.notch);
  const N1 = len(sub(qa, C2)) < len(sub(qb, C2)) ? qa : qb;
  const E0 = add(Q, mul(n2, g.notch));
  // Fillet between the cut line (n2·X = n2·Tb + cutR) and s4's right side.
  const fr = g.tipFillet;
  const Cf = lineInter({ n: n2, c: dot(n2, Tb) + cutR + fr }, { n: s4R.n, c: s4R.c - fr });
  const F1 = sub(Cf, mul(n2, fr));
  const F2 = add(Cf, mul(s4R.n, fr));

  return [
    `M${pt(s1R.a)}`,
    arc(P1, R, s1R.a, s1L.a, true), // cap over the top of P1
    `L${pt(C1)}`,
    `L${pt(s2L.b)}`,
    arc(P3, R, s2L.b, s3L.a, true), // middle peak
    `L${pt(C2)}`,
    `L${pt(N1)}`,
    arc(Q, g.notch, N1, E0, false), // notch under the triangle
    `L${pt(F1)}`,
    arc(Cf, fr, F1, F2, true), // tip fillet
    `L${pt(s4R.a)}`,
    arc(P4, R, s4R.a, s3R.b, true), // right valley
    `L${pt(C3)}`,
    `L${pt(s2R.a)}`,
    arc(P2, R, s2R.a, s1R.b, true), // left valley
    'Z',
  ].join('');
}

// The W's centreline P1..P5: the path the brush follows in the loading animation
// (LogoLoader). Stroked at 2R with round joins and clipped by wPath, it paints
// exactly the W, sharp crotches, taper and notch included.
export function wCentreline(g) {
  return `M${g.P.map(pt).join('L')}`;
}

// Bounding box of the mark (W + triangle), exact enough for layout (arcs sampled).
export function bbox(g) {
  const pts = [];
  for (const P of g.P.slice(0, 4)) for (let a = 0; a < 360; a += 2) pts.push([P[0] + g.R * Math.cos((a * Math.PI) / 180), P[1] + g.R * Math.sin((a * Math.PI) / 180)]);
  const { Tt, Tp, Tb } = triVerts(g.tri);
  for (const P of [Tt, Tp, Tb]) for (let a = 0; a < 360; a += 2) pts.push([P[0] + g.tri.r * Math.cos((a * Math.PI) / 180), P[1] + g.tri.r * Math.sin((a * Math.PI) / 180)]);
  // the right arm (cut) never exceeds the triangle's reach; include P5 tip region via the fillet centre approximately
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// ---- "Wicaby" in Geist SemiBold (wght 600), outlined. Font units: 1000/em, cap height 710, baseline y = 0.
// Shaped once with HarfBuzz from @fontsource-variable/geist (see brand/README.md).
const TEXT =
  'M227.4 0 37.2 -710H174.4L304.4 -179.6L435 -710H556.2L687.4 -179.6L816.4 -710H954.2L764.4 0H619.6L495.6 -486L371.6 0ZM1024.4 0V-534H1152.4V0ZM1022 -605.4V-718.6H1154.8V-605.4ZM1502.8 12Q1423.2 12 1364.3 -22.4Q1305.4 -56.8 1272.8 -119.7Q1240.2 -182.6 1240.2 -267Q1240.2 -351.4 1272.8 -413.8Q1305.4 -476.2 1364.3 -511.1Q1423.2 -546 1502.8 -546Q1570.6 -546 1623.9 -522.1Q1677.2 -498.2 1710.6 -453.4Q1744 -408.6 1752.2 -344.8L1619.8 -338Q1612 -389 1580.6 -415.5Q1549.2 -442 1502.8 -442Q1441 -442 1406.8 -395.7Q1372.6 -349.4 1372.6 -267Q1372.6 -184.2 1406.8 -137.9Q1441 -91.6 1502.8 -91.6Q1549.6 -91.6 1581.2 -119Q1612.8 -146.4 1619.8 -202.8L1752.2 -196.8Q1744.4 -133 1711.4 -86.1Q1678.4 -39.2 1625.1 -13.6Q1571.8 12 1502.8 12ZM1991.6 12Q1908.4 12 1857.3 -26.4Q1806.2 -64.8 1806.2 -133.6Q1806.2 -203.2 1849.2 -242Q1892.2 -280.8 1979.6 -298L2157.2 -332.6Q2157.2 -389.6 2131.1 -418.2Q2105 -446.8 2054.4 -446.8Q2007.8 -446.8 1981.2 -425.5Q1954.6 -404.2 1945.4 -363.8L1815.2 -370.4Q1830.6 -454.6 1892.7 -500.3Q1954.8 -546 2054.4 -546Q2168.4 -546 2226.8 -488.7Q2285.2 -431.4 2285.2 -324.4V-129.8Q2285.2 -108.6 2292.5 -100.9Q2299.8 -93.2 2314.8 -93.2H2331.8V0Q2325.8 1.8 2312.4 3.1Q2299 4.4 2285.4 4.4Q2252.2 4.4 2226.3 -6.5Q2200.4 -17.4 2186 -43.5Q2171.6 -69.6 2171.6 -115.6L2183.2 -108Q2174.6 -72.8 2148.4 -45.5Q2122.2 -18.2 2082 -3.1Q2041.8 12 1991.6 12ZM2018 -81.2Q2060.6 -81.2 2091.7 -97.9Q2122.8 -114.6 2140 -144.9Q2157.2 -175.2 2157.2 -215.6V-245.6L2018.8 -217.6Q1976.4 -209.2 1957.5 -191.5Q1938.6 -173.8 1938.6 -145.6Q1938.6 -115 1959.3 -98.1Q1980 -81.2 2018 -81.2ZM2684 12Q2628.2 12 2586.4 -12.1Q2544.6 -36.2 2521.6 -79.2L2518.6 0H2397.4V-710H2525.4V-458.4Q2546.6 -494.6 2587.8 -520.3Q2629 -546 2684 -546Q2752.8 -546 2803.2 -511.6Q2853.6 -477.2 2881.2 -414.6Q2908.8 -352 2908.8 -267Q2908.8 -182 2881.2 -119.4Q2853.6 -56.8 2803.2 -22.4Q2752.8 12 2684 12ZM2654.6 -91.6Q2710 -91.6 2743.2 -138.2Q2776.4 -184.8 2776.4 -267Q2776.4 -349.8 2743.6 -396.1Q2710.8 -442.4 2655.8 -442.4Q2614.8 -442.4 2585.4 -421.7Q2556 -401 2540.7 -361.8Q2525.4 -322.6 2525.4 -267Q2525.4 -213 2540.7 -173.5Q2556 -134 2585.1 -112.8Q2614.2 -91.6 2654.6 -91.6ZM3015.8 150V50.8H3083.6Q3110 50.8 3122.7 42.9Q3135.4 35 3142.4 16L3156.6 -21.2H3119.6L2929.2 -534H3062L3196.4 -140.8L3323.8 -534H3456.6L3247.6 56.2Q3230.2 106 3197.6 128Q3165 150 3106.8 150Z';
const TEXT_X0 = 37.2; // left edge of the W glyph
const TEXT_X1 = 3456.6; // right edge of the y glyph
const CAP = 710;

// ---- writers ----
const W = wPath(REGULAR), T = trianglePath(REGULAR);
const Ws = wPath(SMALL), Ts = trianglePath(SMALL);

function viewFor(g, pad, square = false) {
  const b = bbox(g);
  let x0 = b.x0 - pad, y0 = b.y0 - pad, w = b.x1 - b.x0 + 2 * pad, h = b.y1 - b.y0 + 2 * pad;
  if (square) {
    const s = Math.max(w, h);
    x0 -= (s - w) / 2;
    y0 -= (s - h) / 2;
    w = h = s;
  }
  return [x0, y0, w, h].map((v) => Math.round(v));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\n?$/, '\n'));
  console.log('wrote', path.relative(ROOT, file));
}

// Android resources go to both apps; the banner is TV only (mobile has no leanback launcher).
function writeRes(rel, text, apps = ['tv', 'mobile']) {
  for (const app of apps) write(path.join(appRes(app), rel), text);
}

const vb = (v) => v.join(' ');
const markVB = viewFor(REGULAR, 16);
const markVBs = viewFor(SMALL, 16);

write(
  path.join(BRAND, 'wicaby-mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb(markVB)}" color="${WHITE.toLowerCase()}">
  <!-- Wicaby mark for dark backgrounds: white W (currentColor), blue play. Generated by brand/scripts/make-brand.mjs. -->
  <path fill="currentColor" d="${W}"/>
  <path fill="${BLUE.toLowerCase()}" d="${T}"/>
</svg>`,
);

write(
  path.join(BRAND, 'wicaby-mark-mono.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb(markVB)}" fill="currentColor">
  <!-- Wicaby mark, one colour (currentColor), gap kept. Sidebar, themed and notification icons. -->
  <path d="${W}"/>
  <path d="${T}"/>
</svg>`,
);

write(
  path.join(BRAND, 'wicaby-mark-small.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb(markVBs)}" color="${WHITE.toLowerCase()}">
  <!-- Small optical cut (16-24 px): wider gap, bigger triangle, a touch more weight. Mono use: set the triangle to currentColor. -->
  <path fill="currentColor" d="${Ws}"/>
  <path fill="${BLUE.toLowerCase()}" d="${Ts}"/>
</svg>`,
);

function appIcon(g, { small }) {
  // Regular: the user's framing (tile 64..960, rx 170). Small: full-bleed tile, mark scaled up about the tile centre.
  const tile = small ? { x: 16, s: 992, rx: 200 } : { x: 64, s: 896, rx: 170 };
  const k = small ? 1.08 : 1;
  const mark = small
    ? `<g transform="translate(512 512) scale(${k}) translate(-512 -520)">`
    : '<g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <!-- Wicaby app icon${small ? ', small cut (16-32 px): full-bleed tile, wider gap' : ' (48 px and up)'}. Generated by brand/scripts/make-brand.mjs. -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TILE_TOP}"/>
      <stop offset="1" stop-color="${TILE_BOTTOM}"/>
    </linearGradient>${
      small
        ? ''
        : `
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".16"/>
      <stop offset=".35" stop-color="#fff" stop-opacity=".04"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".02"/>
    </linearGradient>`
    }
  </defs>
  <rect x="${tile.x}" y="${tile.x}" width="${tile.s}" height="${tile.s}" rx="${tile.rx}" fill="url(#tile)"/>${
    small
      ? ''
      : `
  <rect x="${tile.x + 1.5}" y="${tile.x + 1.5}" width="${tile.s - 3}" height="${tile.s - 3}" rx="${tile.rx - 1.5}" fill="none" stroke="url(#rim)" stroke-width="3"/>`
  }
  ${mark}
    <path fill="${WHITE.toLowerCase()}" d="${small ? Ws : W}"/>
    <path fill="${BLUE.toLowerCase()}" d="${small ? Ts : T}"/>
  </g>
</svg>`;
}
write(path.join(BRAND, 'wicaby-app-icon.svg'), appIcon(REGULAR, { small: false }));
write(path.join(BRAND, 'wicaby-app-icon-small.svg'), appIcon(SMALL, { small: true }));

// Legacy (API 23-25) round launcher icon source: graphite disc, mark scaled to sit inside the circle.
write(
  path.join(BRAND, 'android', 'legacy-round.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <!-- Source of the TV app's res/mipmap-*/ic_launcher_round.png (rendered by brand/scripts/make-icon.mjs). -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TILE_TOP}"/>
      <stop offset="1" stop-color="${TILE_BOTTOM}"/>
    </linearGradient>
  </defs>
  <circle cx="512" cy="512" r="464" fill="url(#tile)"/>
  <g transform="translate(512 512) scale(0.9) translate(-516 -522)">
    <path fill="${WHITE.toLowerCase()}" d="${W}"/>
    <path fill="${BLUE.toLowerCase()}" d="${T}"/>
  </g>
</svg>`,
);

// Wordmark: text cap height = 0.6 x the W's body height, cap band centred on the W body.
function lockup(g) {
  const b = bbox(g);
  const bodyTop = Math.min(g.P[0][1], g.P[2][1]) - g.R;
  const bodyBottom = Math.max(g.P[1][1], g.P[3][1]) + g.R;
  const cap = 0.6 * (bodyBottom - bodyTop);
  const k = cap / CAP;
  const baseline = (bodyTop + bodyBottom) / 2 + cap / 2;
  const gapX = 0.62 * cap;
  const tx = b.x1 + gapX - TEXT_X0 * k;
  const right = tx + TEXT_X1 * k;
  return { b, k, tx, baseline, right };
}
{
  const L = lockup(REGULAR);
  const pad = 16;
  const x0 = Math.floor(L.b.x0 - pad), y0 = Math.floor(L.b.y0 - pad);
  const w = Math.ceil(L.right + pad - x0), h = Math.ceil(L.b.y1 + pad - y0);
  write(
    path.join(BRAND, 'wicaby-wordmark.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" color="${WHITE.toLowerCase()}">
  <!-- Wicaby lockup: mark + "Wicaby" in Geist SemiBold (600), outlined. W and text take currentColor (white by default, for dark backgrounds). -->
  <path fill="currentColor" d="${W}"/>
  <path fill="${BLUE.toLowerCase()}" d="${T}"/>
  <path fill="currentColor" transform="translate(${f(L.tx)} ${f(L.baseline)}) scale(${f(L.k * 1e4) / 1e4})" d="${TEXT}"/>
</svg>`,
  );
}

// ---- Android ----
const androidHeader = (w, h, vw, vh, extra = '') =>
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"${extra}
    android:width="${w}dp"
    android:height="${h}dp"
    android:viewportWidth="${vw}"
    android:viewportHeight="${vh}">`;

const vPath = (d, color, indent = '        ') => `${indent}<path
${indent}    android:fillColor="${color}"
${indent}    android:pathData="${d}" />`;

// Adaptive layers: 108 dp canvas; the mark is about 48 dp wide, centred, well inside the 66 dp safe zone.
function adaptiveGroup(g, wPathD, tPathD, wColor, tColor) {
  const b = bbox(g);
  const k = 48 / (b.x1 - b.x0);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const tx = 54 - cx * k, ty = 54.6 - cy * k;
  return `    <group
        android:translateX="${f(tx * 1000) / 1000}"
        android:translateY="${f(ty * 1000) / 1000}"
        android:scaleX="${f(k * 1e5) / 1e5}"
        android:scaleY="${f(k * 1e5) / 1e5}">
${vPath(wPathD, wColor)}
${vPath(tPathD, tColor)}
    </group>`;
}

writeRes(
  path.join('drawable', 'ic_launcher_foreground.xml'),
  `${androidHeader(108, 108, 108, 108)}
    <!-- Adaptive icon foreground: white W and blue play, about 48 dp wide inside the 66 dp safe zone. Generated by brand/scripts/make-brand.mjs. -->
${adaptiveGroup(REGULAR, W, T, '#FFFFFFFF', '#FF0A84FF')}
</vector>`,
);

writeRes(
  path.join('drawable', 'ic_launcher_monochrome.xml'),
  `${androidHeader(108, 108, 108, 108)}
    <!-- Android 13+ themed icon layer: one colour, the launcher tints it. The gap stays open. -->
${adaptiveGroup(REGULAR, W, T, '#FFFFFFFF', '#FFFFFFFF')}
</vector>`,
);

writeRes(
  path.join('drawable', 'ic_launcher_background.xml'),
  `${androidHeader(108, 108, 108, 108, '\n    xmlns:aapt="http://schemas.android.com/aapt"')}
    <!-- Graphite tile, lighter at the top (adaptive icons are API 26+, so the gradient is safe). -->
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="54"
                android:startY="0"
                android:endX="54"
                android:endY="108"
                android:startColor="#FF${TILE_TOP.slice(1)}"
                android:endColor="#FF${TILE_BOTTOM.slice(1)}" />
        </aapt:attr>
    </path>
</vector>`,
);

writeRes(
  path.join('values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Flat graphite, the middle of the tile gradient: use instead of the gradient drawable if preferred. -->
    <color name="ic_launcher_background">#141416</color>
</resources>`,
);

// Notification small icon: 24 dp, white, small cut (wide gap), about 22 dp wide.
{
  const b = bbox(SMALL);
  const k = 22 / (b.x1 - b.x0);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  writeRes(
    path.join('drawable', 'ic_stat_wicaby.xml'),
    `${androidHeader(24, 24, 24, 24)}
    <!-- Notification small icon: white on transparent, small cut of the mark so the gap survives at 24 px. -->
    <group
        android:translateX="${f((12 - cx * k) * 1000) / 1000}"
        android:translateY="${f((12.4 - cy * k) * 1000) / 1000}"
        android:scaleX="${f(k * 1e6) / 1e6}"
        android:scaleY="${f(k * 1e6) / 1e6}">
${vPath(Ws, '#FFFFFFFF')}
${vPath(Ts, '#FFFFFFFF')}
    </group>
</vector>`,
  );
}

// TV banner 320x180: flat graphite (no gradient: the TV app runs on API 23), lockup centred.
{
  const L = lockup(REGULAR);
  const lw = L.right - L.b.x0, lh = L.b.y1 - L.b.y0;
  const k = 220 / lw;
  const tx = 160 - (L.b.x0 + lw / 2) * k, ty = 90 - (L.b.y0 + lh / 2) * k;
  const tk = L.k * k;
  const group = (inner, gx, gy, gk) => `    <group
        android:translateX="${f(gx * 1000) / 1000}"
        android:translateY="${f(gy * 1000) / 1000}"
        android:scaleX="${f(gk * 1e6) / 1e6}"
        android:scaleY="${f(gk * 1e6) / 1e6}">
${inner}
    </group>`;
  writeRes(
    path.join('drawable', 'banner.xml'),
    `${androidHeader(160, 90, 320, 180)}
    <!-- Android TV launcher banner: graphite field, mark + "Wicaby" (Geist SemiBold, outlined). -->
    <path
        android:fillColor="#FF141416"
        android:pathData="M0,0h320v180h-320z" />
${group(`${vPath(W, '#FFFFFFFF')}\n${vPath(T, '#FF0A84FF')}`, tx, ty, k)}
${group(vPath(TEXT, '#FFFFFFFF'), tx + L.tx * k, ty + L.baseline * k, tk)}
</vector>`,
    ['tv'],
  );
}

// Paths for src/renderer/components/Logo.svelte (square viewBox around the mark).
const sq = viewFor(REGULAR, 8, true), sqs = viewFor(SMALL, 8, true);
// Loader geometry ("brush" animation), shared by the desktop LogoLoader.svelte
// (brand/wicaby-mark-path.json) and the Android LogoLoader composables
// (:core WicabyMark.kt, plain constants: :core stays UI-free). Both cuts sit in
// the regular square viewBox, the one Logo.svelte uses, so they swap in place.
{
  const cut = (g) => {
    const { Tt, Tp, Tb } = triVerts(g.tri);
    // Where the gap's cut crosses the right arm's centreline, as a fraction of the centreline length.
    const lens = g.P.slice(1).map((p, i) => len(sub(p, g.P[i])));
    const total = lens.reduce((a, b) => a + b, 0);
    const [P4, P5] = [g.P[3], g.P[4]];
    const n2 = triNormals(g.tri).n2;
    const u = (dot(n2, Tb) + g.tri.r + g.gap - dot(n2, P4)) / dot(n2, sub(P5, P4));
    const lineEnd = Math.round(((total - lens[3] + u * lens[3]) / total) * 1e4) / 1e4;
    return {
      w: wPath(g),
      play: trianglePath(g),
      line: wCentreline(g),
      points: g.P,
      stroke: 2 * g.R,
      lineEnd,
      playCentre: [(Tt[0] + Tp[0] + Tb[0]) / 3, (Tt[1] + Tp[1] + Tb[1]) / 3].map((v) => Math.round(v * 100) / 100),
    };
  };
  const data = { viewBox: sq, regular: cut(REGULAR), small: cut(SMALL) };
  write(
    path.join(BRAND, 'wicaby-mark-path.json'),
    JSON.stringify({ $comment: 'Generated by brand/scripts/make-brand.mjs: loader geometry (W outline, play, W centreline).', ...data }, null, 2),
  );
  const kf = (v) => `${f(v)}f`;
  const kCut = (c) => `Cut(
        w = "${c.w}",
        play = "${c.play}",
        line = floatArrayOf(${c.points.flat().map(kf).join(', ')}),
        stroke = ${kf(c.stroke)},
        lineEnd = ${c.lineEnd}f,
        playX = ${kf(c.playCentre[0])},
        playY = ${kf(c.playCentre[1])},
    )`;
  write(
    path.join(ROOT, 'apps', 'android', 'core', 'src', 'main', 'java', 'com', 'wika', 'wicaby', 'core', 'brand', 'WicabyMark.kt'),
    `package com.wika.wicaby.core.brand

// Generated by brand/scripts/make-brand.mjs: do not edit by hand.
// Geometry of the Wicaby mark for the LogoLoader composables (tv, mobile): the W
// outline and play triangle as SVG path data, and the W's centreline P1..P5 the
// brush follows. All coordinates are in the square viewBox below.
object WicabyMark {
    class Cut(
        val w: String,
        val play: String,
        /** Centreline points x0, y0, x1, y1, ... from the W's top-left to the hidden end of the right arm. */
        val line: FloatArray,
        /** Brush width: the W's full stroke (2R). */
        val stroke: Float,
        /** Fraction of the centreline where the gap cuts the right arm: the visible end of the ink. */
        val lineEnd: Float,
        /** Centroid of the play triangle, the pivot of its stamp. */
        val playX: Float,
        val playY: Float,
    )

    const val VIEW_X = ${kf(sq[0])}
    const val VIEW_Y = ${kf(sq[1])}
    const val VIEW_SIZE = ${kf(sq[2])}

    /** 48 px and up. */
    val regular = ${kCut(data.regular)}

    /** Small optical cut (wider gap) for inline sizes. */
    val small = ${kCut(data.small)}
}`,
  );
}

if (process.argv.includes('--logo')) console.log(JSON.stringify({ viewBox: vb(sq), w: W, t: T, viewBoxSmall: vb(sqs), ws: Ws, ts: Ts }, null, 2));
