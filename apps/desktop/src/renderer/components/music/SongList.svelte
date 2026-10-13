<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { TICKS_PER_MS, type Query } from '../../../shared/contract';
  import type { BaseItem } from '../../../shared/models';
  import { formatDuration } from '../../../shared/music';
  import { t } from '../../lib/i18n.svelte';
  import { songs } from '../../lib/music';
  import { openTrackMenu, playTracks, toggleFavorite } from '../../lib/music-ui.svelte';
  import { errorMessage, playback, toast } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';

  // The Songs tab (music-spec §4.3): a windowed list, 44 px text-only rows (no art to decode while scrolling), only the rows near the viewport in the DOM and
  // only their pages fetched (100 at a time), so a 100,000-song library scrolls like a 40-row one.
  let { parentId, query = {}, serverId }: { parentId: string; query?: Query; serverId?: string } = $props();

  const ROW = 44;
  const PAGE = 100;
  const OVERSCAN = 8;
  let total = $state(-1);
  // Loaded rows by index, outside the reactive graph (a page lands without copying the others); version repaints.
  const rows = new Map<number, BaseItem>();
  let version = $state(0);
  const pages = new Set<number>();
  let first = $state(0);
  let last = $state(30);
  let host = $state<HTMLDivElement>();
  let generation = 0;
  const playingId = $derived(playback.value?.active && playback.value.music ? playback.value.item?.id : undefined);

  async function page(n: number): Promise<void> {
    if (pages.has(n)) return;
    pages.add(n);
    const gen = generation;
    try {
      // Only what a row shows (no overviews, provider ids…): lighter pages for big libraries.
      const r = await songs(parentId, { Fields: 'ParentId', EnableImageTypes: 'Primary', ImageTypeLimit: 1, ...query, StartIndex: n * PAGE, Limit: PAGE }, serverId);
      if (gen !== generation) return;
      r.Items.forEach((it, i) => rows.set(n * PAGE + i, it));
      version++;
      total = r.TotalRecordCount;
    } catch (err) {
      pages.delete(n);
      if (gen === generation) toast('error', errorMessage(err));
    }
  }

  function measure(): void {
    const scroller = document.getElementById('main-scroller');
    if (!scroller || !host) return;
    const top = host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const y = scroller.scrollTop - top;
    const count = Math.max(total, 0);
    first = Math.max(0, Math.floor(y / ROW) - OVERSCAN);
    last = Math.min(count, Math.ceil((y + scroller.clientHeight) / ROW) + OVERSCAN);
    // Half a page ahead, so a steady scroll rarely meets a skeleton row.
    for (let p = Math.floor(first / PAGE); p * PAGE < Math.min(Math.max(last + PAGE / 2, 1), Math.max(count, 1)); p++) void page(p);
  }

  // A new filter or sort: start over.
  $effect(() => {
    void parentId;
    void JSON.stringify(query);
    untrack(() => {
      generation++;
      pages.clear();
      rows.clear();
      version++;
      total = -1;
      void page(0).then(measure);
    });
  });

  onMount(() => {
    const scroller = document.getElementById('main-scroller');
    // Chromium fires scroll once per frame: the window moves in the same frame, never one behind.
    const onScroll = () => measure();
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    if (scroller) ro.observe(scroller);
    return () => {
      scroller?.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  });

  const visible = $derived(Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k));

  // Plays from this row through the loaded rows that follow it (at most 500).
  function play(i: number): void {
    const ids: string[] = [];
    for (let k = i; rows.has(k) && ids.length < 500; k++) ids.push(rows.get(k)!.Id);
    void playTracks(ids, 0, serverId);
  }
</script>

<div class="head caption" aria-hidden="true">
  <span class="c-num">{t('music.columns.number')}</span>
  <span>{t('music.columns.title')}</span>
  <span>{t('music.columns.album')}</span>
  <span class="c-rt">{t('music.columns.duration')}</span>
  <span></span>
</div>
{#if total === 0}
  <p class="empty footnote">{t('music.empty.tab')}</p>
{/if}
<div class="list" role="list" bind:this={host} style:height="{Math.max(total, 0) * ROW}px" data-total={total}>
  {#each visible as i (i)}
    {@const it = (void version, rows.get(i))}
    <div class="row" role="listitem" class:playing={it && playingId === it.Id} style:transform="translateY({i * ROW}px)" oncontextmenu={(e) => it && openTrackMenu(it, e, e.currentTarget.querySelector('.more'))}>
      {#if it}
        {@const fav = Boolean(it.UserData?.IsFavorite)}
        <button class="main" data-id={it.Id} onclick={() => play(i)}>
          <span class="c-num">{#if playingId === it.Id}<Icon name="equalizer" size={14} stroke={2.2} />{:else}{i + 1}{/if}</span>
          <span class="name">
            <span class="txt"><span class="t">{it.Name}</span><span class="a">{(it.Artists ?? []).join(', ')}</span></span>
          </span>
          <span class="album">{it.Album ?? ''}</span>
          <span class="c-rt">{it.RunTimeTicks ? formatDuration(it.RunTimeTicks / TICKS_PER_MS) : ''}</span>
        </button>
        <button class="icon-btn" class:on={fav} aria-pressed={fav} aria-label={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} onclick={() => toggleFavorite(it)}>
          <Icon name="heart" size={14} fill={fav} stroke={fav ? 0 : 1.9} />
        </button>
        <button class="icon-btn more" aria-haspopup="menu" aria-label={t('music.actions.more', { name: it.Name })} onclick={(e) => openTrackMenu(it, e, e.currentTarget)}>
          <Icon name="ellipsis" size={16} />
        </button>
      {:else}
        <span class="sk skeleton" aria-hidden="true"></span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .head,
  .main {
    display: grid;
    grid-template-columns: 44px minmax(0, 2fr) minmax(0, 1.2fr) 64px;
    align-items: center;
    gap: 12px;
  }
  .head {
    margin: 0 var(--gutter);
    padding: 0 82px 6px 8px;
    color: var(--label-3);
    border-bottom: 1px solid var(--separator);
  }
  .list {
    position: relative;
    margin: 4px var(--gutter) 0;
    contain: strict;
    width: calc(100% - 2 * var(--gutter));
  }
  .row {
    position: absolute;
    inset: 0 0 auto 0;
    height: 44px;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    border-radius: var(--r-sm);
  }
  .row:hover,
  .row:focus-within {
    background: var(--fill-2);
  }
  .main {
    height: 44px;
    padding: 0 0 0 8px;
    text-align: left;
    min-width: 0;
    border-radius: var(--r-sm);
  }
  .c-num {
    text-align: center;
    color: var(--label-3);
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
    display: grid;
    place-items: center;
  }
  .c-rt {
    font-family: var(--font-mono);
    font-size: var(--fs-footnote);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .t,
  .a,
  .album {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 500;
  }
  .a,
  .album {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .playing .t,
  .playing .c-num {
    color: var(--accent);
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--r-xs);
    color: var(--label-3);
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    color: var(--label);
    background: var(--fill-3);
  }
  .icon-btn.on {
    color: var(--label-2);
  }
  .more {
    margin-right: 6px;
  }
  .sk {
    grid-column: 1 / -1;
    height: 12px;
    width: 40%;
    margin-left: 64px;
    border-radius: 4px;
  }
  .empty {
    margin: 24px var(--gutter);
    color: var(--label-3);
  }
</style>
