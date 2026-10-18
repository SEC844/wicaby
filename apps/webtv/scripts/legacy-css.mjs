// PostCSS pass for the web TV build only (docs/webtv.md): webOS 6 runs Chromium 79, Tizen 6.5 Chromium 85. They drop a
// whole rule when one selector in its list is unknown, and Svelte 5 scopes with :where(.svelte-x) (Chromium 88), so
// without this most component styles vanish. Lightning CSS (cssTarget) lowers the rest, :is() included.
const SIDES = ['top', 'right', 'bottom', 'left'];
const lowered = new WeakSet();

export function legacyCss() {
  return {
    postcssPlugin: 'wicaby-legacy-css',
    Rule(rule, { postcss, result }) {
      if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
      // Scroll-driven animations are Chromium 115: without the timeline they jump to their end (a backdrop at
      // opacity 0), so they only apply where the timeline does.
      if (rule.parent?.name !== 'supports' && rule.some((n) => n.prop === 'animation-timeline')) {
        const anim = rule.nodes.filter((n) => n.type === 'decl' && n.prop.startsWith('animation'));
        const only = postcss.atRule({ name: 'supports', params: '(animation-timeline: scroll())' });
        only.append(postcss.rule({ selector: rule.selector }).append(anim));
        rule.after(only);
        if (!rule.nodes.length) return rule.remove();
      }
      const sel = rule.selectors
        // Same match, one class more specificity: what Svelte 4 emitted.
        .map((s) => s.replace(/:where\((\.svelte-[\w-]+)\)/g, '$1').replace(/:focus-visible/g, ':focus'))
        // :has() is Chromium 105: those selectors never match there, and would take their siblings down with them.
        .filter((s) => !s.includes(':has('));
      if (!sel.length) return rule.remove();
      if (sel.join() !== rule.selectors.join()) rule.selectors = sel;
      // Flex gap is Chromium 84 (webOS 6 has 79): margins between the children, under html.no-flex-gap (src/tv.ts).
      // shortcut: only rules that set display:flex and the gap together, and no gap between wrapped lines.
      const decl = (p) => rule.nodes.findLast((n) => n.type === 'decl' && n.prop === p)?.value;
      const gap = decl('gap');
      // Not in a component's <style> before Svelte compiles it (it would prune the new selector as unused): its
      // compiled CSS comes through here again.
      const preprocess = /\.vite-preprocess\.css$/.test(result.opts.from ?? '');
      if (!preprocess && !lowered.has(rule) && /^(inline-)?flex$/.test(decl('display') ?? '') && (gap || decl('column-gap') || decl('row-gap'))) {
        lowered.add(rule);
        const column = /^column/.test(decl('flex-direction') ?? '');
        const parts = postcss.list.space(gap ?? '');
        const value = column ? (decl('row-gap') ?? parts[0]) : (decl('column-gap') ?? parts[1] ?? parts[0]);
        if (value && value !== 'normal' && !/^0\D*$/.test(value)) {
          const kids = postcss.rule({ selector: sel.map((s) => `.no-flex-gap ${s} > * + *`).join(', ') });
          kids.append({ prop: column ? 'margin-top' : 'margin-left', value });
          rule.after(kids);
        }
      }
    },
    Declaration: {
      // Under the TV's CSS zoom (src/tv.css) Chromium scales vh and vw too: a 100vh hero would be 1.5 screens tall.
      // var(--vh) and var(--vw) are 1vh and 1vw, divided by the zoom there.
      '*'(d) {
        if (d.prop === '--vh' || d.prop === '--vw') return;
        const v = d.value.replace(/(^|[^\w.-])(\d*\.?\d+)(vh|vw)\b/g, '$1calc($2 * var(--$3))');
        if (v !== d.value) d.value = v;
      },
      // Individual transform properties are Chromium 104: fold them into transform (applied before it, as specified).
      translate: (d, { list }) => fold(d, list, 'translate'),
      scale: (d, { list }) => fold(d, list, 'scale'),
      // inset is Chromium 87; Lightning CSS keeps it when a value is a var().
      inset(d, { list }) {
        const v = list.space(d.value);
        const all = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
        for (let i = 3; i >= 0; i--) d.cloneAfter({ prop: SIDES[i], value: all[i] });
        d.remove();
      },
    },
  };
}
legacyCss.postcss = true;

function fold(d, list, fn) {
  const v = list.space(d.value);
  const f = d.value === 'none' ? '' : `${v.length === 3 ? `${fn}3d` : fn}(${v.join(', ')})`;
  const t = d.parent.nodes.find((n) => n.type === 'decl' && n.prop === 'transform');
  if (f && !t) d.cloneBefore({ prop: 'transform', value: f });
  else if (f) t.value = t.value === 'none' ? f : `${f} ${t.value}`;
  d.remove();
}
