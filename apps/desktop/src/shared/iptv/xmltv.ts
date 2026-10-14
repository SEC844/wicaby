// XMLTV guides, parsed as a stream: push() takes text chunks of any size (gunzipped by the caller), only complete
// <channel> and <programme> elements are parsed, and only the programmes of kept channels inside [from, to) are
// handed out, so a guide of hundreds of MB never sits in memory. Pure and erasable TypeScript, no runtime import;
// core/iptv/Xmltv.kt mirrors it (vectors: tools/checks/fixtures/iptv, iptv-check.mjs).

export interface XmltvChannel {
  id: string;
  names: string[];
  icon?: string;
}

export interface XmltvProgramme {
  channel: string;
  start: number;
  stop: number;
  title: string;
  subTitle?: string;
  desc?: string;
  categories?: string[];
  episode?: string;
}

export interface XmltvSink {
  from: number;
  to: number;
  // Called for each <programme> channel id: false drops it before its children are parsed.
  keep(channel: string): boolean;
  channel?(c: XmltvChannel): void;
  programme(p: XmltvProgramme): void;
}

// One element bigger than this is malformed (an unclosed tag): it is skipped, never buffered further.
export const MAX_ELEMENT = 256 * 1024;
const MAX_DESC = 1000;
const MAX_TEXT = 300;

const DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2})|Z|UTC|GMT)?/i;

// "20261014213000 +0200" (XMLTV): no zone means UTC. NaN when malformed.
export function parseXmltvDate(s: string | undefined): number {
  const m = s ? DATE.exec(s.trim()) : null;
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  if (+m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) return NaN;
  const off = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60_000 : 0;
  return utc - off;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&#38;'))
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (all, e: string) => {
      if (e[0] !== '#') return ENT[e.toLowerCase()] ?? all;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3] ?? '');
  return out;
}

// Children <name ...>text</name> of an element body, in order.
function children(body: string, name: string): { a: Record<string, string>; text: string }[] {
  const out: { a: Record<string, string>; text: string }[] = [];
  const re = new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ a: attrs(m[1] ?? ''), text: decodeXml(m[2] ?? '') });
  return out;
}

export class XmltvParser {
  private buf = '';
  private pos = 0;
  channels = 0;
  programmes = 0; // seen
  kept = 0;
  skipped = 0;

  private readonly sink: XmltvSink;

  constructor(sink: XmltvSink) {
    this.sink = sink;
  }

  push(chunk: string): void {
    this.buf = this.pos > 0 ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    this.buf = '';
    this.pos = 0;
  }

  private drain(final: boolean): void {
    const b = this.buf;
    for (;;) {
      const lt = b.indexOf('<', this.pos);
      if (lt < 0) {
        this.pos = b.length;
        return;
      }
      this.pos = lt;
      if (b.startsWith('<!--', lt)) {
        const end = b.indexOf('-->', lt + 4);
        if (end < 0) return this.wait(final, lt);
        this.pos = end + 3;
        continue;
      }
      const name = /^<(channel|programme)[\s>/]/.exec(b.slice(lt, lt + 12))?.[1];
      if (!name) {
        // <?xml?>, <!DOCTYPE>, <tv>, </tv> and stray text: skip the tag.
        const gt = b.indexOf('>', lt + 1);
        if (gt < 0) return this.wait(final, lt);
        this.pos = gt + 1;
        continue;
      }
      const openEnd = b.indexOf('>', lt + 1);
      if (openEnd < 0) return this.wait(final, lt);
      const selfClosing = b[openEnd - 1] === '/';
      const head = b.slice(lt + name.length + 1, selfClosing ? openEnd - 1 : openEnd);
      let bodyEnd = openEnd + 1;
      let next = openEnd + 1;
      if (!selfClosing) {
        const close = b.indexOf(`</${name}>`, openEnd + 1);
        if (close < 0) return this.wait(final, lt);
        bodyEnd = close;
        next = close + name.length + 3;
      }
      if (next - lt > MAX_ELEMENT) this.skipped++;
      else if (name === 'channel') this.onChannel(head, b.slice(openEnd + 1, bodyEnd));
      else this.onProgramme(head, b.slice(openEnd + 1, bodyEnd));
      this.pos = next;
    }
  }

  // An element cut by the chunk boundary waits for the next chunk, unless it is already too long (malformed).
  private wait(final: boolean, at: number): void {
    if (final || this.buf.length - at > MAX_ELEMENT) {
      this.skipped++;
      const gt = this.buf.indexOf('>', at + 1);
      this.pos = gt < 0 ? this.buf.length : gt + 1;
      this.drain(final);
      return;
    }
    this.pos = at;
  }

  private onChannel(head: string, body: string): void {
    const id = attrs(head).id;
    if (!id) return void this.skipped++;
    this.channels++;
    const names = children(body, 'display-name')
      .map((c) => c.text.slice(0, MAX_TEXT))
      .filter(Boolean);
    const icon = children(body, 'icon')[0]?.a.src;
    this.sink.channel?.(icon ? { id, names, icon } : { id, names });
  }

  private onProgramme(head: string, body: string): void {
    this.programmes++;
    const a = attrs(head);
    const channel = a.channel;
    if (!channel) return void this.skipped++;
    const start = parseXmltvDate(a.start);
    // A programme without a stop runs 30 min (rare; the next one usually starts then).
    const stop = a.stop ? parseXmltvDate(a.stop) : start + 30 * 60_000;
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return void this.skipped++;
    if (stop <= this.sink.from || start >= this.sink.to || !this.sink.keep(channel)) return;
    const p: XmltvProgramme = { channel, start, stop, title: (children(body, 'title')[0]?.text ?? '').slice(0, MAX_TEXT) };
    const sub = children(body, 'sub-title')[0]?.text;
    if (sub) p.subTitle = sub.slice(0, MAX_TEXT);
    const desc = children(body, 'desc')[0]?.text;
    if (desc) p.desc = desc.slice(0, MAX_DESC);
    const cats = children(body, 'category')
      .map((c) => c.text.slice(0, 60))
      .filter(Boolean)
      .slice(0, 6);
    if (cats.length) p.categories = cats;
    const eps = children(body, 'episode-num');
    const ep = eps.find((e) => e.a.system === 'onscreen')?.text ?? xmltvNs(eps.find((e) => e.a.system === 'xmltv_ns')?.text);
    if (ep) p.episode = ep.slice(0, 40);
    this.kept++;
    this.sink.programme(p);
  }
}

// "1.4.0/1" (zero-based season.episode.part) → "S2E5".
function xmltvNs(s: string | undefined): string | undefined {
  const m = s ? /^\s*(\d+)?\s*(?:\/\s*\d+)?\s*\.\s*(\d+)?/.exec(s) : null;
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  return `${m[1] !== undefined ? `S${+m[1] + 1}` : ''}${m[2] !== undefined ? `E${+m[2] + 1}` : ''}`;
}
