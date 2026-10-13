// Pure helpers for qBittorrent's /sync/maindata: incremental merge, mapping to
// the IPC shape, title matching against media-server items. No Electron here,
// so tools/checks/torrents-selfcheck.mjs can run it under plain Node.
import type { Torrent } from '../../shared/contract';

type Raw = Record<string, unknown>;

export interface SyncState {
  rid: number;
  torrents: Record<string, Raw>;
  categories: Record<string, { name: string; savePath: string }>;
  server: Raw;
}

export interface MaindataResponse {
  rid: number;
  full_update?: boolean;
  torrents?: Record<string, Raw>;
  torrents_removed?: string[];
  categories?: Record<string, Raw>;
  categories_removed?: string[];
  server_state?: Raw;
}

export const emptySync = (): SyncState => ({ rid: 0, torrents: {}, categories: {}, server: {} });

// Partial updates only carry the fields that changed since `rid`, so each
// torrent / category / server_state object is merged key by key.
export function applyMaindata(prev: SyncState, res: MaindataResponse): SyncState {
  const base = res.full_update ? emptySync() : prev;
  const torrents = { ...base.torrents };
  for (const [hash, patch] of Object.entries(res.torrents ?? {})) torrents[hash] = { ...torrents[hash], ...patch };
  for (const hash of res.torrents_removed ?? []) delete torrents[hash];
  const categories = { ...base.categories };
  for (const [name, patch] of Object.entries(res.categories ?? {})) {
    const cur = categories[name] ?? { name, savePath: '' };
    categories[name] = { name, savePath: typeof patch.savePath === 'string' ? patch.savePath : cur.savePath };
  }
  for (const name of res.categories_removed ?? []) delete categories[name];
  return { rid: typeof res.rid === 'number' ? res.rid : base.rid, torrents, categories, server: { ...base.server, ...res.server_state } };
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function toTorrent(hash: string, r: Raw): Torrent {
  return {
    hash,
    name: str(r.name) || hash,
    state: str(r.state) || 'unknown',
    progress: num(r.progress),
    dlspeed: num(r.dlspeed),
    upspeed: num(r.upspeed),
    eta: num(r.eta, 8640000),
    size: num(r.size) || num(r.total_size),
    ratio: num(r.ratio),
    category: str(r.category),
    seeds: num(r.num_seeds),
    seedsTotal: num(r.num_complete),
    peers: num(r.num_leechs),
    peersTotal: num(r.num_incomplete),
    addedOn: num(r.added_on),
    savePath: str(r.save_path),
    sequential: r.seq_dl === true,
    firstLast: r.f_l_piece_prio === true,
    forceStart: r.force_start === true,
    priority: num(r.priority),
  };
}

// Finished = all wanted pieces are in, whatever the seeding state.
export const isComplete = (r: Raw): boolean => num(r.progress) >= 1 && !/^(checking|moving|metaDL|forcedMetaDL|error|missingFiles)/.test(str(r.state));

// "2.11.4" >= "2.11.0"
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Release names: "Some.Movie.2024.1080p.WEB-DL.x265-GRP.mkv" -> "some movie".
const TAG = /^(19\d\d|20\d\d|\d{3,4}p|4k|uhd|s\d{1,2}(e\d{1,3})?|bluray|bdrip|brrip|web|webrip|web-?dl|hdtv|dvdrip|remux|x26[45]|h26[45]|hevc|av1|multi|vff|vfq|vf2|truefrench|french|vostfr|subfrench|complete|integrale|proper|repack)$/;
export function titleKey(name: string): string {
  const words = fold(name)
    .replace(/\.(mkv|mp4|avi|m4v|ts|iso)$/, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .split(/[\s._\-+]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length && TAG.test(w)) break;
    out.push(w);
  }
  return out.join(' ').replace(/[^a-z0-9 ]/g, '').trim();
}

export interface LibraryItemLike {
  Id: string;
  Name?: string;
  SeriesName?: string;
  Path?: string;
}

// A file or folder named exactly like the torrent wins; otherwise the cleaned
// release title against the item (or its series) name.
export function findItem(torrentName: string, items: LibraryItemLike[]): LibraryItemLike | undefined {
  const raw = fold(torrentName).replace(/\.(mkv|mp4|avi|m4v|ts|iso)$/, '');
  const byPath = items.find((it) =>
    fold(it.Path ?? '')
      .split(/[\\/]/)
      .some((seg) => seg.replace(/\.(mkv|mp4|avi|m4v|ts|iso)$/, '') === raw),
  );
  if (byPath) return byPath;
  const key = titleKey(torrentName);
  if (!key) return undefined;
  return items.find((it) => titleKey(it.SeriesName ?? '') === key || titleKey(it.Name ?? '') === key);
}
