// Which playlist channels an XMLTV channel feeds: tvg-id first (case-insensitive, duplicates share the guide), then,
// for playlist channels without a tvg-id only, a <display-name> equal to the tvg-name or the name (case and accents
// folded). Pure and erasable TypeScript; core/iptv/GuideMatch.kt mirrors it.
import type { IptvChannel } from './m3u';
import { XmltvParser } from './xmltv';
import type { XmltvChannel, XmltvProgramme } from './xmltv';

export const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export class GuideMatcher {
  private byTvg = new Map<string, string[]>();
  private byName = new Map<string, string[]>();
  private named = new Map<string, string[]>();

  constructor(channels: readonly IptvChannel[]) {
    const add = (m: Map<string, string[]>, k: string, id: string): void => {
      if (!k) return;
      const l = m.get(k);
      if (l) {
        if (!l.includes(id)) l.push(id);
      } else m.set(k, [id]);
    };
    for (const c of channels) {
      if (c.tvgId) add(this.byTvg, c.tvgId.toLowerCase(), c.id);
      else {
        add(this.byName, fold(c.name), c.id);
        if (c.tvgName) add(this.byName, fold(c.tvgName), c.id);
      }
    }
  }

  // A <channel> element: its display names may feed playlist channels without a tvg-id.
  channel(c: XmltvChannel): void {
    const ids: string[] = [];
    for (const n of c.names) for (const id of this.byName.get(fold(n)) ?? []) if (!ids.includes(id)) ids.push(id);
    if (ids.length) this.named.set(c.id.toLowerCase(), ids);
  }

  targets(xmltvId: string): string[] {
    const k = xmltvId.toLowerCase();
    const a = this.byTvg.get(k);
    const b = this.named.get(k);
    return a && b ? [...a, ...b.filter((x) => !a.includes(x))] : (a ?? b ?? []);
  }
}

// Past this many programmes the rest of the guide is dropped (about 100 MB of JSON): a guide this big is a whole
// country's provider guide, far beyond what the playlist's channels need.
export const MAX_PROGRAMMES = 400_000;

export type GuideProgramme = Omit<XmltvProgramme, 'channel'>;

// A parser feeding the playlist's channels: per playlist channel id, its programmes in [from, to), sorted by start,
// an overlap clipped off the later one (a duplicate goes).
export function collectGuide(channels: readonly IptvChannel[], from: number, to: number, max = MAX_PROGRAMMES): { parser: XmltvParser; finish(): Map<string, GuideProgramme[]>; count(): number } {
  const match = new GuideMatcher(channels);
  const out = new Map<string, GuideProgramme[]>();
  const cache = new Map<string, string[]>();
  let n = 0;
  const targets = (id: string): string[] => {
    let t = cache.get(id);
    if (!t) cache.set(id, (t = match.targets(id)));
    return t;
  };
  const parser = new XmltvParser({
    from,
    to,
    keep: (id) => n < max && targets(id).length > 0,
    channel: (c) => {
      match.channel(c);
      cache.delete(c.id);
    },
    programme: (p) => {
      const { channel, ...rest } = p;
      for (const id of targets(channel)) {
        let l = out.get(id);
        if (!l) out.set(id, (l = []));
        l.push(rest);
        n++;
      }
    },
  });
  return {
    parser,
    count: () => n,
    finish() {
      parser.end();
      for (const [id, l] of out) {
        l.sort((a, b) => a.start - b.start || a.stop - b.stop);
        const kept: GuideProgramme[] = [];
        for (const p of l) {
          const last = kept[kept.length - 1];
          if (!last || p.start >= last.stop) kept.push(p);
          else if (p.stop > last.stop) kept.push({ ...p, start: last.stop });
        }
        out.set(id, kept);
      }
      return out;
    },
  };
}
