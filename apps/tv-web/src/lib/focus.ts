// Remote-control focus. The focus is virtual: the focused element carries the `focused` class, and the DOM focus is
// only used for text fields (the on-screen keyboard needs it). Virtual focus lets the app own scrolling, which TVs
// need (Chromium 53 cannot focus without scrolling: preventScroll arrived in 64).
//
// - Arrows move to the nearest focusable element in that direction (geometric search, like Compose).
// - A `data-focus-group` element remembers its last focused child and gives focus back to it when entered from
//   outside (Compose focusRestorer): rows, the tab bar, the settings menu.
// - A `data-focus-trap` element (dialogs, sheets) keeps the search inside it.
// - Every change dispatches a bubbling `tvfocus` event on the newly focused element, so containers can scroll it
//   into view (Row, Page).
// Elements opt in with the `focusable` action; OK on the focused element dispatches a click (see pressDown/pressUp).

export type Dir = 'up' | 'down' | 'left' | 'right';

const ATTR = 'data-focusable';
const memory = new WeakMap<Element, HTMLElement>();
let current: HTMLElement | null = null;

export function focused(): HTMLElement | null {
  return current && current.isConnected ? current : null;
}

function groupsOf(el: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) if (p.hasAttribute('data-focus-group')) out.push(p);
  return out;
}

export function setFocus(el: HTMLElement | null): void {
  if (!el || el === current) return;
  current?.classList.remove('focused');
  current = el;
  el.classList.add('focused');
  for (const g of groupsOf(el)) memory.set(g, el);
  // Text fields get the real focus so the TV's keyboard opens on OK; everything else releases it.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
  else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  el.dispatchEvent(new CustomEvent('tvfocus', { bubbles: true }));
}

function visible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('[inert], [data-focus-disabled]');
}

function scopeOf(el: HTMLElement | null): ParentNode {
  const traps = document.querySelectorAll<HTMLElement>('[data-focus-trap]');
  // The last trap in document order is the topmost dialog.
  if (traps.length) return traps[traps.length - 1];
  return el?.closest('[data-focus-scope]') ?? document;
}

function candidates(scope: ParentNode): HTMLElement[] {
  return Array.prototype.filter.call(scope.querySelectorAll(`[${ATTR}]`), visible) as HTMLElement[];
}

// Distance in the direction of travel plus a penalty for the sideways offset; candidates overlapping the current
// element's band on the cross axis win over diagonal ones.
function score(a: DOMRect, b: DOMRect, dir: Dir): number {
  const horizontal = dir === 'left' || dir === 'right';
  const primary =
    dir === 'right' ? b.left - a.right : dir === 'left' ? a.left - b.right : dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
  const forward =
    dir === 'right' ? b.left + b.width / 2 > a.left + a.width / 2 + 1 :
    dir === 'left' ? b.left + b.width / 2 < a.left + a.width / 2 - 1 :
    dir === 'down' ? b.top + b.height / 2 > a.top + a.height / 2 + 1 :
    b.top + b.height / 2 < a.top + a.height / 2 - 1;
  if (!forward) return Infinity;
  const overlap = horizontal
    ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    : Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const cross = horizontal
    ? Math.abs(b.top + b.height / 2 - (a.top + a.height / 2))
    : Math.abs(b.left + b.width / 2 - (a.left + a.width / 2));
  return Math.max(0, primary) + (overlap > 0 ? cross * 0.1 : cross * 2 + 10_000);
}

export function move(dir: Dir): boolean {
  const from = focused();
  if (!from) return focusFirst();
  // A group can take over its own arrows (a grid with wrap, a slider); it calls preventDefault() to claim the key.
  const claim = new CustomEvent('tvmove', { bubbles: true, cancelable: true, detail: dir });
  if (!from.dispatchEvent(claim)) return true;
  const a = from.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates(scopeOf(from))) {
    if (el === from) continue;
    const s = score(a, el.getBoundingClientRect(), dir);
    if (s < bestScore) { bestScore = s; best = el; }
  }
  if (!best) return false;
  // Entering a group from outside: back to the child focused last time it was left.
  const fromGroups = new Set(groupsOf(from));
  for (const g of groupsOf(best).reverse()) {
    if (fromGroups.has(g)) continue;
    const remembered = memory.get(g);
    if (remembered && remembered.isConnected && visible(remembered)) { best = remembered; break; }
  }
  setFocus(best);
  return true;
}

// Focus the element marked `data-autofocus` in the current scope, else its first focusable one.
export function focusFirst(scope: ParentNode = scopeOf(null)): boolean {
  const auto = scope.querySelector<HTMLElement>(`[${ATTR}][data-autofocus]`);
  const el = auto && visible(auto) ? auto : candidates(scope)[0];
  if (!el) return false;
  setFocus(el);
  return true;
}

// Restore the remembered child of a group (or its first one): used when a screen comes back from the stack.
export function focusGroup(group: Element): boolean {
  const remembered = memory.get(group);
  if (remembered && remembered.isConnected && visible(remembered)) {
    setFocus(remembered);
    return true;
  }
  return focusFirst(group);
}

// OK follows Android tvFocus: the element shrinks while OK is down (`pressed`) and clicks on release. Held past
// LONG_PRESS_MS it dispatches a bubbling `tvlongpress` instead (Continue Watching's menu), and the release no longer
// clicks unless nobody handled it.
const LONG_PRESS_MS = 500;
let pressed: { el: HTMLElement; at: number; long: boolean; handled: boolean } | null = null;

export function pressDown(repeat: boolean): void {
  const el = focused();
  if (!el) return;
  if (!repeat || !pressed) {
    pressed = { el, at: Date.now(), long: false, handled: false };
    el.classList.add('pressed');
    return;
  }
  if (!pressed.long && Date.now() - pressed.at >= LONG_PRESS_MS) {
    pressed.long = true;
    pressed.handled = !el.dispatchEvent(new CustomEvent('tvlongpress', { bubbles: true, cancelable: true }));
    if (pressed.handled) el.classList.remove('pressed');
  }
}

export function pressUp(): void {
  const p = pressed;
  pressed = null;
  if (!p) return;
  p.el.classList.remove('pressed');
  if (!p.handled && p.el === focused()) p.el.click();
}

// Svelte action: <button use:focusable>. Clicking (OK) runs the element's click handlers.
// `autofocus`: the default element (Compose remembered(default = true)). It takes the focus when it appears and the
// top screen has none yet: content that loads after the screen opened (the home hero) still gets it, while a user
// already browsing (the tab bar) keeps theirs.
export function focusable(node: HTMLElement, autofocus = false) {
  node.setAttribute(ATTR, '');
  if (autofocus) {
    node.setAttribute('data-autofocus', '');
    requestAnimationFrame(() => {
      const top = document.querySelector('[data-screen-top]');
      const cur = focused();
      const free = !cur || !visible(cur) || (top !== null && !top.contains(cur) && !cur.closest('[data-focus-trap]'));
      if (free && node.isConnected && visible(node) && (!top || top.contains(node))) setFocus(node);
    });
  }
  return {
    destroy() {
      if (current === node) current = null;
    },
  };
}
