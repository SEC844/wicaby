<script lang="ts">
  // Android TV HistoryScreen (History.kt, TP-08): stats over the loaded history, then one row per day, newest first.
  // A card opens Play / More Info / Remove; removing marks it unplayed, which is what clears the server's last play
  // date. Rows pivot at 30 % of the screen (PivotSpec(0.3f)).
  import { daysAgo, groupByDay, watchStats } from '$shared/history';
  import type { BaseItem } from '$shared/models';
  import { itemKey } from '$desktop/items';
  import Icon from '../components/Icon.svelte';
  import MediaRow from '../components/MediaRow.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { focusFirst } from '../lib/focus';
  import { episodeLine, runtimeText, TICKS_PER_MS } from '../lib/format';
  import { loadHistory } from '../lib/history';
  import { locale, plural, t } from '../lib/i18n.svelte';
  import { changed, useLoad } from '../lib/load.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { play } from '../lib/playback';
  import { clamp, pivotDelta } from '../lib/scroll';
  import { api, apiOf, isMulti, serverName } from '../lib/session.svelte';
  import * as Trakt from '../lib/trakt.svelte';

  const load = useLoad(() => 'history', loadHistory);
  // Removed this visit: gone at once, the reload after changed() agrees.
  let removed = $state<string[]>([]);
  const items = $derived(load.value ? load.value.items.filter((i) => !removed.includes(itemKey(i))) : null);
  const groups = $derived(groupByDay(items ?? []));
  const stats = $derived(watchStats(items ?? [], load.value?.seriesGenres));
  const total = $derived(groups.reduce((n, g) => n + g.items.length, 0));
  const multi = isMulti();
  const serverLine = (i: BaseItem) => [episodeLine(i) ?? (i.ProductionYear ? String(i.ProductionYear) : undefined), serverName(i.ServerId)].filter(Boolean).join(' · ');

  const duration = (ms: number) => runtimeText(ms * TICKS_PER_MS) ?? t('duration_minutes', 0);

  // "Today", "Yesterday", then "Monday 5 October" (the year only when it is not this one), as on desktop.
  function dayLabel(day: number): string {
    const ago = daysAgo(day);
    if (ago === 0) return t('history_today');
    if (ago === 1) return t('history_yesterday');
    const sameYear = new Date(day).getFullYear() === new Date().getFullYear();
    const text = new Date(day).toLocaleDateString(locale.current, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  const title = (i: BaseItem) => (i.Type === 'Episode' && i.SeriesName ? i.SeriesName : i.Name);

  function confirmRemove(item: BaseItem): void {
    showAlert({
      title: t('history_remove_title'),
      message: t('history_remove_body', i18nName(item)),
      actions: [
        {
          label: t('history_remove'),
          destructive: true,
          run: () => {
            const key = itemKey(item);
            removed = [...removed, key];
            const a = apiOf(item.ServerId) ?? api()!;
            a.setPlayed(item.Id, false).then(
              () => {
                changed();
                // B25: its latest Trakt play goes too.
                Trakt.history(a, item, false);
              },
              () => (removed = removed.filter((r) => r !== key)),
            );
            requestAnimationFrame(() => focusFirst(page));
          },
        },
        { label: t('cancel'), run: () => {} },
      ],
      focusIndex: 1,
    });
  }

  const i18nName = (i: BaseItem) => (i.Type === 'Episode' && i.SeriesName ? `${i.SeriesName} · ${i.Name}` : i.Name);

  function menu(item: BaseItem): void {
    const resumable = (item.UserData?.PlaybackPositionTicks ?? 0) > 0;
    showAlert({
      title: title(item),
      message: episodeLine(item),
      actions: [
        { label: t(resumable ? 'resume' : 'play'), run: () => play(item) },
        { label: t('more_info'), run: () => nav.push(itemRoute(item)) },
        { label: t('history_remove'), destructive: true, run: () => requestAnimationFrame(() => confirmRemove(item)) },
      ],
    });
  }

  let page: HTMLDivElement;
  let content = $state<HTMLDivElement>();
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    const row = (e.target as HTMLElement).closest('[data-history-row]') as HTMLElement | null;
    if (!row || !content) return;
    const max = Math.max(0, content.offsetHeight - page.clientHeight);
    y = clamp(y + pivotDelta(row.offsetTop - y, page.clientHeight, 0.3), 0, max);
  }
  // First visit: focus starts on the newest card.
  let focusedOnce = false;
  $effect(() => {
    if (focusedOnce || !groups.length || !content) return;
    focusedOnce = true;
    requestAnimationFrame(() => focusFirst(content!));
  });
</script>

<div class="history" bind:this={page} ontvfocus={onfocus}>
  {#if items === null}
    <div class="center">
      {#if load.error !== undefined}<p class="t-title3 label-2">{t('load_error')}</p>{:else}<Spinner size={40} />{/if}
    </div>
  {:else if !groups.length}
    <div class="center">
      <div class="empty">
        <span class="disc"><Icon name="History" size={30} /></span>
        <p class="t-title2">{t('history_empty_title')}</p>
        <p class="t-callout label-3">{t('history_empty_body')}</p>
      </div>
    </div>
  {:else}
    <div class="content" bind:this={content} style="transform:translate3d(0,{-y}px,0)">
      <div class="head">
        <div class="title">
          <h1 class="t-large-title">{t('history')}</h1>
          <span class="t-callout label-3">{plural('items_count', total, total)}</span>
        </div>
        <div class="stats">
          <div class="stat"><span class="t-footnote label-3">{t('history_week')}</span><span class="t-title3">{duration(stats.weekMs)}</span></div>
          <div class="stat"><span class="t-footnote label-3">{t('history_month')}</span><span class="t-title3">{duration(stats.monthMs)}</span></div>
          {#if stats.genres.length}
            <div class="stat wide"><span class="t-footnote label-3">{t('history_top_genres')}</span><span class="t-callout">{stats.genres.join(', ')}</span></div>
          {/if}
        </div>
      </div>
      {#each groups as g (g.day)}
        <div data-history-row>
          <MediaRow title={dayLabel(g.day)} items={g.items} api={apiOf(g.items[0]?.ServerId) ?? api()!} wide subtitle={multi ? serverLine : undefined} onclick={menu} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .history {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: var(--bg);
  }
  .center {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 460rem;
    text-align: center;
  }
  .empty p {
    margin: 16rem 0 0;
  }
  .empty .label-3 {
    margin-top: 6rem;
  }
  .disc {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72rem;
    height: 72rem;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label-2);
  }
  .content {
    position: relative;
    padding: 44rem 0 80rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .head {
    padding: 0 48rem 6rem;
  }
  .title {
    display: flex;
    align-items: flex-end;
  }
  .title h1 {
    margin: 0 14rem 0 0;
  }
  .title span {
    padding-bottom: 6rem;
  }
  .stats {
    display: flex;
    margin-top: 16rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    min-width: 150rem;
    max-width: 220rem;
    margin-right: 12rem;
    padding: 12rem 16rem;
    border-radius: var(--r-md);
    background: var(--fill-2);
  }
  .stat.wide {
    max-width: 420rem;
  }
  .stat span + span {
    margin-top: 4rem;
  }
</style>
