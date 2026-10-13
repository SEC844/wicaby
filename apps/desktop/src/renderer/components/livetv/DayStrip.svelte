<script lang="ts">
  import { DAYPARTS } from '../../../shared/livetv/anchor';
  import type { DayChip, DaypartId } from '../../../shared/livetv/anchor';
  import { fmt, t } from '../../lib/i18n.svelte';
  import Icon from '../Icon.svelte';

  // Day strip, dayparts and ±3 h paging (§6.4). Days come from the store (local calendar days, so
  // a DST day is 23 h or 25 h wide); dayparts are data in anchor.ts, only their labels are strings.
  let {
    days,
    selected,
    live,
    onday,
    ondaypart,
    onpage,
  }: {
    days: readonly DayChip[];
    selected: string; // YYYY-MM-DD of the day on screen
    live: boolean; // anchor 'live': "Maintenant" is current
    onday: (d: DayChip) => void;
    ondaypart: (id: DaypartId) => void;
    onpage: (dir: -1 | 1) => void;
  } = $props();

  function label(d: DayChip): string {
    if (d.index === 0) return t('livetv.guide.today');
    if (d.index === 1) return t('livetv.guide.tomorrow');
    return fmt.day(d.start);
  }

  const parts: DaypartId[] = ['now', ...DAYPARTS.map((p) => p.id)];
</script>

<div class="strip">
  <div class="days" role="group" aria-label={t('livetv.guide.day')}>
    {#each days as d (d.key)}
      <button class="pill" data-day={d.key} aria-pressed={d.key === selected} onclick={() => onday(d)}>{label(d)}</button>
    {/each}
  </div>
  <span class="sep" aria-hidden="true"></span>
  <div class="parts" role="group" aria-label={t('livetv.guide.time')}>
    {#each parts as id (id)}
      <button class="pill" aria-pressed={id === 'now' && live} onclick={() => ondaypart(id)}>{t(`livetv.guide.dayparts.${id}`)}</button>
    {/each}
  </div>
  <span class="paging">
    <button class="btn icon ghost" onclick={() => onpage(-1)} aria-label={t('livetv.guide.earlier')} title={t('livetv.guide.earlier')}><Icon name="chevronLeft" size={16} /></button>
    <button class="btn icon ghost" onclick={() => onpage(1)} aria-label={t('livetv.guide.later')} title={t('livetv.guide.later')}><Icon name="chevronRight" size={16} /></button>
  </span>
</div>

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .days,
  .parts {
    display: flex;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .days {
    flex: 1 1 auto;
  }
  .parts {
    flex: 0 1 auto;
  }
  .sep {
    width: 1px;
    height: 20px;
    flex: none;
    background: var(--separator);
  }
  .paging {
    display: inline-flex;
    flex: none;
    gap: 2px;
  }
  .pill {
    flex: none;
    height: 30px;
    padding: 0 12px;
    border-radius: 15px;
    font-size: var(--fs-footnote);
    font-weight: 560;
    color: var(--label-2);
    white-space: nowrap;
    text-transform: capitalize;
    transition: background-color var(--t-fast) var(--ease);
  }
  .pill:is(:hover, :focus-visible) {
    background: var(--fill-3);
    color: var(--label);
  }
  .pill[aria-pressed='true'] {
    background: var(--fill-4);
    color: var(--label);
  }
  @media (forced-colors: active) {
    .pill[aria-pressed='true'],
    .pill:focus-visible {
      outline: 2px solid Highlight;
    }
  }
</style>
