// Short lines of facts under a title, as the Apple TV app writes them: "Science-fiction · 2019 · 1 h 52".
import type { BaseItem } from '$shared/models';
import { runtimeText } from '$tv/format';

export function factsLine(item: BaseItem): string {
  return [item.Genres?.[0], item.ProductionYear?.toString(), item.Type === 'Series' ? undefined : runtimeText(item.RunTimeTicks)].filter(Boolean).join(' · ');
}
