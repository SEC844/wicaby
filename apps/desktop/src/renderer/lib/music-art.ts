// Music covers in the renderer (music-feishin-navidrome spec §4.A): the shared rule (shared/music-art.ts) with the
// lookups through each item's server, sized from buckets (MU-A5), the name-coloured placeholder (MU-A4) and the
// dominant colour of a loaded cover (MU-A3).
import { coverResolver, dominantColour, initials, lookupQuery, musicArt, musicSize, nameHue, PLACEHOLDER_L, PLACEHOLDER_S, type ArtRef } from '../../shared/music-art';
import type { BaseItem } from '../../shared/models';
import { apiFor } from './api';
import { imageUrl } from './images';
import { sessionFor } from './stores.svelte';

// Items whose card shows the music cover rule and placeholder.
export const MUSIC_TYPES = new Set(['MusicAlbum', 'MusicArtist', 'Audio', 'MusicGenre']);
export const isMusicItem = (item: BaseItem) => MUSIC_TYPES.has(item.Type) || (item.Type === 'Playlist' && item.MediaType === 'Audio');

const resolver = coverResolver((kind, item) =>
  apiFor(item.ServerId)
    .items(lookupQuery(kind, item.Id, sessionFor(item.ServerId)?.server.kind !== 'jellyfin'))
    .then((r) => r.Items[0]),
);

export function artUrl(ref: ArtRef, server: string | undefined, cssPx: number): string | null {
  return imageUrl(ref.id, 'Primary', { tag: ref.tag, px: musicSize(cssPx, devicePixelRatio), server }) || null;
}

// The cover the item carries (its own, a track's album), null when there is none or a lookup is needed first.
export function musicArtNow(item: BaseItem, cssPx: number): string | null {
  const plan = musicArt(item);
  return plan && 'ref' in plan ? artUrl(plan.ref, item.ServerId, cssPx) : null;
}

export const needsLookup = (item: BaseItem): boolean => {
  const plan = musicArt(item);
  return Boolean(plan && 'lookup' in plan);
};

// An album's first track cover, an artist's first album cover (cached per item for the session).
export async function musicArtLater(item: BaseItem, cssPx: number): Promise<string | null> {
  const ref = await resolver.resolve(item);
  return ref ? artUrl(ref, item.ServerId, cssPx) : null;
}

// Runs [f] once [el] comes near the viewport (lookups only for visible cards). Returns the cancel.
export function whenVisible(el: Element, f: () => void): () => void {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      f();
    },
    { rootMargin: '300px' },
  );
  io.observe(el);
  return () => io.disconnect();
}

export const placeholderBg = (name: string) => `hsl(${nameHue(name)} ${PLACEHOLDER_S * 100}% ${PLACEHOLDER_L * 100}%)`;
export { initials };

// Dominant colour of a cover (16 × 16 canvas), '#rrggbb' or null; cached by URL. wicaby-media:// answers
// Access-Control-Allow-Origin: *, so the canvas stays readable with crossOrigin = 'anonymous'.
const colours = new Map<string, Promise<string | null>>();
export function artColour(url: string): Promise<string | null> {
  let p = colours.get(url);
  if (!p) {
    p = new Promise<string | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 16;
          const g = c.getContext('2d', { willReadFrequently: true });
          g?.drawImage(img, 0, 0, 16, 16);
          resolve(g ? dominantColour(g.getImageData(0, 0, 16, 16).data) : null);
        } catch {
          resolve(null); // a tainted canvas: no colour
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    colours.set(url, p);
    if (colours.size > 500) colours.delete(colours.keys().next().value!);
  }
  return p;
}

// The full-screen player's art: up to 75 % of the window height (MU-A5), in device pixels.
export const fullArtPx = () => musicSize(Math.min(innerHeight * 0.75, 1200), devicePixelRatio);

// Warms the image cache with the next track's covers at the sizes the bar, the full-screen player and its background
// ask for (MU-A5). Its art as main's playback model picks it: the album's, else the track's own.
export function prefetchTrackArt(n: BaseItem | undefined): void {
  if (!n) return;
  const [id, tag] = n.AlbumId && n.AlbumPrimaryImageTag ? [n.AlbumId, n.AlbumPrimaryImageTag] : [n.Id, n.ImageTags?.Primary];
  if (!tag) return;
  for (const size of [{ maxHeight: 96 }, { maxHeight: 64 }, { px: fullArtPx() }]) {
    const url = imageUrl(id, 'Primary', { tag, server: n.ServerId, ...size });
    if (url) new Image().src = url;
  }
}
