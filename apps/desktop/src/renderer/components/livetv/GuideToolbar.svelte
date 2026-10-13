<script lang="ts">
  import { dayKey } from '../../../shared/livetv/anchor';
  import type { DayChip, DaypartId } from '../../../shared/livetv/anchor';
  import type { Category, LensRef } from '../../../shared/livetv/model';
  import { t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import Icon from '../Icon.svelte';
  import DayStrip from './DayStrip.svelte';
  import LensBar from './LensBar.svelte';

  // The guide's two control rows (§6.1): lenses and categories, then days, dayparts and paging.
  let {
    store,
    at,
    detail,
    ondetail,
    onlens,
    oncategory,
    onday,
    ondaypart,
    onpage,
  }: {
    store: LiveTvStore;
    at: number; // the time the view is about (a third into the lane)
    detail: boolean;
    ondetail: () => void;
    onlens: (l: LensRef) => void;
    oncategory: (c: Category | null) => void;
    onday: (d: DayChip) => void;
    ondaypart: (id: DaypartId) => void;
    onpage: (dir: -1 | 1) => void;
  } = $props();
</script>

<div class="toolbar">
  <LensBar {store} {onlens} {oncategory} />
  <div class="row2">
    <DayStrip days={store.days} selected={dayKey(at)} live={store.anchor.mode === 'live'} {onday} {ondaypart} {onpage} />
    <button class="btn icon ghost" aria-pressed={detail} onclick={ondetail} aria-label={t('livetv.guide.detail')} title={t('livetv.guide.detail')}><Icon name="info" size={16} /></button>
  </div>
</div>

<style>
  .toolbar {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
  }
  .row2 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .row2 > :global(:first-child) {
    flex: 1;
  }
  .btn[aria-pressed='true'] {
    background: var(--fill-4);
  }
</style>
