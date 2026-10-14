<script lang="ts">
  import { TICKS_PER_MS } from '../../../shared/contract';
  import type { BaseItem } from '../../../shared/models';
  import { formatDuration } from '../../../shared/music';
  import { t } from '../../lib/i18n.svelte';
  import { dragTracks, featured, openTrackMenu, playTracks, selection, selectRow, toggleFavorite } from '../../lib/music-ui.svelte';
  import { playback } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';

  // An album's tracks (music-spec §4.3): disc headers when the album has several, the count and total length,
  // a heart and a menu per row, and the playing row marked with a static glyph.
  // plain: a list of tracks from several albums (an artist's top songs): no discs, no summary, numbered in order.
  let { album, tracks, serverId, plain = false }: { album: BaseItem; tracks: BaseItem[]; serverId?: string; plain?: boolean } = $props();

  const discs = $derived(!plain && new Set(tracks.map((tr) => tr.ParentIndexNumber ?? 1)).size > 1);
  const totalMs = $derived(tracks.reduce((s, tr) => s + (tr.RunTimeTicks ?? 0), 0) / TICKS_PER_MS);
  const playingId = $derived(playback.value?.active && playback.value.music ? playback.value.item?.id : undefined);
  // Multi-select and drag (music spec C3): Ctrl/Shift-click selects, a row drags the selection it is in.
  const listKey = $derived(`${album.Id}:${plain ? 'top' : 'tracks'}`);
  const selected = $derived(new Set(selection.list === listKey ? selection.items.map((x) => x.Id) : []));
  const discOf = (tr: BaseItem) => tr.ParentIndexNumber ?? 1;
</script>

{#if !plain}<p class="summary footnote">{t('music.album.summary', { count: tracks.length, duration: formatDuration(totalMs) })}</p>{/if}
<section class="tracks" role="grid" aria-multiselectable="true">
  {#each tracks as track, i (track.Id)}
    {@const fav = Boolean(track.UserData?.IsFavorite)}
    {@const extra = featured(track, album.AlbumArtist ?? (album.Type === 'MusicArtist' ? album.Name : undefined))}
    {#if discs && (i === 0 || discOf(tracks[i - 1]) !== discOf(track))}
      <div class="disc">
        <h3 class="headline" data-disc={discOf(track)}>{t('music.album.disc', { n: discOf(track) })}</h3>
        <button
          class="icon-btn"
          data-play-disc={discOf(track)}
          title={t('music.actions.playDisc', { n: discOf(track) })}
          aria-label={t('music.actions.playDisc', { n: discOf(track) })}
          onclick={() => playTracks(tracks.filter((tr) => discOf(tr) === discOf(track)).map((tr) => tr.Id), 0, serverId)}
        >
          <Icon name="play" size={13} fill stroke={0} />
        </button>
      </div>
    {/if}
    <div
      class="row"
      class:playing={playingId === track.Id}
      class:selected={selected.has(track.Id)}
      role="row"
      tabindex="-1"
      aria-selected={selected.has(track.Id)}
      draggable="true"
      ondragstart={(e) => dragTracks(e, listKey, track)}
      oncontextmenu={(e) => openTrackMenu(track, e, e.currentTarget.querySelector('.more'))}
    >
      <button class="track" data-id={track.Id} aria-current={playingId === track.Id ? 'true' : undefined} onclick={(e) => selectRow(listKey, tracks, track, e) || playTracks(tracks.map((tr) => tr.Id), i, serverId)} onkeydown={(e) => e.key === ' ' && selectRow(listKey, tracks, track, e)}>
        <span class="num">
          {#if playingId === track.Id}<Icon name="equalizer" size={15} stroke={2.2} />{:else}{plain ? i + 1 : (track.IndexNumber ?? i + 1)}{/if}
        </span>
        <span class="t-play"><Icon name="play" size={13} fill stroke={0} /></span>
        <span class="t-name">
          {track.Name}
          {#if extra}<span class="t-artist"> · {extra}</span>{/if}
        </span>
        <span class="t-rt">{track.RunTimeTicks ? formatDuration(track.RunTimeTicks / TICKS_PER_MS) : ''}</span>
      </button>
      <button class="icon-btn fav" class:on={fav} aria-pressed={fav} title={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} aria-label={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} onclick={() => toggleFavorite(track)}>
        <Icon name="heart" size={14} fill={fav} stroke={fav ? 0 : 1.9} />
      </button>
      <button class="icon-btn more" aria-haspopup="menu" title={t('music.actions.more', { name: track.Name })} aria-label={t('music.actions.more', { name: track.Name })} onclick={(e) => openTrackMenu(track, e, e.currentTarget)}>
        <Icon name="ellipsis" size={16} />
      </button>
    </div>
  {/each}
</section>

<style>
  .summary {
    margin: -8px var(--gutter) 10px;
    color: var(--label-3);
  }
  .tracks {
    display: flex;
    flex-direction: column;
    margin: 0 var(--gutter) 28px;
    padding: 6px;
    border-radius: var(--r-lg);
    background: var(--fill-1);
  }
  .disc {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 14px 14px 6px;
    color: var(--label-2);
  }
  .disc h3 {
    margin: 0;
  }
  .disc:first-child {
    margin-top: 8px;
  }
  .disc .icon-btn {
    width: 28px;
    height: 28px;
  }
  .row.selected,
  .row.selected:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .row {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    border-radius: var(--r-sm);
    transition: background-color var(--t-fast) var(--ease);
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 58px;
    right: 14px;
    height: 1px;
    background: var(--separator);
  }
  .row:hover,
  .row:focus-within {
    background: var(--fill-2);
  }
  .row:hover::before,
  .row:hover + .row::before {
    opacity: 0;
  }
  .track {
    position: relative;
    display: grid;
    grid-template-columns: 30px 1fr auto;
    align-items: center;
    gap: 14px;
    height: 44px;
    padding: 0 6px 0 14px;
    border-radius: var(--r-sm);
    text-align: left;
    min-width: 0;
  }
  .num {
    display: grid;
    place-items: center;
    color: var(--label-3);
    font-size: var(--fs-callout);
    font-variant-numeric: tabular-nums;
  }
  .playing .num,
  .playing .t-name {
    color: var(--accent);
  }
  .t-play {
    position: absolute;
    left: 22px;
    display: grid;
    opacity: 0;
    color: var(--label);
  }
  .track:hover .num,
  .track:focus-visible .num {
    opacity: 0;
  }
  .track:hover .t-play,
  .track:focus-visible .t-play {
    opacity: 1;
  }
  .t-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .t-artist {
    color: var(--label-3);
  }
  .t-rt {
    color: var(--label-3);
    font-family: var(--font-mono);
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
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
  .fav.on {
    color: var(--label-2);
  }
  .more {
    margin-right: 6px;
  }
</style>
