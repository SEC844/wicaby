// What a file name says when there is no NFO (file-sources-spec §4.2): title, year, season and episode.
// Pure; vectors in tools/checks/fixtures/files/names.json.

export const VIDEO_EXTS = ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'wmv', 'ts', 'm2ts', 'mts', 'webm', 'mpg', 'mpeg', 'ogv', 'flv'];

export interface ParsedName {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  // A dated episode (daily shows): YYYY-MM-DD.
  date?: string;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const isVideoName = (name: string): boolean => VIDEO_EXTS.includes(extOf(name));

// Release tags: everything from the first one on is cut from a title.
const TAG =
  /^(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr|hdr10|dv|dovi|bluray|blu-ray|bdrip|brrip|bdremux|remux|web|web-dl|webdl|webrip|hdtv|dvdrip|dvd|hdrip|x264|x265|h264|h265|h\.264|h\.265|hevc|avc|xvid|divx|aac|ac3|eac3|dts|dts-hd|truehd|atmos|flac|10bit|8bit|proper|repack|extended|unrated|remastered|internal|multi|vff|vfq|vostfr|truefrench|french|subbed|dubbed)$/i;

function clean(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–[(]+|[\s\-–[(]+$/g, '')
    .trim();
}

// The words before the first release tag, and the '-GROUP' suffix off.
function untag(s: string): string {
  const words = s.replace(/[._]+/g, ' ').split(/\s+/).filter(Boolean);
  const isTag = (w: string) => {
    const x = w.replace(/^[[(]+|[\])]+$/g, '');
    return TAG.test(x) || TAG.test(x.replace(/-[A-Za-z0-9]+$/, ''));
  };
  const cut = words.findIndex(isTag);
  return (cut < 0 ? words : words.slice(0, cut)).join(' ');
}

export function parseName(fileName: string): ParsedName {
  const ext = extOf(fileName);
  const base = ext && (VIDEO_EXTS.includes(ext) || ext.length <= 4) ? fileName.slice(0, -(ext.length + 1)) : fileName;

  // [Group] Show - 03 [1080p]
  const anime = /^\[[^\]]+\]\s*(.+?)\s+-\s+(\d{1,4})(?:v\d)?(?:\s*[[(].*)?$/.exec(base);
  if (anime) return { title: clean(anime[1]), episode: Number(anime[2]) };

  const sxe = /(?:^|[\s._\-[(])[Ss](\d{1,2})[\s._-]?[Ee](\d{1,3})(?:[\s._]?-?[\s._]?[Ee]?(\d{1,3}))?(?![\dp])/.exec(base);
  if (sxe) {
    const out: ParsedName = { title: clean(untag(base.slice(0, sxe.index))), season: Number(sxe[1]), episode: Number(sxe[2]) };
    if (sxe[3] && Number(sxe[3]) > out.episode!) out.episodeEnd = Number(sxe[3]);
    return withYear(out);
  }
  const nx = /(?:^|[\s._\-[(])(\d{1,2})x(\d{2,3})(?![\dp])/.exec(base);
  if (nx) return withYear({ title: clean(untag(base.slice(0, nx.index))), season: Number(nx[1]), episode: Number(nx[2]) });
  const dated = /(?:^|[\s._\-[(])((?:19|20)\d{2})[.\-_ ](0[1-9]|1[0-2])[.\-_ ](0[1-9]|[12]\d|3[01])(?!\d)/.exec(base);
  if (dated) return { title: clean(untag(base.slice(0, dated.index))), date: `${dated[1]}-${dated[2]}-${dated[3]}` };

  // A film: the last year before the tags, not at the very start (1917.2019 is "1917" of 2019).
  const head = untag(base);
  let year: number | undefined;
  let title = head;
  const years = [...head.matchAll(/(?:^|[\s._\-[(])((?:19|20)\d{2})(?=$|[\s._\-\])])/g)].filter((m) => m.index! + m[0].indexOf(m[1]) > 0);
  const last = years.at(-1);
  if (last) {
    year = Number(last[1]);
    title = head.slice(0, last.index! + last[0].indexOf(last[1]));
  }
  title = clean(title) || clean(head) || clean(base);
  return year ? { title, year } : { title };
}

// A show folder named 'Show (2019)' or a title ending in a year keeps the year apart.
function withYear(p: ParsedName): ParsedName {
  const m = /^(.+?)\s*\(?((?:19|20)\d{2})\)?$/.exec(p.title);
  return m ? { ...p, title: m[1].trim(), year: Number(m[2]) } : p;
}

// "S1:E2" (or "S1:E2-E3"); '' when the name has no episode.
export function episodeLabel(p: ParsedName): string {
  if (p.date) return p.date;
  if (p.episode === undefined) return '';
  const ep = p.episodeEnd ? `E${p.episode}-E${p.episodeEnd}` : `E${p.episode}`;
  return p.season === undefined ? ep : `S${p.season}:${ep}`;
}
