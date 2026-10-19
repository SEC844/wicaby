// Short messages at the bottom of the screen (Android Toast.LENGTH_SHORT): one at a time, a new one replaces it.
const SHORT_MS = 2_000;

export const toast = $state<{ text: string | null; key: number }>({ text: null, key: 0 });
let timer = 0;

export function showToast(text: string): void {
  clearTimeout(timer);
  toast.text = text;
  toast.key++;
  timer = window.setTimeout(() => (toast.text = null), SHORT_MS);
}
