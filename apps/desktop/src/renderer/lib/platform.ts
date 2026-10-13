// Set by main in every window's URL (window-manager.ts url()). Read from the URL, not html.linux:
// modules load before main.ts adds that class.
export const linux = new URLSearchParams(location.search).get('linux') === '1';
