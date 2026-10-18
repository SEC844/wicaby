// Remote focus events (src/lib/focus.ts), usable as on… attributes in markup. A module file: augmentation, not an
// ambient redeclaration of svelte/elements.
import 'svelte/elements';

declare module 'svelte/elements' {
  export interface HTMLAttributes<T> {
    ontvfocus?: (e: CustomEvent) => void;
    ontvmove?: (e: CustomEvent<'up' | 'down' | 'left' | 'right'>) => void;
    ontvlongpress?: (e: CustomEvent) => void;
  }
}
