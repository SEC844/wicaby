// Folder shapes (file-sources-spec §4.3), display only: the card type of a folder from its name and its
// children. Ids and storage never change. Pure; the routes check drives it on the fixture tree.
import { isVideoName, parseName } from './names';

export type FolderShape = 'Series' | 'Season' | 'Movie' | 'Folder';

// "Season 2", "Saison 2", "S02".
const SEASON = /^(?:(?:season|saison)[\s._-]*(\d{1,3})|s(\d{1,3}))$/i;
// Extras next to a film: Example-trailer.mkv, Example.sample.mkv…
const EXTRA = /[-._ ](trailer|sample|featurette|behindthescenes|deleted|deletedscene|interview|scene|short|extra)$/i;

export function seasonNumber(folderName: string): number | undefined {
  const m = SEASON.exec(folderName.trim());
  return m ? Number(m[1] ?? m[2]) : undefined;
}

// children: the folder's entries without the hidden ones. film: the video a film folder opens.
export function folderShape<T extends { name: string; dir: boolean }>(name: string, children: T[]): { shape: FolderShape; film?: T } {
  if (seasonNumber(name) !== undefined) return { shape: 'Season' };
  if (children.some((c) => (!c.dir && c.name.toLowerCase() === 'tvshow.nfo') || (c.dir && seasonNumber(c.name) !== undefined))) return { shape: 'Series' };
  const mains = children.filter((c) => !c.dir && isVideoName(c.name) && !EXTRA.test(c.name.slice(0, c.name.lastIndexOf('.'))));
  // One video (an episode alone is not a film), extras and a movie.nfo allowed.
  if (mains.length === 1 && parseName(mains[0].name).episode === undefined) return { shape: 'Movie', film: mains[0] };
  return { shape: 'Folder' };
}

// Default order of the files in a folder: episodes by season and number, then the rest by name (the caller
// breaks ties with the natural sort).
export function episodeOrder(a: string, b: string): number {
  const pa = parseName(a);
  const pb = parseName(b);
  const ea = pa.episode !== undefined;
  const eb = pb.episode !== undefined;
  if (ea !== eb) return ea ? -1 : 1;
  if (!ea) return 0;
  return (pa.season ?? 0) - (pb.season ?? 0) || pa.episode! - pb.episode!;
}

// Default order of the folders: seasons first, by number.
export function seasonOrder(a: string, b: string): number {
  const sa = seasonNumber(a);
  const sb = seasonNumber(b);
  if ((sa === undefined) !== (sb === undefined)) return sa === undefined ? 1 : -1;
  return (sa ?? 0) - (sb ?? 0);
}
