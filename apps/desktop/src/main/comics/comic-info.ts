// ComicInfo.xml (ComicRack / Anansi schema): only the fields the reader acts on.
// A regex read is enough for this flat format and keeps main free of an XML dependency.
export interface ComicMeta {
  title?: string;
  series?: string;
  number?: string;
  manga?: boolean;
  webtoon?: boolean;
}

export interface ComicInfoPage {
  image: number;
  deleted: boolean;
  double: boolean;
  width?: number;
  height?: number;
}

const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCharCode(Number(e.slice(1))),
  );

function field(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  const v = m ? decode(m[1]).trim() : '';
  return v || undefined;
}

// Real ComicInfo.xml files are a few KB; the cap bounds the regex work on a hostile archive.
export const MAX_COMIC_INFO = 1024 * 1024;

export function parseComicInfo(xml: string): { meta: ComicMeta; pages: ComicInfoPage[] } {
  xml = xml.slice(0, MAX_COMIC_INFO);
  const manga = field(xml, 'Manga');
  const meta: ComicMeta = {
    title: field(xml, 'Title'),
    series: field(xml, 'Series'),
    number: field(xml, 'Number'),
    manga: manga === undefined ? undefined : manga === 'YesAndRightToLeft',
    webtoon: field(xml, 'Format')?.toLowerCase() === 'web' || undefined,
  };
  const pages: ComicInfoPage[] = [];
  // [^<>]: a '<' ends the attempt, so an unclosed '<Page' cannot rescan the rest of the file (quadratic).
  for (const m of xml.matchAll(/<Page\b([^<>]*)\/?>/gi)) {
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(m[1])?.[1];
    const image = Number(attr('Image'));
    if (!Number.isInteger(image)) continue;
    pages.push({
      image,
      deleted: attr('Type')?.toLowerCase() === 'deleted' || attr('Type')?.toLowerCase() === 'delete',
      double: attr('DoublePage')?.toLowerCase() === 'true',
      width: Number(attr('ImageWidth')) || undefined,
      height: Number(attr('ImageHeight')) || undefined,
    });
  }
  return { meta, pages };
}
