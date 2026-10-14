// Photo file sources: a file source added under Settings > Photo sources (StoredSource.photos) answers the Emby
// photo calls the photo UI already makes (timeline, albums, favourites, "on this day", /Years, the info panel) from
// an index of its folder tree, so the timeline, grid, viewer, slideshow, map and memories are the Emby ones. The
// index (userData/files/photos-<id>.json) holds what each file's first 64 KB say (shared/files/exif.ts): one full
// scan, then on each later run only files whose size or mtime changed are read again. Albums are the folders that
// hold photos; favourites are local. GPS stays in this file and reaches the renderer only while the map is on;
// nothing here logs a path or a coordinate.
import { Readable } from 'node:stream';
import { HEAD_BYTES, heicExifItem, orientationName, readPhotoHead, type PhotoHead } from '../../shared/files/exif';
import { baseName, decodeId, encodeId, joinRel, parentRel, ROOT_ID } from '../../shared/files/ids';
import { extOf } from '../../shared/files/names';
import { natCompare } from '../../shared/files/natsort';
import type { PhotoScanStatus, Query } from '../../shared/contract';
import type { BaseItem, ItemsResult } from '../../shared/models';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import { filesError, mimeOf, type FileEntry, type FilesBackend } from './backend';
import { isHiddenName } from './files-client';
import type { PhotoThumbs } from './photo-thumbs';

const log = logger.scope('files');

export const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const CLIP_EXTS = new Set(['mp4', 'mov', 'm4v']);
const JOBS = 4;
const MAX_DEPTH = 32;
const MAX_FILES = 200_000;
// A HEIC Exif item past the head is read once more, up to this size.
const MAX_ITEM = 1024 * 1024;

// p: the path, s: size, m: mtime (ms), v: a clip.
export interface PhotoRecord extends PhotoHead {
  p: string;
  s: number;
  m: number;
  v?: 1;
}

interface Doc {
  v: 1;
  scannedAt?: number;
  files: PhotoRecord[];
  favorites: string[];
}

const p2 = (n: number) => String(n).padStart(2, '0');
// The wall-clock moment the timeline files a record under: its EXIF date, else its mtime in local time (what the
// renderer's takenAt() makes of DateCreated, main and renderer sharing the zone).
export function wallClock(r: PhotoRecord): string {
  if (r.takenAt) return r.takenAt;
  const d = new Date(r.m);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

const tagOf = (r: PhotoRecord) => `${r.s.toString(36)}${Math.floor(r.m / 1000).toString(36)}`;
const under = (dir: string, p: string) => dir === '' || p.startsWith(`${dir}/`);
const typesOf = (q: Query) => String(q.IncludeItemTypes ?? '').split(',').filter(Boolean);

// The first `length` bytes from `start` (a ranged GET; a server that ignores Range sends the whole file).
export async function readRange(backend: FilesBackend, rel: string, start: number, length: number): Promise<Buffer> {
  const r = await backend.open(rel, `bytes=${start}-${start + length - 1}`);
  if (!r.body) return Buffer.alloc(0);
  const skip = r.status === 206 ? 0 : start;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of r.body) {
    chunks.push(c as Buffer);
    n += (c as Buffer).length;
    if (n >= skip + length) break;
  }
  r.body.destroy();
  return Buffer.concat(chunks).subarray(skip, skip + length);
}

export class PhotoIndex {
  private recs = new Map<string, PhotoRecord>();
  private favs = new Set<string>();
  private store: JsonStore<Doc>;
  private running: Promise<void> | null = null;
  // The last timeline query, sorted: its pages are asked one after another.
  private sorted: { key: string; list: PhotoRecord[] } | null = null;
  // This run's refresh started (later opens are incremental: once per run, then on Rescan).
  private refreshed = false;
  status: PhotoScanStatus;

  constructor(
    readonly backend: FilesBackend,
    file: string,
    private readonly sourceId: string,
    private readonly thumbs: PhotoThumbs,
    // The photo map is on: coordinates may reach the renderer (spec §6.1).
    private readonly geo: () => boolean,
  ) {
    this.store = new JsonStore<Doc>(file, { v: 1, files: [], favorites: [] }, 2000);
    const doc = this.store.value;
    if (!doc || !Array.isArray(doc.files) || !Array.isArray(doc.favorites)) this.store.set({ v: 1, files: [], favorites: [] });
    for (const r of this.store.value.files) if (r && typeof r.p === 'string' && encodeId(r.p)) this.recs.set(r.p, r);
    for (const f of this.store.value.favorites) if (typeof f === 'string') this.favs.add(f);
    this.status = { state: this.store.value.scannedAt ? 'ready' : 'scanning', count: this.recs.size, scannedAt: this.store.value.scannedAt };
  }

  // The index the queries read: the stored one at once (this run's refresh goes on behind it), else the first scan.
  async ready(): Promise<void> {
    // A first scan that failed is tried again by the next visit.
    if (!this.refreshed || (!this.store.value.scannedAt && !this.running)) void this.rescan().catch(() => undefined);
    if (!this.store.value.scannedAt) await this.running;
  }

  // Walks the tree; files whose size and mtime are unchanged keep their record. One walk at a time.
  rescan(): Promise<void> {
    this.refreshed = true;
    this.running ??= this.walk().finally(() => (this.running = null));
    return this.running;
  }

  private async walk(): Promise<void> {
    this.status = { ...this.status, state: 'scanning' };
    const next = new Map<string, PhotoRecord>();
    const queue: (() => Promise<void>)[] = [];
    let active = 0;
    let failed: unknown = null;
    const dir = (rel: string, depth: number) => async () => {
      let entries: FileEntry[];
      try {
        entries = await this.backend.list(rel);
      } catch (err) {
        // The root failing fails the scan; a folder that cannot be read is skipped.
        if (!rel) failed = err;
        return;
      }
      for (const e of entries) {
        if (isHiddenName(e.name)) continue;
        const p = joinRel(rel, e.name);
        if (!encodeId(p)) continue;
        if (e.dir) {
          if (depth < MAX_DEPTH) queue.push(dir(p, depth + 1));
          continue;
        }
        const ext = extOf(e.name);
        const clip = CLIP_EXTS.has(ext);
        if ((!clip && !PHOTO_EXTS.has(ext)) || next.size >= MAX_FILES) continue;
        const old = this.recs.get(p);
        if (old && old.s === e.size && old.m === e.mtime) next.set(p, old);
        else if (clip) next.set(p, { p, s: e.size, m: e.mtime, v: 1 });
        else {
          const rec: PhotoRecord = { p, s: e.size, m: e.mtime };
          next.set(p, rec);
          queue.push(() => this.readHead(rec));
        }
      }
      this.status = { ...this.status, count: next.size };
    };
    await new Promise<void>((resolve) => {
      const pump = () => {
        while (active < JOBS && queue.length) {
          const job = queue.shift()!;
          active++;
          job()
            .catch(() => undefined)
            .finally(() => {
              active--;
              pump();
            });
        }
        if (!active && !queue.length) resolve();
      };
      queue.push(dir('', 0));
      pump();
    });
    if (failed) {
      this.status = { ...this.status, state: 'error', count: this.recs.size };
      log.info(`photo source ${this.sourceId.slice(0, 6)}: scan failed`);
      throw failed;
    }
    this.recs = next;
    this.sorted = null;
    for (const f of this.favs) if (!next.has(f)) this.favs.delete(f);
    const scannedAt = Date.now();
    this.store.set({ v: 1, scannedAt, files: [...next.values()], favorites: [...this.favs] });
    this.status = { state: 'ready', count: next.size, scannedAt };
    log.info(`photo source ${this.sourceId.slice(0, 6)}: ${next.size} files indexed`);
  }

  // What the first bytes say (a second read for a HEIC whose Exif item sits further). Unreadable: dated by mtime.
  private async readHead(rec: PhotoRecord): Promise<void> {
    try {
      let head = readPhotoHead(await readRange(this.backend, rec.p, 0, HEAD_BYTES));
      if (head.more) {
        const { at, length } = head.more;
        const rest = length <= MAX_ITEM && at + length <= rec.s ? heicExifItem(await readRange(this.backend, rec.p, at, length)) : {};
        head = { ...rest, width: head.width, height: head.height };
      }
      delete head.more;
      Object.assign(rec, head);
    } catch {
      // kept with its size and mtime only
    }
  }

  flush(): void {
    this.store.flush();
  }

  // ---- The Emby calls (files-client.ts routes them here for a photo source) ----

  rootItem(name: string): BaseItem {
    return { Id: ROOT_ID, Name: name, Type: 'CollectionFolder', CollectionType: 'photos', IsFolder: true, ServerId: this.sourceId };
  }

  private toItem(r: PhotoRecord): BaseItem {
    const geo = this.geo() && r.lat !== undefined && r.lon !== undefined;
    return {
      Id: encodeId(r.p)!,
      Name: baseName(r.p),
      Type: r.v ? 'Video' : 'Photo',
      MediaType: r.v ? 'Video' : 'Photo',
      IsFolder: false,
      ServerId: this.sourceId,
      ParentId: encodeId(parentRel(r.p)) ?? ROOT_ID,
      Container: extOf(r.p),
      DateCreated: new Date(r.m).toISOString(),
      ...(r.takenAt ? { PremiereDate: `${r.takenAt}${r.offset ?? ''}`, ProductionYear: Number(r.takenAt.slice(0, 4)) } : {}),
      ...(r.width && r.height ? { Width: r.width, Height: r.height } : {}),
      ...(orientationName(r.orientation) ? { ImageOrientation: orientationName(r.orientation) } : {}),
      ...(r.v ? {} : { ImageTags: { Primary: tagOf(r) } }),
      CameraMake: r.make,
      CameraModel: r.model,
      ExposureTime: r.exposureS,
      // An f-number (PhotoViewer shows it as such for a file source).
      Aperture: r.fNumber,
      FocalLength: r.focalMm,
      IsoSpeedRating: r.iso,
      ...(geo ? { Latitude: r.lat, Longitude: r.lon, Altitude: r.alt } : {}),
      UserData: { IsFavorite: this.favs.has(r.p), Played: false, PlaybackPositionTicks: 0 },
    } as BaseItem;
  }

  isFavorite(rel: string): boolean {
    return this.favs.has(rel);
  }

  record(rel: string): PhotoRecord | undefined {
    return this.recs.get(rel);
  }

  // A photo's item (the info panel); null for anything else (clips and folders take the files route).
  async item(rel: string): Promise<BaseItem | null> {
    await this.ready();
    const r = this.recs.get(rel);
    if (r && !r.v) return this.toItem(r);
    const album = rel ? this.albums('').find((a) => a.Id === encodeId(rel)) : undefined;
    return album ?? null;
  }

  // Timeline, album and favourites pages (newest first: pages stay in order once re-sorted by takenAt), the
  // memories' date ranges, the screensaver's random pick, and the Albums tab (IncludeItemTypes=PhotoAlbum).
  async items(q: Query): Promise<ItemsResult> {
    await this.ready();
    const parent = q.ParentId === undefined ? '' : decodeId(q.ParentId);
    if (parent === null) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const types = typesOf(q);
    if (types.includes('PhotoAlbum')) {
      const all = this.albums(parent);
      return { Items: all, TotalRecordCount: all.length, StartIndex: 0 };
    }
    const photos = !types.length || types.includes('Photo');
    const clips = !types.length || types.includes('Video');
    const fav = String(q.Filters ?? '').includes('IsFavorite') || q.IsFavorite === true || q.IsFavorite === 'true';
    const min = typeof q.MinPremiereDate === 'string' ? q.MinPremiereDate.slice(0, 19) : '';
    const max = typeof q.MaxPremiereDate === 'string' ? q.MaxPremiereDate.slice(0, 19) : '';
    const recursive = q.Recursive === true || q.Recursive === 'true';
    const sort = String(q.SortBy ?? '').split(',')[0];
    const key = JSON.stringify([parent, photos, clips, fav, min, max, recursive, sort, q.SortOrder]);
    const start = Math.max(0, Number(q.StartIndex) || 0);
    const hit = sort !== 'Random' && this.sorted?.key === key ? this.sorted.list : null;
    const list = hit ?? this.select(parent, photos, clips, fav, min, max, recursive, sort, q.SortOrder === 'Descending');
    if (!hit) this.sorted = { key, list };
    const limit = Math.max(0, Number(q.Limit) || list.length);
    return { Items: list.slice(start, start + limit).map((r) => this.toItem(r)), TotalRecordCount: list.length, StartIndex: start };
  }

  private select(parent: string, photos: boolean, clips: boolean, fav: boolean, min: string, max: string, recursive: boolean, sort: string, desc: boolean): PhotoRecord[] {
    let list = [...this.recs.values()].filter(
      (r) =>
        (r.v ? clips : photos) &&
        (recursive ? under(parent, r.p) : parentRel(r.p) === parent) &&
        (!fav || this.favs.has(r.p)) &&
        (!min || wallClock(r) >= min) &&
        (!max || wallClock(r) <= max),
    );
    if (sort === 'Random') list.sort(() => Math.random() - 0.5);
    else if (sort === 'SortName') list.sort((a, b) => natCompare(a.p, b.p));
    else {
      const d = desc ? -1 : 1;
      list = list.map((r) => [wallClock(r), r] as const).sort((a, b) => d * (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : natCompare(a[1].p, b[1].p))).map((x) => x[1]);
    }
    return list;
  }

  // /Years: the years present under ParentId (the scrubber's ticks, the memories' years).
  async years(q: Query): Promise<ItemsResult> {
    await this.ready();
    const parent = q.ParentId === undefined ? '' : decodeId(q.ParentId);
    const photosOnly = typesOf(q).join() === 'Photo';
    const years = new Set<number>();
    for (const r of this.recs.values()) if (parent !== null && under(parent, r.p) && !(photosOnly && r.v)) years.add(Number(wallClock(r).slice(0, 4)));
    const Items = [...years].sort((a, b) => b - a).map((y) => ({ Id: `y${y}`, Name: String(y), ProductionYear: y, Type: 'Year' }) as BaseItem);
    return { Items, TotalRecordCount: Items.length, StartIndex: 0 };
  }

  // Every folder that holds photos or clips is an album (its timeline takes its sub-folders too); its cover is
  // its newest photo.
  private albums(parent: string): BaseItem[] {
    const by = new Map<string, { count: number; cover?: PhotoRecord }>();
    for (const r of this.recs.values()) {
      const dir = parentRel(r.p);
      if (!dir || !under(parent, r.p) || dir === parent) continue;
      const a = by.get(dir) ?? { count: 0 };
      a.count++;
      if (!r.v && (!a.cover || wallClock(r) > wallClock(a.cover))) a.cover = r;
      by.set(dir, a);
    }
    return [...by.entries()]
      .sort((a, b) => natCompare(a[0], b[0]))
      .map(([dir, a]) => ({
        Id: encodeId(dir)!,
        Name: dir.split('/').join(' › '),
        Type: 'PhotoAlbum',
        IsFolder: true,
        ServerId: this.sourceId,
        ChildCount: a.count,
        ...(a.cover ? { ImageTags: { Primary: tagOf(a.cover) } } : {}),
      }));
  }

  setFavorite(rel: string, value: boolean): { IsFavorite: boolean } {
    if (!this.recs.has(rel)) throw filesError('notFound');
    if (value) this.favs.add(rel);
    else this.favs.delete(rel);
    this.sorted = null;
    this.store.update((d) => void (d.favorites = [...this.favs]));
    return { IsFavorite: value };
  }

  // /Items/<id>/Images/Primary: a cached thumbnail when the size asked fits one (an album: its cover), else the file.
  async image(rel: string, query: URLSearchParams, signal?: AbortSignal): Promise<Response | null> {
    await this.ready();
    let rec = this.recs.get(rel);
    if (!rec) for (const x of this.recs.values()) if (!x.v && parentRel(x.p) === rel && (!rec || wallClock(x) > wallClock(rec))) rec = x;
    if (!rec || rec.v) return null;
    const px = (k: string) => Math.max(0, Number(query.get(k)) || 0);
    const r = rec;
    const thumb = await this.thumbs.get(`${this.sourceId}/${r.p}/${tagOf(r)}`, r.p, r, px('maxWidth'), px('maxHeight'), () => this.backend.read(r.p, 64 * 1024 * 1024), signal);
    if (thumb) return new Response(new Uint8Array(thumb), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
    const o = await this.backend.open(r.p, undefined);
    return new Response(o.body ? (Readable.toWeb(o.body) as ReadableStream) : null, { headers: { 'Content-Type': mimeOf(r.p), ...(o.size ? { 'Content-Length': String(o.size) } : {}) } });
  }
}
