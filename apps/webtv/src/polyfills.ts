// What the shared renderer uses that Chromium 79 (webOS 6) to 85 (Tizen 6.5) lacks. The build lowers syntax
// (target chrome79); these are the runtime APIs. Each one only when missing.
/* eslint-disable no-extend-native */
type AnyArray = { length: number; [i: number]: unknown };

function define(target: object, name: string, value: unknown): void {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

function at(this: AnyArray, n: number): unknown {
  const i = Math.trunc(n) || 0;
  const k = i < 0 ? this.length + i : i;
  return k < 0 || k >= this.length ? undefined : this[k];
}
define(Array.prototype, 'at', at); // Chrome 92
define(String.prototype, 'at', at);
define(Array.prototype, 'findLastIndex', function (this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => boolean) {
  for (let i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return i;
  return -1;
}); // Chrome 97
define(Array.prototype, 'findLast', function (this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => boolean) {
  for (let i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return this[i];
  return undefined;
});
define(Object, 'hasOwn', (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k)); // Chrome 93
define(String.prototype, 'replaceAll', function (this: string, search: string | RegExp, replace: string) {
  return search instanceof RegExp ? this.replace(search, replace) : this.split(search).join(replace);
}); // Chrome 85
define(Promise, 'any', (list: Iterable<Promise<unknown>>) =>
  new Promise((resolve, reject) => {
    const all = [...list];
    let left = all.length;
    if (!left) reject(new Error('All promises were rejected'));
    for (const p of all) Promise.resolve(p).then(resolve, () => --left === 0 && reject(new Error('All promises were rejected')));
  }),
); // Chrome 85
// Svelte's animate:flip calls it on every removed item (Toasts, Home rows) only to skip one already animating.
define(Element.prototype, 'getAnimations', function () {
  return [];
}); // Chrome 84

// shortcut: Svelte's $state.snapshot clones Dates with it; JSON covers the rest, enough for what the app snapshots.
define(globalThis, 'structuredClone', (v: unknown) => (v instanceof Date ? new Date(v.getTime()) : v === undefined ? v : JSON.parse(JSON.stringify(v)))); // Chrome 98

// The OSD sets the media session's metadata and handlers (lib/media-session.svelte.ts); webOS lacks the API.
if (!('mediaSession' in navigator)) {
  Object.defineProperty(navigator, 'mediaSession', { value: { metadata: null, playbackState: 'none', setActionHandler() {}, setPositionState() {} }, configurable: true });
}
if (typeof (window as { MediaMetadata?: unknown }).MediaMetadata === 'undefined') {
  (window as { MediaMetadata?: unknown }).MediaMetadata = class {
    constructor(init: object) {
      Object.assign(this, init);
    }
  };
}
