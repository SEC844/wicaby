// Path parameters of the hash router (router.svelte.ts). They come from the URL, which a
// jump list entry, a wicaby:// link or a page link can set, and end up in server API paths:
// only plain ids are accepted. Dependency-free so tools/checks/desktop-hardening-check.mjs runs it.

// Item, library, section and user ids: Emby numbers, Jellyfin hex, GUIDs with dashes; file source ids
// ('p.' + base64url of a guarded path, shared/files/ids.ts FILES_ID; repeated here to stay dependency-free).
const ID = /^[A-Za-z0-9-]{1,64}$/;
const FILES_ID = /^p\.[A-Za-z0-9_-]{0,1000}$/;
// Server ids are the server's SystemId: hex with or without dashes on both servers.
const SERVER_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isRouteId(value: string): boolean {
  return ID.test(value) || FILES_ID.test(value);
}

export function isServerId(value: string): boolean {
  return SERVER_ID.test(value);
}

// Decoded params, or null when one of them is malformed and the route must be refused.
// /name/:id, or /name/:server/:id.
export function parseRouteParams(parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  try {
    if (parts.length >= 3) {
      params.server = decodeURIComponent(parts[1]);
      params.id = decodeURIComponent(parts[2]);
    } else if (parts[1]) params.id = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (parts.length > 3) return null;
  if (params.server !== undefined && !isServerId(params.server)) return null;
  // /login/:id carries a server id.
  if (params.id !== undefined && !(parts[0] === 'login' ? isServerId(params.id) : isRouteId(params.id))) return null;
  return params;
}
