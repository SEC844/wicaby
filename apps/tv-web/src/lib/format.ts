// Item text helpers shared by the cards, the hero and the details page (Android core Emby.kt, tv Components.kt).
import type { BaseItem } from '$shared/models';
import { t } from './i18n.svelte';

export const TICKS_PER_MS = 10_000;

// "1 h 05" / "45 min" (French), "1h 05m" / "45 min" (English).
export function runtimeText(ticks: number | undefined): string | undefined {
  const min = Math.floor((ticks ?? 0) / 600_000_000);
  if (min <= 0) return undefined;
  return min >= 60 ? t('duration_hours_minutes', Math.floor(min / 60), min % 60) : t('duration_minutes', min);
}

// Played fraction of a started item, for the progress line.
export function progress(item: BaseItem): number | undefined {
  const total = item.RunTimeTicks ?? 0;
  const pos = item.UserData?.PlaybackPositionTicks ?? 0;
  return pos > 0 && total > 0 ? Math.min(1, pos / total) : undefined;
}

export function episodeLine(item: BaseItem): string | undefined {
  if (item.Type !== 'Episode') return undefined;
  const s = item.ParentIndexNumber;
  const e = item.IndexNumber;
  const code = s != null && e != null ? t('episode_code', s, e) : undefined;
  return [code, item.Name || undefined].filter(Boolean).join(' · ') || undefined;
}

// Year · rating · runtime · ★ score · two genres (Main.kt metaLine).
export function metaLine(item: BaseItem, locale: string): string {
  return [
    item.ProductionYear?.toString(),
    item.OfficialRating,
    runtimeText(item.RunTimeTicks),
    item.CommunityRating != null ? `★ ${item.CommunityRating.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : undefined,
    item.Genres?.slice(0, 2).join(', ') || undefined,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

// A playback time: "4:07", "1:05:12" (Android clock()).
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
