// Renderer mirror of the qBittorrent state, state labels, and the window-wide
// .torrent drop target. Imported by the Downloads route, so it is live from startup.
import type { Torrent, TorrentsState } from '../../shared/contract';
import { w } from './bridge';
import { fmt, t } from './i18n.svelte';
import { navigate } from './router.svelte';
import { settings, toast } from './stores.svelte';

export const torrents = $state<{ value: TorrentsState | null; dropped: File[]; dragging: boolean }>({ value: null, dropped: [], dragging: false });

let started = false;
export function initTorrents(): void {
  if (started) return;
  started = true;
  w.torrents.onState((s) => {
    torrents.value = s;
  });
  void w.torrents.state().then((s) => (torrents.value ??= s));
}

// qBittorrent state -> torrents.state.<key>.
const LABELS: Record<string, string> = {
  downloading: 'downloading',
  forcedDL: 'forcedDL',
  metaDL: 'metaDL',
  forcedMetaDL: 'metaDL',
  stalledDL: 'stalledDL',
  queuedDL: 'queuedDL',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  checkingDL: 'checking',
  uploading: 'uploading',
  forcedUP: 'forcedUP',
  stalledUP: 'stalledUP',
  queuedUP: 'queuedUP',
  pausedUP: 'completed',
  stoppedUP: 'completed',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  allocating: 'allocating',
  moving: 'moving',
  missingFiles: 'missingFiles',
  error: 'error',
};
export const stateLabel = (tor: Torrent): string => t(`torrents.state.${LABELS[tor.state] ?? 'unknown'}`);
export const isPaused = (tor: Torrent): boolean => /^(paused|stopped)/.test(tor.state);
export const isBroken = (tor: Torrent): boolean => tor.state === 'error' || tor.state === 'missingFiles';
export const isDownloading = (tor: Torrent): boolean => tor.progress < 1 && !isPaused(tor);
export const speed = (n: number): string => fmt.speed(n);

// Time left: "42 s", "5 min", "1 h 05", "3 j" (English: "42s", "5m", "1h 5m", "3d").
export function eta(seconds: number): string {
  if (!seconds || seconds <= 0 || seconds >= 8640000) return '';
  if (seconds < 60) return t('torrents.eta.seconds', { count: seconds });
  if (seconds < 3600) return fmt.duration(Math.ceil(seconds / 60) * 60_000);
  if (seconds < 86400) return fmt.duration(Math.floor(seconds / 60) * 60_000);
  return t('torrents.eta.days', { count: Math.round(seconds / 86400) });
}

export function magnetName(link: string): string {
  try {
    return new URLSearchParams(link.replace(/^magnet:\?/i, '')).get('dn')?.trim() || t('torrents.magnetLink');
  } catch {
    return t('torrents.magnetLink');
  }
}

export const MAGNET_RE = /^magnet:\?xt=urn:bt(ih|mh):[^\s]+$/i;

// Window-wide drop of .torrent files: hands them to the Torrents tab, which
// opens the add sheet. The OSD window shares this bundle and stays out of it.
if (!document.documentElement.classList.contains('osd')) {
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    torrents.dragging = true;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) torrents.dragging = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    torrents.dragging = false;
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.torrent$/i.test(f.name));
    if (!files.length) return;
    if (!settings.value?.torrents.url) toast('info', t('torrents.dropNeedsSetup'));
    else torrents.dropped = files;
    navigate('/downloads?tab=torrents');
  });
}
