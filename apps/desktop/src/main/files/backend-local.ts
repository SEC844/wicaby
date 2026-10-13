// A folder picked on this machine, or an SMB share reached by its UNC path on Windows (file-sources-spec §5.1,
// §7.4). Every path is joined to the root, then its real path must stay under the root's real path: symlinks
// and junctions that lead out are refused, and so are \\?\ and \\.\ device paths.
import fs from 'node:fs';
import path from 'node:path';
import { guardRel } from '../../shared/files/ids';
import { byteRange, filesError, MAX_ENTRIES, mimeOf, type FileEntry, type FilesBackend, type OpenResult } from './backend';

const errCode = (err: unknown): string => (err as { code?: string })?.code ?? '';

function mapError(err: unknown): Error {
  const code = errCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') return filesError('notFound');
  if (code === 'EACCES' || code === 'EPERM') return filesError('auth');
  if (/^(EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EBADF|EIO|UNKNOWN|ENODEV|EBUSY)$/.test(code)) return filesError('offline');
  return err instanceof Error ? err : new Error(String(err));
}

export class LocalBackend implements FilesBackend {
  private realRoot: string | null = null;

  constructor(
    private readonly root: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private inside(real: string, root: string): boolean {
    const norm = (p: string) => (this.platform === 'win32' ? p.toLowerCase() : p);
    const a = norm(real);
    const b = norm(root.endsWith(path.sep) ? root.slice(0, -1) : root);
    return a === b || a.startsWith(b + path.sep);
  }

  private async rootReal(): Promise<string> {
    if (/^\\\\[?.]\\/.test(this.root) || !path.isAbsolute(this.root)) throw filesError('invalid');
    this.realRoot ??= await fs.promises.realpath(this.root).catch((err) => {
      throw mapError(err);
    });
    return this.realRoot;
  }

  // The real path of rel, refused when it leaves the root.
  async resolve(rel: string): Promise<string> {
    if (guardRel(rel) === null) throw filesError('invalid');
    const root = await this.rootReal();
    const joined = rel ? path.join(this.root, ...rel.split('/')) : this.root;
    const real = await fs.promises.realpath(joined).catch((err) => {
      throw mapError(err);
    });
    if (/^\\\\[?.]\\/.test(real) && !/^\\\\[?.]\\/.test(root)) throw filesError('invalid');
    if (!this.inside(real, root)) throw filesError('invalid');
    return real;
  }

  async list(rel: string): Promise<FileEntry[]> {
    const dir = await this.resolve(rel);
    const root = await this.rootReal();
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true }).catch((err) => {
      throw mapError(err);
    });
    const out: FileEntry[] = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      const full = path.join(dir, d.name);
      try {
        // A link (or junction) counts only when its target stays under the root.
        if (d.isSymbolicLink() && !this.inside(await fs.promises.realpath(full), root)) continue;
        const st = await fs.promises.stat(full);
        out.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
      } catch {
        // A dangling link, or a file gone meanwhile.
      }
    }
    return out;
  }

  async stat(rel: string): Promise<FileEntry> {
    const p = await this.resolve(rel);
    const st = await fs.promises.stat(p).catch((err) => {
      throw mapError(err);
    });
    return { name: path.basename(p), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs };
  }

  async read(rel: string, maxBytes: number): Promise<Buffer> {
    const p = await this.resolve(rel);
    const st = await fs.promises.stat(p);
    if (st.size > maxBytes) throw filesError('tooLarge');
    return fs.promises.readFile(p);
  }

  async open(rel: string, range: string | undefined, head = false): Promise<OpenResult> {
    const p = await this.resolve(rel);
    const st = await fs.promises.stat(p).catch((err) => {
      throw mapError(err);
    });
    if (st.isDirectory()) throw filesError('notFound');
    const size = st.size;
    const base = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeOf(p), 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
    const r = byteRange(range, size);
    if (r === 'bad') return { status: 416, size, headers: { ...base, 'Content-Range': `bytes */${size}` }, body: null };
    if (r)
      return {
        status: 206,
        size,
        headers: { ...base, 'Content-Range': `bytes ${r.start}-${r.end}/${size}`, 'Content-Length': String(r.end - r.start + 1) },
        body: head ? null : fs.createReadStream(p, { start: r.start, end: r.end }),
      };
    return { status: 200, size, headers: { ...base, 'Content-Length': String(size) }, body: head ? null : fs.createReadStream(p) };
  }

  localPath(rel: string): Promise<string> {
    return this.resolve(rel);
  }
}
