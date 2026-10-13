// Shared plumbing of the server-level admin sections (server settings,
// transcoding, plugins, API keys, logs). Every call goes to one server through
// the IPC proxy; Emby and Jellyfin differ only where a helper says so.
import type { Query, ServerKind } from '../../../shared/contract';
import { w } from '../../lib/bridge';
import { t } from '../../lib/i18n.svelte';
import { sessionFor, toast } from '../../lib/stores.svelte';

export function serverKind(serverId: string, kind?: ServerKind): ServerKind {
  return kind ?? sessionFor(serverId)?.server.kind ?? 'emby';
}

export function adminApi(serverId: string) {
  return {
    get: <T>(path: string, query?: Query) => w.api.get<T>(path, query, serverId),
    post: <T>(path: string, query?: Query, body?: unknown) => w.api.post<T>(path, query, body, serverId),
    del: <T>(path: string, query?: Query) => w.api.del<T>(path, query, serverId),
  };
}

// The proxy keeps only the server's text (or "HTTP <status>"); map the usual
// permission answers to one sentence.
export function adminError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^HTTP 40[13]$|forbidden|unauthori[sz]ed|administrat/i.test(msg)) return t('adminServer.common.forbidden');
  if (/^HTTP 404$/.test(msg)) return t('adminServer.common.unsupported');
  return msg || t('adminServer.common.failed');
}

// ---- Restart required ----
// Kept per server for the whole session, so the banner follows the admin from
// one section to the next until the server restarts.
export const restartState = $state<{ needed: Record<string, boolean> }>({ needed: {} });

export function markRestart(serverId: string): void {
  restartState.needed[serverId] = true;
}

// Both servers report a pending restart in /System/Info (plugins, ports, updates).
export async function checkPendingRestart(serverId: string): Promise<void> {
  try {
    const info = await w.api.get<{ HasPendingRestart?: boolean }>('/System/Info', undefined, serverId);
    if (info?.HasPendingRestart) markRestart(serverId);
  } catch {
    /* informational only */
  }
}

// Same endpoint as the dashboard's restart button.
export async function restartServer(serverId: string): Promise<boolean> {
  try {
    await w.api.post('/System/Restart', undefined, undefined, serverId);
    restartState.needed[serverId] = false;
    toast('info', t('adminServer.restart.started'));
    return true;
  } catch (err) {
    toast('error', adminError(err));
    return false;
  }
}

// ---- Server web pages (plugin configuration) ----

export function serverBase(serverId: string): string | undefined {
  const s = sessionFor(serverId);
  const a = s?.address ?? s?.server.lastAddress ?? s?.server.manualAddress ?? s?.server.localAddress;
  return a?.replace(/\/+$/, '');
}

// Hash route of the server's own web app; Emby serves it under /web/index.html#!/, Jellyfin under /web/#/.
export function serverWebUrl(serverId: string, kind: ServerKind, route: string): string | undefined {
  const base = serverBase(serverId);
  if (!base) return undefined;
  return kind === 'jellyfin' ? `${base}/web/#/${route}` : `${base}/web/index.html#!/${route}`;
}

// ---- Small utilities ----

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', t('adminServer.common.copied'));
  } catch (err) {
    toast('error', adminError(err));
  }
}

export function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Ids differ in dash and case between /Plugins, /Packages and /web/ConfigurationPages.
export function sameGuid(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/[-{}]/g, '').toLowerCase() === b.replace(/[-{}]/g, '').toLowerCase();
}

// Dotted numeric version compare ("4.1.10.0" > "4.1.9").
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const isPort = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
