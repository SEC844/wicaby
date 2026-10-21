// App updates through the service worker (src/sw.ts). A new version installs in the background; the app then offers
// to reload into it (components/UpdateBanner.svelte) instead of swapping code under a page the user is on.
// iOS keeps a Home Screen app alive for days: it also checks when the app comes back to the front.
export const updates = $state<{ ready: boolean }>({ ready: false });

let registration: ServiceWorkerRegistration | null = null;

export function initUpdates(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    registration = reg;
    // A worker already waiting from an earlier visit, then any new one.
    if (reg.waiting && navigator.serviceWorker.controller) updates.ready = true;
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) updates.ready = true;
      });
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
  });
}

export function applyUpdate(): void {
  registration?.waiting?.postMessage('skip-waiting');
}
