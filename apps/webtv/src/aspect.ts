// aspect-ratio for Chromium before 88 (webOS 6 and 22, Tizen 6.5): posters, stills and avatars would collapse to
// no height. The CSS keeps its aspect-ratio rules (the browser drops them from the CSSOM, not from the <style>
// text); this reads them there and sizes each matching element that collapsed: height = width / ratio.
// shortcut: only boxes sized by their width (every card and avatar in the app), not height-driven ones; a real
// fallback in the components would be cleaner if old TVs show gaps.
export function aspectRatioFallback(force = false): (() => void) | null {
  if (!force && typeof CSS !== 'undefined' && CSS.supports?.('aspect-ratio', '1 / 1')) return null;
  let rules: [string, number][] = [];
  let seen = '';
  const RULE = /([^{}]+)\{[^{}]*?aspect-ratio:\s*([\d.]+)\s*(?:\/\s*([\d.]+))?/g;
  const scan = () => {
    const styles = [...document.querySelectorAll('style')];
    const key = styles.map((s) => s.textContent?.length ?? 0).join();
    if (key === seen) return;
    seen = key;
    rules = [];
    for (const st of styles) {
      const text = st.textContent ?? '';
      RULE.lastIndex = 0;
      for (let m = RULE.exec(text); m; m = RULE.exec(text)) {
        const ratio = Number(m[2]) / (m[3] ? Number(m[3]) : 1);
        const sel = m[1].trim();
        if (ratio > 0 && sel && !sel.startsWith('@')) rules.push([sel, ratio]);
      }
    }
  };
  const apply = () => {
    scan();
    for (const [sel, ratio] of rules) {
      let els: NodeListOf<HTMLElement>;
      try {
        els = document.querySelectorAll<HTMLElement>(sel);
      } catch {
        continue; // a selector this Chromium cannot parse (:has, :is…)
      }
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1) return;
        if (el.dataset.ar !== '1' && r.height >= 2) return; // sized by its own CSS
        el.dataset.ar = '1';
        el.style.height = `${r.width / ratio}px`;
      });
    }
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  };
  const mo = new MutationObserver(later);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', later);
  later();
  return () => {
    mo.disconnect();
    window.removeEventListener('resize', later);
  };
}
