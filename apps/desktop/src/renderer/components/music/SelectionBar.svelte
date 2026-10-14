<script lang="ts">
  import { t } from '../../lib/i18n.svelte';
  import { clearSelection, musicUi, playTracks, selection } from '../../lib/music-ui.svelte';
  import { queueIds } from '../../lib/queue.svelte';
  import Icon from '../Icon.svelte';

  // The multi-selection's actions (music spec C3): a floating material bar while track rows are selected. Escape
  // or a new page clears the selection.
  const items = $derived(selection.items);
  const ids = $derived(items.map((x) => x.Id));
  const serverId = $derived(items[0]?.ServerId);
  const label = $derived(t('music.selection.count', { count: items.length }));

  $effect(() => {
    if (!items.length) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && (e.preventDefault(), clearSelection());
    window.addEventListener('keydown', key);
    window.addEventListener('hashchange', clearSelection);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('hashchange', clearSelection);
    };
  });

  function run(f: () => unknown): void {
    void f();
    clearSelection();
  }
</script>

{#if items.length}
  <div class="sel material" role="toolbar" aria-label={t('music.selection.label')} data-selection-bar>
    <span class="count callout" aria-live="polite" data-count={items.length}>{label}</span>
    <button class="btn light" data-sel="play" onclick={() => run(() => playTracks(ids, 0, serverId))}><Icon name="play" size={14} fill stroke={0} />{t('music.actions.play')}</button>
    <button class="btn ghost" data-sel="next" onclick={() => run(() => queueIds(ids, serverId, 'next', label))}><Icon name="playNext" size={16} />{t('music.actions.playNext')}</button>
    <button class="btn ghost" data-sel="last" onclick={() => run(() => queueIds(ids, serverId, 'last', label))}><Icon name="queue" size={16} />{t('music.actions.addToQueue')}</button>
    <button class="btn ghost" data-sel="playlist" onclick={() => run(() => ((musicUi.addIds = ids), (musicUi.addTo = items[0])))}><Icon name="listPlus" size={16} />{t('music.actions.addToPlaylist')}</button>
    <button class="btn ghost icon" title={t('music.selection.clear')} aria-label={t('music.selection.clear')} onclick={clearSelection}><Icon name="close" size={14} /></button>
  </div>
{/if}

<style>
  .sel {
    position: fixed;
    left: 50%;
    bottom: 104px;
    z-index: 35;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 6px 6px 16px;
    border-radius: var(--r-lg);
    background: var(--material-thick);
    box-shadow:
      var(--shadow-2),
      inset 0 0 0 1px var(--hairline);
    transform: translateX(-50%);
    animation: rise var(--t-med) var(--spring) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 12px);
    }
  }
  .count {
    margin-right: 8px;
    white-space: nowrap;
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .btn {
    gap: 6px;
    white-space: nowrap;
  }
</style>
