// A temporary media tree for the file sources checks and mocks (file-sources-spec FS-02). Nothing in it is
// real: example names only, and the one playable video is a 10 s test pattern encoded once by the bundled mpv
// from av://lavfi:testsrc (video only, no audio stream). Without mpv every video is a stub flagged `unplayable`.
// Usage: import { buildFilesFixture } from './files-fixture.mjs'; const fx = buildFilesFixture(dir);
//        node tools/mock-server/files-fixture.mjs <dir>   (prints the summary)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');

export function findMpv() {
  const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [path.join(repo, 'vendor', 'mpv', exe), ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, exe))];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

// The encoded clip, cached across runs in the OS temp folder (a few hundred KB).
function testVideo() {
  const cached = path.join(os.tmpdir(), 'wicaby-files-fixture-v1.mkv');
  if (fs.existsSync(cached) && fs.statSync(cached).size > 10_000) return cached;
  const mpv = findMpv();
  if (!mpv) return null;
  const tmp = `${cached}.${process.pid}.mkv`;
  const r = spawnSync(
    mpv,
    ['--no-config', '--no-audio', '--ao=null', 'av://lavfi:testsrc=duration=10:size=320x180:rate=25', `--o=${tmp}`, '--of=matroska', '--ovc=mpeg4', '--ovcopts=b=300k', '--oset-metadata=title=Example Tag Title'],
    { stdio: 'ignore', timeout: 60_000 },
  );
  if (r.status !== 0 || !fs.existsSync(tmp)) return null;
  fs.renameSync(tmp, cached);
  return cached;
}

const STUB = Buffer.from('WICABY TEST STUB: not a video\n');

export function buildFilesFixture(dir, { video = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const clip = video ? testVideo() : null;
  const put = (rel, data) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (data === 'video') {
      if (clip) fs.copyFileSync(clip, p);
      else fs.writeFileSync(p, STUB);
    } else fs.writeFileSync(p, data);
    return p;
  };
  // A 1x1 PNG.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a3d6b0b40000000049454e44ae426082', 'hex');
  const film = 'Films/Example Movie (2019)';
  put(`${film}/Example.Movie.2019.1080p.mkv`, 'video');
  put(`${film}/poster.jpg`, png);
  put(
    `${film}/movie.nfo`,
    '<?xml version="1.0" encoding="UTF-8"?>\n<movie>\n  <title>Example Movie &amp; Friends</title>\n  <year>2019</year>\n  <plot>A film that only exists in tests.</plot>\n  <uniqueid type="imdb" default="true">tt0000001</uniqueid>\n  <genre>Drama</genre>\n</movie>\n',
  );
  put(`${film}/Example.Movie.2019.1080p.fr.srt`, '1\n00:00:01,000 --> 00:00:03,000\nBonjour\n');
  put(`${film}/Example.Movie.2019.1080p.en.forced.srt`, '1\n00:00:01,000 --> 00:00:03,000\nHello\n');
  const show = 'Shows/Example Show';
  put(`${show}/tvshow.nfo`, '<tvshow><title>Example Show</title><year>2020</year></tvshow>\n');
  put(`${show}/poster.png`, png);
  for (let e = 1; e <= 10; e++) put(`${show}/Season 1/Example.Show.S01E${String(e).padStart(2, '0')}.720p.mkv`, e === 1 ? 'video' : STUB);
  put(`${show}/Season 10/Example.Show.S10E01.mkv`, STUB);
  put(`${show}/Season 2/Example.Show.S02E01.mkv`, STUB);
  // Hidden: NAS metadata, dot-files, a recycle bin, non-video files.
  put('@eaDir/thumb.jpg', png);
  put('#recycle/old.mkv', STUB);
  put('.hidden/secret.mkv', STUB);
  put('Films/.DS_Store', 'x');
  put('Films/notes.txt', 'not listed');
  return {
    dir,
    playable: Boolean(clip),
    unplayable: !clip,
    film: `${film}/Example.Movie.2019.1080p.mkv`,
    episode: `${show}/Season 1/Example.Show.S01E01.720p.mkv`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-'));
  console.log(JSON.stringify(buildFilesFixture(dir), null, 2));
}
