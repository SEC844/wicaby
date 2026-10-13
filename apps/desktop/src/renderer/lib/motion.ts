// Browse-side motion helpers: image reveal, shared-element morphs into the
// item page, and a small stash so that page can paint before its fetch returns.
import type { BaseItem } from '../../shared/models';
import { apiFor, itemKey } from './api';
import { backdropUrl } from './images';
import './motion.css';

export function reducedMotion(): boolean {
  return document.documentElement.hasAttribute('data-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Svelte action: fade an <img> in once decoded. Cached images show at once so a
// view-transition snapshot taken right after mount already contains them.
export function reveal(img: HTMLImageElement) {
  const done = () => img.classList.add('in');
  const fail = () => img.classList.add('err');
  if (img.complete && img.naturalWidth > 0) img.classList.add('in', 'now');
  img.addEventListener('load', done);
  img.addEventListener('error', fail);
  return {
    destroy() {
      img.removeEventListener('load', done);
      img.removeEventListener('error', fail);
    },
  };
}

// `src` is the artwork URL the card already has decoded: the item page shows it
// (blurred) at once, under the full-size backdrop that loads afterwards.
const stash = new Map<string, { item: BaseItem; src?: string | null }>();

// Keyed by itemKey(): ids collide across servers.
export function remember(item: BaseItem, src?: string | null): void {
  const key = itemKey(item);
  stash.delete(key);
  stash.set(key, { item, src });
  if (stash.size > 60) stash.delete(stash.keys().next().value as string);
}

export function peek(key: string): BaseItem | null {
  return stash.get(key)?.item ?? null;
}

export function peekSrc(key: string): string | null {
  return stash.get(key)?.src ?? null;
}

let pending: { id: string; at: number } | null = null;

// Name the clicked artwork `poster-<id>` for the coming page transition; the
// item page claims the same name with takeMorph(). Names are cleared right after
// so they never collide with a later transition.
export function morphFrom(el: HTMLElement | null | undefined, id: string): void {
  if (!el || !document.startViewTransition || reducedMotion()) return;
  el.style.setProperty('view-transition-name', morphName(id));
  el.style.setProperty('view-transition-class', 'morph');
  pending = { id, at: performance.now() };
  setTimeout(() => {
    el.style.removeProperty('view-transition-name');
    el.style.removeProperty('view-transition-class');
  }, 1200);
}

export function takeMorph(id: string): boolean {
  const ok = pending?.id === id && performance.now() - pending.at < 1500;
  pending = null;
  return ok;
}

export function morphName(id: string): string {
  return `poster-${id.replace(/[^\w-]/g, '_')}`;
}

// Hover/focus intent: warm the API cache and the backdrop so the item page (and
// its morph snapshot) is complete on the first frame.
const warmed = new Set<string>();
export function prefetch(item: BaseItem): void {
  void apiFor(item.ServerId).item(item.Id).catch(() => undefined);
  const bd = backdropUrl(item, 1920);
  if (!bd || warmed.has(bd)) return;
  warmed.add(bd);
  const img = new Image();
  img.decoding = 'async';
  img.src = bd;
}

// The shared scroller keeps one offset for every route: start new pages at the
// top and put "back" pages where they were. Call from onMount; returns cleanup.
const offsets = new Map<string, number>();
export function scrollMemory(): () => void {
  const el = document.getElementById('main-scroller');
  if (!el) return () => undefined;
  const key = location.hash.split('?')[0];
  const saved = document.documentElement.dataset.nav === 'back' ? (offsets.get(key) ?? 0) : 0;
  el.scrollTo({ top: saved, behavior: 'instant' });
  // Async content (images, a late shelf) can still grow the page by the next frame.
  if (saved) requestAnimationFrame(() => el.scrollTo({ top: saved, behavior: 'instant' }));
  const save = () => offsets.set(key, el.scrollTop);
  el.addEventListener('scroll', save, { passive: true });
  return () => el.removeEventListener('scroll', save);
}
