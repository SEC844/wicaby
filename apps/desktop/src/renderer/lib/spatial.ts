// Spatial navigation for keyboard and gamepad (10-foot use). Arrow keys move
// focus to the nearest focusable element in that direction.
import { back, router } from './router.svelte';

type Dir = 'up' | 'down' | 'left' | 'right';

// tabindex="-1" opts out (hover-only row arrows, toast close buttons…).
const FOCUSABLE = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea', '[tabindex]']
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(', ');

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

// Off-screen elements stay eligible: rows and pages scroll them into view.
function sized(r: DOMRect): boolean {
  return r.width >= 2 && r.height >= 2;
}

function shown(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert], [aria-hidden="true"]');
}

function visible(el: HTMLElement): boolean {
  return sized(el.getBoundingClientRect()) && shown(el);
}

function candidates(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pick(from: HTMLElement, dir: Dir): HTMLElement | null {
  // Stay inside an open menu or dialog if focus is in one.
  const scope = from.closest<HTMLElement>('[role="menu"], [role="dialog"]') ?? document;
  const a = from.getBoundingClientRect();
  const ca = center(a);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  // One rect read per element; the style checks only for one that would beat the best so far (a grid of
  // thousands of cards is measured once per key press, not styled).
  for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    if (!sized(b)) continue;
    const cb = center(b);
    let primary: number;
    let cross: number;
    switch (dir) {
      case 'right':
        primary = b.left - a.right;
        if (cb.x <= ca.x + 1) continue;
        cross = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) > 0 ? Math.abs(cb.y - ca.y) : 0;
        break;
      case 'left':
        primary = a.left - b.right;
        if (cb.x >= ca.x - 1) continue;
        cross = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) > 0 ? Math.abs(cb.y - ca.y) : 0;
        break;
      case 'down':
        primary = b.top - a.bottom;
        if (cb.y <= ca.y + 1) continue;
        cross = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) > 0 ? Math.abs(cb.x - ca.x) : 0;
        break;
      case 'up':
        primary = a.top - b.bottom;
        if (cb.y >= ca.y - 1) continue;
        cross = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) > 0 ? Math.abs(cb.x - ca.x) : 0;
        break;
    }
    // Overlapping elements give a slightly negative gap; treat as adjacent.
    const gap = Math.max(0, primary);
    const score = gap + cross * 2.5 + (dir === 'left' || dir === 'right' ? Math.abs(cb.y - ca.y) * 0.3 : Math.abs(cb.x - ca.x) * 0.15);
    if (score < bestScore && shown(el)) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function move(dir: Dir): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) {
    const first = candidates(document.getElementById('main-scroller') ?? document)[0] ?? candidates(document)[0];
    first?.focus();
    return Boolean(first);
  }
  const next = pick(active, dir);
  if (!next) return false;
  next.focus({ preventScroll: true });
  reveal(next);
  return true;
}

function scrollsX(el: HTMLElement): boolean {
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const o = getComputedStyle(el).overflowX;
  return o === 'auto' || o === 'scroll';
}

// Bring the new focus into view smoothly: vertically just enough (pages keep
// their place, scroll-margin leaves room for the focus lift), and centred in
// horizontal shelves so the row glides under a fixed focus, like tvOS.
function reveal(el: HTMLElement): void {
  const still = document.documentElement.hasAttribute('data-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const smooth: ScrollBehavior = still ? 'auto' : 'smooth';
  let row: HTMLElement | null = el.parentElement;
  while (row && !scrollsX(row)) row = row.parentElement;
  // TV look (apps/webtv, CSS zoom 1.5): Chromium 79-85 ignores scrollIntoView there, so the page's scroller is
  // scrolled by hand. clientHeight / rect height turns rect px into scroll px (current Chromium zooms rects, old not).
  const tv = document.documentElement.hasAttribute('data-tv');
  const page = tv ? el.closest<HTMLElement>('#main-scroller') : null;
  if (page) {
    const p = page.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    const k = page.clientHeight / p.height || 1;
    const pad = 56 / k; // App.svelte's scroll-margin, in rect px
    const dy = e.top < p.top + pad ? e.top - p.top - pad : e.bottom > p.bottom - pad ? e.bottom - p.bottom + pad : 0;
    if (dy) page.scrollBy({ top: dy * k, behavior: smooth });
  } else el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth });
  if (!row) return;
  const r = row.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const kx = tv ? row.clientWidth / r.width || 1 : 1;
  const left = row.scrollLeft + ((e.left - r.left) - (r.width - e.width) / 2) * kx;
  row.scrollTo({ left: Math.max(0, Math.min(left, row.scrollWidth - row.clientWidth)), behavior: smooth });
}

// TV remotes' Back key: LG webOS sends keyCode 461, Samsung Tizen 10009 (e.key is not standard on either).
export const isBackKey = (e: KeyboardEvent): boolean => e.key === 'BrowserBack' || e.keyCode === 461 || e.keyCode === 10009;

// Older Chromium (webOS 6, Tizen 6.5) returns a GamepadList, which is not an array.
const gamepads = () => Array.from(navigator.getGamepads?.() ?? []);

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export function initSpatialNav(): () => void {
  // The player and the comic reader own their keys.
  const enabled = () => router.route.name !== 'player' && router.route.name !== 'read';
  // In the reader the pad speaks keyboard: the d-pad turns pages, A is Enter, B goes back.
  const reading = () => router.route.name === 'read';
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const DIR_KEY: Record<Dir, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  const onKey = (e: KeyboardEvent) => {
    if (!enabled() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    const typing = isTextInput(active);
    if (isBackKey(e) || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      back();
      return;
    }
    const dir = KEY_DIR[e.key];
    if (!dir) return;
    // Inside text fields only vertical moves leave the field; selects keep their arrows.
    if (typing && (dir === 'left' || dir === 'right')) return;
    if (active instanceof HTMLSelectElement) return;
    if (active instanceof HTMLInputElement && active.type === 'range' && (dir === 'left' || dir === 'right')) return;
    if (move(dir)) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  // ---- Gamepad ----
  let raf = 0;
  let idle = 0;
  let lastDir: Dir | null = null;
  let nextRepeat = 0;
  const pressed = new Set<number>();

  const poll = (t: number) => {
    raf = 0;
    const pad = gamepads().find((p) => p && p.connected);
    if (!pad) return;
    if (enabled() || reading()) {
      const go = (d: Dir) => (reading() ? key(DIR_KEY[d]) : move(d));
      const b = (i: number) => Boolean(pad.buttons[i]?.pressed);
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      let dir: Dir | null = null;
      if (b(12) || ay < -0.6) dir = 'up';
      else if (b(13) || ay > 0.6) dir = 'down';
      else if (b(14) || ax < -0.6) dir = 'left';
      else if (b(15) || ax > 0.6) dir = 'right';
      if (dir) {
        if (dir !== lastDir) {
          go(dir);
          nextRepeat = t + 420;
        } else if (t >= nextRepeat) {
          go(dir);
          nextRepeat = t + 110;
        }
      }
      lastDir = dir;

      for (const i of [0, 1]) {
        const down = b(i);
        if (down && !pressed.has(i)) {
          pressed.add(i);
          if (i === 0 && reading()) key('Enter');
          else if (i === 0) (document.activeElement as HTMLElement | null)?.click();
          // Through the key path, so an open sheet or menu closes first instead of the route changing under it.
          else key('BrowserBack');
        } else if (!down) pressed.delete(i);
      }
    }
    // Every frame only while something is held (repeat timing); an idle pad is polled every 30 ms, short
    // enough to catch a quick tap (40-90 ms): the Gamepad API keeps no press that falls between two reads.
    if (lastDir || pressed.size) raf = requestAnimationFrame(poll);
    else idle = window.setTimeout(() => ((idle = 0), poll(performance.now())), 30);
  };
  const start = () => {
    if (!raf && !idle) raf = requestAnimationFrame(poll);
  };
  window.addEventListener('gamepadconnected', start);
  if (gamepads().some((p) => p?.connected)) start();

  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('gamepadconnected', start);
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(idle);
  };
}
