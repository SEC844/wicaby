// Text subtitles drawn by the app (Android SubtitleView): the server converts every text track to WebVTT
// (lib/device-profile.ts), the app parses it and shows the cue at the playback position. The same on AVPlay and
// <video>, with the Settings look (size, style, colour, position), and an offset for out-of-sync files.
export interface Cue {
  startMs: number;
  endMs: number;
  // Safe HTML: the text escaped, only <i>, <b> and <u> and line breaks kept.
  html: string;
}

function time(s: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toHtml(text: string): string {
  return escape(text.replace(/\{\\[^}]*\}/g, ''))
    // Voice spans, classes and other WebVTT tags go; italics, bold and underline stay.
    .replace(/&lt;(\/?)([ibu])(?:\.[\w.-]+)?&gt;/g, '<$1$2>')
    .replace(/&lt;\/?[^&]*&gt;/g, '')
    .replace(/\n/g, '<br>');
}

// WebVTT (and SRT, which differs only by its header and commas), cues sorted by start.
export function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const startMs = time(a);
    const endMs = time(b);
    const body = lines.slice(at + 1).join('\n').trim();
    if (!isNaN(startMs) && !isNaN(endMs) && body) out.push({ startMs, endMs, html: toHtml(body) });
  }
  return out.sort((x, y) => x.startMs - y.startMs);
}

// The cues showing at [ms] (overlapping cues stack, as in the players).
export function activeCues(cues: Cue[], ms: number): Cue[] {
  // Binary search for the last cue that started, then walk back over the ones still showing.
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startMs <= ms) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: Cue[] = [];
  for (let i = last; i >= 0 && i > last - 8; i--) if (cues[i].endMs > ms) out.unshift(cues[i]);
  return out;
}

export async function loadCues(url: string): Promise<Cue[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseVtt(await res.text());
}
