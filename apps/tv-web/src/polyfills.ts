// APIs newer than Chromium 69 (Tizen 5.5, webOS 5) that the app or the Svelte runtime call. Syntax is lowered by the
// build (vite.config.ts ENGINE); only runtime gaps are filled here, each guarded so newer engines keep their own.
/* eslint-disable no-extend-native */

const g = (typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window) as typeof globalThis;
if (typeof globalThis === 'undefined') (g as unknown as { globalThis: unknown }).globalThis = g; // Chrome 71

if (!g.queueMicrotask) {
  // Chrome 71
  const resolved = Promise.resolve();
  g.queueMicrotask = (fn: () => void) => {
    resolved.then(fn).catch((e) => setTimeout(() => { throw e; }));
  };
}

if (!Object.fromEntries) {
  // Chrome 73
  Object.fromEntries = <T>(entries: Iterable<readonly [PropertyKey, T]>) => {
    const out: Record<PropertyKey, T> = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  };
}

if (!Promise.allSettled) {
  // Chrome 76
  Promise.allSettled = <T>(values: Iterable<T | PromiseLike<T>>) =>
    Promise.all(
      Array.from(values, (v) =>
        Promise.resolve(v).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
      ),
    ) as never;
}

if (!String.prototype.replaceAll) {
  // Chrome 85
  String.prototype.replaceAll = function (this: string, search: string | RegExp, replace: never) {
    if (search instanceof RegExp) return this.replace(search, replace);
    return this.split(search).join(replace);
  } as never;
}

if (!Array.prototype.at) {
  // Chrome 92
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value(this: unknown[], i: number) {
      const n = Math.trunc(i) || 0;
      return this[n < 0 ? this.length + n : n];
    },
  });
}

if (!Object.hasOwn) {
  // Chrome 93
  Object.hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
}

if (!g.structuredClone) {
  // Chrome 98: only plain data goes through it here (settings, server responses).
  g.structuredClone = (<T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))) as never;
}
