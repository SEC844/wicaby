// APIs newer than Chromium 53 (LG webOS 4, the oldest supported engine; Tizen 4 runs 56) that the app or the Svelte
// runtime call. Syntax is lowered by the build (vite.config.ts ENGINE); only runtime gaps are filled here, each one
// guarded so newer engines keep their native version. The comment on each is the Chromium version that added it.
/* eslint-disable no-extend-native */

const g = (typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window) as typeof globalThis;
if (typeof globalThis === 'undefined') (g as unknown as { globalThis: unknown }).globalThis = g; // 71

function define(proto: object, name: string, value: unknown): void {
  if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, writable: true, value });
}

// --- Objects, strings, arrays ---

define(Object, 'values', (o: object) => Object.keys(o).map((k) => (o as Record<string, unknown>)[k])); // 54
define(Object, 'entries', (o: object) => Object.keys(o).map((k) => [k, (o as Record<string, unknown>)[k]])); // 54
define(Object, 'fromEntries', <T>(entries: Iterable<readonly [PropertyKey, T]>) => { // 73
  const out: Record<PropertyKey, T> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
});
define(Object, 'hasOwn', (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k)); // 93

function pad(this: string, start: boolean, length: number, fill = ' '): string {
  const s = String(this);
  if (s.length >= length || !fill) return s;
  const need = length - s.length;
  const padding = fill.repeat(Math.ceil(need / fill.length)).slice(0, need);
  return start ? padding + s : s + padding;
}
define(String.prototype, 'padStart', function (this: string, n: number, f?: string) { return pad.call(this, true, n, f); }); // 57
define(String.prototype, 'padEnd', function (this: string, n: number, f?: string) { return pad.call(this, false, n, f); }); // 57
define(String.prototype, 'trimStart', function (this: string) { return this.replace(/^\s+/, ''); }); // 66
define(String.prototype, 'trimEnd', function (this: string) { return this.replace(/\s+$/, ''); }); // 66
define(String.prototype, 'replaceAll', function (this: string, search: string | RegExp, replace: string) { // 85
  return search instanceof RegExp ? this.replace(search, replace) : this.split(search).join(replace);
});

define(Array.prototype, 'flat', function flat(this: unknown[], depth = 1): unknown[] { // 69
  return depth < 1 ? this.slice() : this.reduce<unknown[]>((acc, v) => acc.concat(Array.isArray(v) ? flat.call(v, depth - 1) : [v]), []);
});
define(Array.prototype, 'flatMap', function (this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => unknown, thisArg?: unknown) { // 69
  return (this.map(fn, thisArg) as unknown[]).reduce<unknown[]>((acc, v) => acc.concat(v), []);
});
define(Array.prototype, 'at', function (this: unknown[], i: number) { // 92
  const n = Math.trunc(i) || 0;
  return this[n < 0 ? this.length + n : n];
});

// --- Promises and scheduling ---

define(Promise.prototype, 'finally', function (this: Promise<unknown>, fn: () => void) { // 63
  return this.then(
    (v) => Promise.resolve(fn()).then(() => v),
    (e) => Promise.resolve(fn()).then(() => { throw e; }),
  );
});
define(Promise, 'allSettled', <T>(values: Iterable<T | PromiseLike<T>>) => // 76
  Promise.all(Array.from(values, (v) => Promise.resolve(v).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  ))));

if (!g.queueMicrotask) { // 71
  const resolved = Promise.resolve();
  g.queueMicrotask = (fn: () => void) => { resolved.then(fn).catch((e) => setTimeout(() => { throw e; })); };
}

// Plain data only here (settings, server responses).
if (!g.structuredClone) g.structuredClone = (<T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))) as never; // 98

// AbortController (66): the API surface for callers; fetch() before 66 ignores the signal, so lib/http.ts also races
// the request against the signal's abort event.
if (!g.AbortController) {
  class Signal extends EventTarget {
    aborted = false;
    reason: unknown = undefined;
    onabort: ((e: Event) => void) | null = null;
    throwIfAborted(): void { if (this.aborted) throw this.reason; }
  }
  class Controller {
    readonly signal = new Signal();
    abort(reason: unknown = new DOMException('Aborted', 'AbortError')): void {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      const e = new Event('abort');
      this.signal.onabort?.(e);
      this.signal.dispatchEvent(e);
    }
  }
  g.AbortController = Controller as never;
}

// --- DOM (ChildNode / ParentNode, 54), used by the Svelte runtime ---

function toNode(nodes: (Node | string)[]): Node {
  if (nodes.length === 1 && typeof nodes[0] !== 'string') return nodes[0];
  const f = document.createDocumentFragment();
  for (const n of nodes) f.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
  return f;
}
for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
  define(proto, 'before', function (this: ChildNode, ...nodes: (Node | string)[]) {
    this.parentNode?.insertBefore(toNode(nodes), this);
  });
  define(proto, 'after', function (this: ChildNode, ...nodes: (Node | string)[]) {
    this.parentNode?.insertBefore(toNode(nodes), this.nextSibling);
  });
  define(proto, 'replaceWith', function (this: ChildNode, ...nodes: (Node | string)[]) {
    this.parentNode?.replaceChild(toNode(nodes), this);
  });
}
for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  define(proto, 'append', function (this: ParentNode & Node, ...nodes: (Node | string)[]) {
    this.appendChild(toNode(nodes));
  });
  define(proto, 'prepend', function (this: ParentNode & Node, ...nodes: (Node | string)[]) {
    this.insertBefore(toNode(nodes), this.firstChild);
  });
}
define(Element.prototype, 'toggleAttribute', function (this: Element, name: string, force?: boolean) { // 69
  const on = force ?? !this.hasAttribute(name);
  if (on) this.setAttribute(name, '');
  else this.removeAttribute(name);
  return on;
});
