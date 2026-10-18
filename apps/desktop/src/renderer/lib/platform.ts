// Set by main in every window's URL (window-manager.ts url()). Read from the URL, not html.linux:
// modules load before main.ts adds that class.
export const linux = new URLSearchParams(location.search).get('linux') === '1';
export const windows = new URLSearchParams(location.search).get('win') === '1';
// The web TV app (apps/webtv: webOS, Tizen, the browser demo): its Vite build defines VITE_WICABY_WEB, the desktop's
// does not. Hides what needs the desktop's main process (downloads, torrents, VPN, cast, file sources, IPTV, admin).
export const web = import.meta.env.VITE_WICABY_WEB === '1';
