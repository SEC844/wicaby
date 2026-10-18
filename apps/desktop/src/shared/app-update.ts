// Desktop update notice (main/features/app-updates.ts): the GitHub "latest release" answer, checked at the trust
// boundary. Pure, so tools/checks/app-update-check.mjs runs it under plain Node.

export const RELEASES_LATEST_API = 'https://api.github.com/repos/WicaebethTheo/wicaby/releases/latest';
const RELEASES_PAGE = 'https://github.com/WicaebethTheo/wicaby/releases/';
export const REPO_PAGE = 'https://github.com/WicaebethTheo/wicaby';
const DOWNLOAD_PREFIX = `${RELEASES_PAGE}download/`;

// How this copy was installed, which picks the asset "Download" opens.
export type InstallKind = 'setup' | 'portable' | 'appimage' | 'deb';

export interface AppUpdate {
  version: string;
  // The release page (notes), always on github.com/WicaebethTheo/wicaby/releases/.
  notesUrl: string;
  // The installer for this kind of install, else the release page.
  downloadUrl: string;
}

// 'X.Y.Z' or 'vX.Y.Z' only: a prerelease tag never counts as an update.
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// > 0 when a is newer; an unparsable side compares as 0.0.0.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function installKind(platform: string, env: Record<string, string | undefined>): InstallKind {
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'setup';
  return env.APPIMAGE ? 'appimage' : 'deb';
}

// x64 builds only: an arm64 Linux package must never be offered to this copy. Names as electron-builder.yml writes them.
const ASSET: Record<InstallKind, RegExp> = {
  setup: /^Wicaby-\d+\.\d+\.\d+-x64\.exe$/,
  portable: /^Wicaby-\d+\.\d+\.\d+-portable\.exe$/,
  appimage: /^Wicaby-(?!.*(?:arm64|aarch64)).*\.AppImage$/i,
  deb: /^Wicaby-(?!.*(?:arm64|aarch64)).*\.deb$/i,
};

// A URL main may open: https, exactly under the prefix, nothing that could climb out of it.
function under(url: unknown, prefix: string): url is string {
  if (typeof url !== 'string' || url.length > 500 || !url.startsWith(prefix)) return false;
  try {
    const u = new URL(url);
    return u.href === url && u.protocol === 'https:' && u.host === 'github.com' && !u.username && !u.password && !url.slice(prefix.length).includes('..');
  } catch {
    return false;
  }
}

// The newer stable release for this install, or null (not newer, draft, prerelease, malformed).
export function releaseUpdate(json: unknown, current: string, kind: InstallKind): AppUpdate | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft !== false || r.prerelease !== false) return null;
  const v = parseVersion(r.tag_name);
  if (!v || compareVersions(v.join('.'), current) <= 0) return null;
  const tag = r.tag_name as string;
  const version = v.join('.');
  const notesUrl = under(r.html_url, `${RELEASES_PAGE}tag/`) ? r.html_url : `${RELEASES_PAGE}tag/${encodeURIComponent(tag)}`;
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const asset = assets.find((a) => typeof a?.name === 'string' && ASSET[kind].test(a.name) && under(a.browser_download_url, `${DOWNLOAD_PREFIX}${tag}/`));
  return { version, notesUrl, downloadUrl: (asset?.browser_download_url as string | undefined) ?? notesUrl };
}

// What the cache keeps of a 200 answer: enough for releaseUpdate(), nothing else.
export function trimRelease(json: unknown): unknown {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  const assets = Array.isArray(r.assets) ? r.assets.slice(0, 64).map((a) => ({ name: a?.name, browser_download_url: a?.browser_download_url })) : [];
  return { tag_name: r.tag_name, html_url: r.html_url, draft: r.draft, prerelease: r.prerelease, assets };
}
