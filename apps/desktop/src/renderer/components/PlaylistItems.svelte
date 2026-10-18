<script lang="ts">
  import type { BaseItem } from '../../shared/models';
  import { w } from '../lib/bridge';
  import { episodeCode, runtime } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { posterUrl, thumbUrl } from '../lib/images';
  import { entries, move, remove, type PlaylistEntry } from '../lib/playlists';
  import { dataVersion, errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';

  // A playlist's entries: play from any row, remove, drag to reorder. Entries
  // are addressed by PlaylistItemId (the same item may appear twice).
  let { playlist }: { playlist: BaseItem } = $props();

  let list = $state<PlaylistEntry[] | null>(null);
  let dragging = $state<number | null>(null);
  let over = $state<number | null>(null);

  async function load(): Promise<void> {
    try {
      list = (await entries(playlist.Id, playlist.ServerId)).Items;
    } catch (err) {
      list = [];
      toast('error', errorMessage(err));
    }
  }

  $effect(() => {
    void playlist.Id;
    void dataVersion.library;
    void load();
  });

  async function play(index: number): Promise<void> {
    if (!list) return;
    try {
      await w.playback.play({ itemIds: list.map((e) => e.Id), startIndex: index, serverId: playlist.ServerId });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function drop(entry: PlaylistEntry): Promise<void> {
    if (!list || !entry.PlaylistItemId) return;
    const before = list;
    list = list.filter((e) => e !== entry);
    try {
      await remove(playlist.Id, entry.PlaylistItemId, playlist.ServerId);
      toast('success', t('browse.playlist.removed', { name: entry.Name }));
    } catch (err) {
      list = before;
      toast('error', errorMessage(err));
    }
  }

  async function reorder(from: number, to: number): Promise<void> {
    if (!list || from === to) return;
    const entry = list[from];
    if (!entry?.PlaylistItemId) return;
    const before = list;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, entry);
    list = next;
    try {
      await move(playlist.Id, entry.PlaylistItemId, to, playlist.ServerId);
    } catch (err) {
      list = before;
      toast('error', errorMessage(err));
    }
  }

  function sub(e: BaseItem): string {
    if (e.Type === 'Episode') return [e.SeriesName, episodeCode(e)].filter(Boolean).join(' · ');
    if (e.Type === 'Audio') return e.Artists?.join(', ') ?? e.Album ?? '';
    return e.ProductionYear ? String(e.ProductionYear) : '';
  }
</script>

{#if list && list.length > 0}
  <section class="entries" aria-label={t('browse.playlist.label')}>
    {#each list as e, i (e.PlaylistItemId ?? e.Id)}
      {@const art = thumbUrl(e, 200) ?? posterUrl(e, 120)}
      <div
        class="entry"
        class:dragging={dragging === i}
        class:over={over === i && dragging !== null && dragging !== i}
        role="listitem"
        draggable="true"
        ondragstart={(ev) => {
          dragging = i;
          ev.dataTransfer?.setData('text/plain', String(i));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        }}
        ondragover={(ev) => {
          if (dragging === null) return;
          ev.preventDefault();
          over = i;
        }}
        ondrop={(ev) => {
          ev.preventDefault();
          if (dragging !== null) void reorder(dragging, i);
          dragging = over = null;
        }}
        ondragend={() => (dragging = over = null)}
      >
        <span class="grip" aria-hidden="true"><Icon name="grip" size={16} /></span>
        <button class="main" onclick={() => play(i)}>
          <span class="art">{#if art}<img src={art} alt="" loading="lazy" decoding="async" draggable="false" />{/if}<span class="hover"><Icon name="play" size={14} fill stroke={0} /></span></span>
          <span class="text">
            <span class="name">{e.Name}</span>
            {#if sub(e)}<span class="sub">{sub(e)}</span>{/if}
          </span>
          <span class="rt">{runtime(e.RunTimeTicks)}</span>
        </button>
        {#if e.PlaylistItemId}
          <button class="remove" onclick={() => drop(e)} title={t('browse.playlist.remove')} aria-label={t('browse.playlist.removeNamed', { name: e.Name })}>
            <Icon name="trash" size={16} />
          </button>
        {/if}
      </div>
    {/each}
  </section>
{:else if list}
  <p class="empty footnote">{t('browse.playlist.empty')}</p>
{/if}

<style>
  .entries {
    margin: 0 var(--gutter) 28px;
    padding: 6px;
    border-radius: var(--r-lg);
    background: var(--fill-1);
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--r-sm);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .entry + .entry {
    box-shadow: 0 -1px 0 var(--separator);
  }
  .entry.dragging {
    opacity: 0.4;
  }
  .entry.over {
    background: var(--fill-2);
    transform: translate3d(0, 2px, 0);
  }
  .grip {
    display: grid;
    place-items: center;
    width: 26px;
    color: var(--label-3);
    cursor: grab;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px 8px 4px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .main:hover,
  .main:focus-visible {
    background: var(--fill-2);
  }
  .art {
    position: relative;
    width: 96px;
    aspect-ratio: 16 / 9;
    flex: none;
    overflow: hidden;
    border-radius: var(--r-xs);
    background: var(--fill-2);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .hover {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.45);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .main:hover .hover,
  .main:focus-visible .hover {
    opacity: 1;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 560;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub,
  .rt {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .remove {
    width: 36px;
    height: 36px;
    flex: none;
    display: grid;
    place-items: center;
    margin-right: 4px;
    border-radius: 50%;
    color: var(--label-3);
  }
  .remove:hover,
  .remove:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .empty {
    margin: 0 var(--gutter) 28px;
  }
</style>
