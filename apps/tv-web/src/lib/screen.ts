// Screen scale and device class. 1rem = 1 dp of the Android TV layout (960 × 540 dp), so the UI keeps its
// proportions on 720p (1.33 px/rem), 1080p (2 px/rem) and 4K (4 px/rem) viewports. Letterboxed when the viewport
// is not 16:9.
export function applyScale(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const px = Math.min(w / 960, h / 540);
  document.documentElement.style.fontSize = `${px}px`;
}

// Low-end sets (little memory or few cores, typical of 2018-2019 TVs): no transitions or shadows, fewer images kept.
// navigator.deviceMemory (Chromium 63) is missing on older engines, which are low-end anyway.
export const lite: boolean = (() => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 2;
  return memory === undefined ? cores <= 2 : memory <= 1 || cores <= 2;
})();

export function initScreen(): void {
  applyScale();
  window.addEventListener('resize', applyScale);
  if (lite) document.documentElement.setAttribute('data-lite', '');
}

// CSS pixels for a length in dp (1rem), for layout maths (scroll offsets).
export function dp(n: number): number {
  return n * (parseFloat(document.documentElement.style.fontSize) || 2);
}
