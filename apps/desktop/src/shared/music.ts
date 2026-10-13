// Music model shared by main and the renderer (music-spec MU-01): the LRC parser and duration text.
// The Kotlin twin is core/music/Lrc.kt; both run tools/checks/fixtures/music/lrc-cases.json.

export interface LyricLine {
  // Absent for plain (unsynced) lyrics.
  startMs?: number;
  text: string;
}

export interface Lyrics {
  synced: boolean;
  lines: LyricLine[];
}

const STAMP = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const TAG = /^\[([A-Za-z#]+):(.*)\]$/;
const WORD = /<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g;

// LRC: [mm:ss], [mm:ss.xx] and [mm:ss.xxx] stamps, several per line; [offset:±ms] (positive = earlier); other
// tags (ar, ti, al, length…) ignored; enhanced <mm:ss.xx> word stamps stripped; blank stamped lines kept as
// instrumental gaps; lines sorted by time (stable); BOM and CRLF tolerated. No stamp at all: plain lyrics.
export function parseLrc(text: string): Lyrics {
  let offset = 0;
  const timed: LyricLine[] = [];
  const plain: string[] = [];
  for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
    let line = raw.trim();
    const tag = TAG.exec(line);
    if (tag) {
      if (tag[1].toLowerCase() === 'offset') offset = Number.parseInt(tag[2].trim(), 10) || 0;
      continue;
    }
    const starts: number[] = [];
    for (let m = STAMP.exec(line); m; m = STAMP.exec(line)) {
      const frac = m[3] ?? '';
      starts.push((Number(m[1]) * 60 + Number(m[2])) * 1000 + (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0));
      line = line.slice(m[0].length);
    }
    const words = line.replace(WORD, '').replace(/\s+/g, ' ').trim();
    if (starts.length) for (const s of starts) timed.push({ startMs: s, text: words });
    else plain.push(words);
  }
  if (!timed.length) {
    // Leading and trailing blank lines carry nothing; inner ones separate verses.
    while (plain.length && !plain[0]) plain.shift();
    while (plain.length && !plain[plain.length - 1]) plain.pop();
    return { synced: false, lines: plain.map((t) => ({ text: t })) };
  }
  for (const l of timed) l.startMs = Math.max(0, l.startMs! - offset);
  // Array.prototype.sort is stable: lines with the same time keep their file order.
  timed.sort((a, b) => a.startMs! - b.startMs!);
  return { synced: true, lines: timed };
}

// "3:07", "1:02:03".
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Jellyfin 10.9+ /Audio/{id}/Lyrics → Lyrics. Start is in ticks. Metadata.Offset is left alone: whether the
// server already applied it is unverified (spec §3.5), and the mock sends starts without it.
export function lyricsFromJellyfin(dto: { Metadata?: { IsSynced?: boolean }; Lyrics?: { Text?: string; Start?: number }[] } | null): Lyrics | null {
  const rows = dto?.Lyrics ?? [];
  if (!rows.length) return null;
  const synced = dto?.Metadata?.IsSynced ?? rows.some((r) => typeof r.Start === 'number');
  return {
    synced,
    lines: rows.map((r) => (synced && typeof r.Start === 'number' ? { startMs: Math.round(r.Start / 10_000), text: r.Text ?? '' } : { text: r.Text ?? '' })),
  };
}
