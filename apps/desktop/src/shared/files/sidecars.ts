// Sidecar files of a video or folder (file-sources-spec §4.2): posters, backdrops, NFO and subtitles,
// matched case-insensitively against the names of the same folder. Pure; vectors in
// tools/checks/fixtures/files/sidecars.json.
import { extOf, isVideoName } from './names';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const SUB_EXTS = ['srt', 'ass', 'ssa', 'vtt', 'sub'];

export interface SidecarSubtitle {
  name: string;
  language?: string;
  forced: boolean;
  hearingImpaired: boolean;
  codec: string;
}

export interface Sidecars {
  poster?: string;
  backdrop?: string;
  nfo?: string;
  subtitles: SidecarSubtitle[];
}

const stem = (name: string): string => {
  const ext = extOf(name);
  return ext ? name.slice(0, -(ext.length + 1)) : name;
};

// The first name that is <one of bases>.<image ext>, in the order of bases.
function image(names: string[], bases: string[]): string | undefined {
  for (const b of bases) {
    const hit = names.find((n) => stem(n).toLowerCase() === b.toLowerCase() && IMAGE_EXTS.includes(extOf(n)));
    if (hit) return hit;
  }
  return undefined;
}

export function folderSidecars(names: string[]): Omit<Sidecars, 'subtitles'> {
  const nfo = names.find((n) => n.toLowerCase() === 'tvshow.nfo') ?? (names.filter(isVideoName).length === 1 ? names.find((n) => n.toLowerCase() === 'movie.nfo') : undefined);
  return { poster: image(names, ['poster', 'folder', 'cover']), backdrop: image(names, ['fanart', 'backdrop']), nfo };
}

// names: every entry of the video's folder, files only.
export function videoSidecars(video: string, names: string[]): Sidecars {
  const base = stem(video);
  const lower = base.toLowerCase();
  const folder = folderSidecars(names);
  const subtitles: SidecarSubtitle[] = [];
  for (const n of names) {
    const ext = extOf(n);
    if (!SUB_EXTS.includes(ext)) continue;
    const s = stem(n);
    if (s.toLowerCase() !== lower && !s.toLowerCase().startsWith(`${lower}.`)) continue;
    // <base>[.<lang>][.forced|.sdh|.cc]: tags after the base, in any order.
    const tags = s.slice(base.length).split('.').filter(Boolean).map((x) => x.toLowerCase());
    const sub: SidecarSubtitle = { name: n, forced: tags.includes('forced'), hearingImpaired: tags.includes('sdh') || tags.includes('cc'), codec: ext };
    const lang = tags.find((x) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(x) && !['sdh', 'cc'].includes(x));
    if (lang) sub.language = lang;
    subtitles.push(sub);
  }
  subtitles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    poster: image(names, [`${base}-poster`, base]) ?? folder.poster,
    backdrop: image(names, [`${base}-fanart`]) ?? folder.backdrop,
    nfo: names.find((n) => n.toLowerCase() === `${lower}.nfo`) ?? (names.filter(isVideoName).length === 1 ? names.find((n) => n.toLowerCase() === 'movie.nfo') : undefined),
    subtitles,
  };
}

// Names that only serve as sidecars and never show in a listing.
export const isSidecarName = (name: string): boolean => [...IMAGE_EXTS, ...SUB_EXTS, 'nfo'].includes(extOf(name));
