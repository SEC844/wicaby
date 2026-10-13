import { TICKS_PER_MS } from '../../shared/contract';
import type { BaseItem, MediaStream } from '../../shared/models';
import { hdrChip } from '../../shared/hdr';
import { fmt, has, t } from './i18n.svelte';

export function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function runtime(ticks?: number): string {
  if (!ticks) return '';
  return fmt.duration(ticks / TICKS_PER_MS);
}

export function remaining(item: BaseItem): string {
  const total = item.RunTimeTicks ?? 0;
  const pos = item.UserData?.PlaybackPositionTicks ?? 0;
  if (!total || !pos) return '';
  return t('common.time.remaining', { time: runtime(total - pos) });
}

export function progress(item: BaseItem): number {
  const pct = item.UserData?.PlayedPercentage;
  if (pct) return Math.min(100, pct);
  const total = item.RunTimeTicks ?? 0;
  const pos = item.UserData?.PlaybackPositionTicks ?? 0;
  return total && pos ? Math.min(100, (pos / total) * 100) : 0;
}

export function bytes(n: number): string {
  return fmt.bytes(n);
}

export function episodeCode(item: { ParentIndexNumber?: number; IndexNumber?: number }): string {
  if (item.IndexNumber === undefined) return '';
  const s = item.ParentIndexNumber !== undefined ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : '';
  return `${s}E${String(item.IndexNumber).padStart(2, '0')}`;
}


// Quality badges from the media streams: 4K, HDR10, Dolby Vision, Atmos, 5.1.
export function badges(streams: MediaStream[] | undefined): string[] {
  if (!streams) return [];
  const out: string[] = [];
  const v = streams.find((s) => s.Type === 'Video');
  if (v?.Width) out.push(v.Width >= 3800 ? '4K' : v.Width >= 1900 ? '1080p' : v.Width >= 1260 ? '720p' : 'SD');
  const hdr = hdrChip(v);
  if (hdr) out.push(hdr);
  const a = streams.filter((s) => s.Type === 'Audio');
  if (a.some((s) => /atmos/i.test(s.DisplayTitle ?? '') || /atmos/i.test(s.Title ?? ''))) out.push('Atmos');
  const ch = Math.max(0, ...a.map((s) => s.Channels ?? 0));
  if (ch >= 8) out.push('7.1');
  else if (ch >= 6) out.push('5.1');
  return out;
}

// "Fin à 22:41" / "Ends at 10:41 PM" for something you would start (or resume) now.
export function endsAt(item: BaseItem): string {
  if (!item.RunTimeTicks || item.Type === 'Series') return '';
  const left = item.RunTimeTicks - (item.UserData?.PlaybackPositionTicks ?? 0);
  return t('common.time.endsAt', { time: fmt.time(Date.now() + left / TICKS_PER_MS) });
}

export function yearRange(it: BaseItem): string {
  if (!it.ProductionYear) return '';
  if (it.Type !== 'Series') return String(it.ProductionYear);
  if (it.Status === 'Continuing') return t('common.time.yearContinuing', { year: it.ProductionYear });
  const end = it.EndDate ? new Date(it.EndDate).getFullYear() : null;
  return end && end !== it.ProductionYear ? `${it.ProductionYear} – ${end}` : String(it.ProductionYear);
}

export function typeLabel(type: string): string {
  const key = `common.types.${type}`;
  return has(key) ? t(key) : type;
}
