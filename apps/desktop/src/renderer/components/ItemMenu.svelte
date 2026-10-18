<script lang="ts">
  import { tick } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import type { Kind } from '../lib/playlists';
  import AddToSheet from './AddToSheet.svelte';
  import Icon from './Icon.svelte';
  import ItemAdmin from '../admin/item/ItemAdmin.svelte';
  import { adminEntries, comicCoverToServer, type AdminAction } from '../admin/item/metadata';
  import { apiFor, markPlayed, playQueueFor, previousEpisodes } from '../lib/api';
  import { openCastPicker } from '../lib/cast.svelte';
  import { t } from '../lib/i18n.svelte';
  import { queue, queueModes } from '../lib/queue.svelte';
  import { resumeAt } from '../lib/resume.svelte';
  import { errorMessage, sessionFor, toast } from '../lib/stores.svelte';
  import { caps } from '../../shared/server-caps';

  // The item page's "…" button: secondary actions that do not earn a button. `compact`: the small one over a
  // home card, which also opens on right-click (`open` is bindable); `onremove` adds "Retirer de Continuer à regarder".
  let { item, onremove, compact = false, open = $bindable(false) }: { item: BaseItem; onremove?: () => void; compact?: boolean; open?: boolean } = $props();

  const PLAYLISTABLE = ['Movie', 'Episode', 'Series', 'Season', 'Video', 'MusicVideo', 'Audio', 'MusicAlbum', 'Trailer'];
  const COLLECTABLE = ['Movie', 'Series', 'Video', 'MusicVideo', 'MusicAlbum', 'Book', 'Trailer'];

  let sheet = $state<Kind | null>(null);
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  // Admins of the item's server: metadata, artwork, refresh, subtitles, delete.
  let admin = $state<AdminAction | null>(null);
  // Over a card the menu only removes (the shelf clips anything taller); the item page has the rest.
  const adminActions = $derived(compact ? [] : adminEntries(item));

  // A file source keeps its items local: no cast, no server playlists or collections.
  const can = $derived(caps(sessionFor(item.ServerId)?.server.kind));
  const actions = $derived(
    compact ? [] : [
      can.castSend && [...PLAYLISTABLE, 'TvChannel'].includes(item.Type) && { kind: 'cast' as const, label: t('cast.picker.title'), icon: 'cast' as const },
      queueModes(item).includes('next') && { kind: 'next' as const, label: t('item.menu.playNext'), icon: 'playNext' as const },
      queueModes(item).includes('last') && { kind: 'last' as const, label: t('item.menu.addToQueue'), icon: 'queue' as const },
      !can.localUserData && PLAYLISTABLE.includes(item.Type) && { kind: 'playlist' as const, label: t('item.menu.addToPlaylist'), icon: 'listPlus' as const },
      !can.localUserData && sessionFor(item.ServerId)?.server.kind !== 'navidrome' && COLLECTABLE.includes(item.Type) && { kind: 'collection' as const, label: t('item.menu.addToCollection'), icon: 'collection' as const },
      item.Type === 'Episode' && Boolean(item.SeriesId) && { kind: 'previous' as const, label: t('item.actions.markPreviousPlayed'), icon: 'check' as const },
    ].filter((a) => a !== false),
  );

  async function markPrevious(): Promise<void> {
    try {
      const all = await apiFor(item.ServerId).episodes(item.SeriesId!);
      await markPlayed(previousEpisodes(all.Items, item), true, item.ServerId);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  // "Lire sur…": the item's queue, from the resume point the resume prompt picks.
  function castItem(): void {
    openCastPicker({
      itemId: item.Id,
      serverId: item.ServerId,
      options: async () => {
        const q = await playQueueFor(item);
        const at = q.itemIds[q.startIndex] === item.Id ? await resumeAt(item.UserData?.PlaybackPositionTicks, item.Name) : undefined;
        return at === null ? null : { itemIds: q.itemIds, startIndex: q.startIndex, positionTicks: at };
      },
    });
  }

  async function coverToServer(): Promise<void> {
    try {
      await comicCoverToServer(item);
      toast('success', t('adminMetadata.comicCover.done'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function toggle(): void {
    open = !open;
  }

  // Focus the first entry however the menu opened (button, or right-click on the card).
  $effect(() => {
    if (open) void tick().then(() => root?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
  });

  function close(refocus = true): void {
    open = false;
    if (refocus) trigger?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !root?.contains(e.target as Node) && close(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  });
</script>

{#if actions.length + adminActions.length > 0 || onremove}
  <div class="root" class:compact bind:this={root}>
    <button class="btn icon glass" class:lg={!compact} class:open bind:this={trigger} onclick={toggle} aria-haspopup="menu" aria-expanded={open} title={t('item.menu.more')}>
      <Icon name="ellipsis" size={compact ? 15 : 18} stroke={1.9} />
    </button>
    {#if open}
      <div class="menu material" role="menu">
        {#if onremove}
          <button role="menuitem" onclick={() => (close(false), onremove())}>
            <Icon name="close" size={16} />
            {t('item.menu.removeFromContinue')}
          </button>
          {#if actions.length + adminActions.length}<div class="sep" role="separator"></div>{/if}
        {/if}
        {#each actions as a (a.kind)}
          <button
            role="menuitem"
            onclick={() => {
              close(false);
              if (a.kind === 'previous') void markPrevious();
              else if (a.kind === 'cast') castItem();
              else if (a.kind === 'next' || a.kind === 'last') void queue(item, a.kind);
              else sheet = a.kind;
            }}
          >
            <Icon name={a.icon} size={16} />
            {a.label}
          </button>
        {/each}
        {#if adminActions.length && actions.length}<div class="sep" role="separator"></div>{/if}
        {#each adminActions as a (a.kind)}
          <button role="menuitem" class:danger={a.kind === 'delete'} onclick={() => (close(false), a.kind === 'comicCover' ? void coverToServer() : (admin = a.kind))}>
            <Icon name={a.icon} size={16} />
            {t(`adminMetadata.menu.${a.kind}`)}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <AddToSheet kind={sheet} {item} onclose={() => (sheet = null)} />
  <ItemAdmin action={admin} {item} onclose={() => (admin = null)} />
{/if}

<style>
  .root {
    position: relative;
  }
  /* Same glass as the item page's other round buttons (their style is scoped there). */
  .glass {
    background: rgb(255 255 255 / 0.16);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .glass:hover,
  .glass:focus-visible,
  .glass.open {
    background: rgb(255 255 255 / 0.24);
  }
  .glass:focus-visible {
    transform: scale(1.05);
  }
  /* Over a home card: top right, shown while the card is hovered or holds focus (Home.svelte). */
  .compact {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
  }
  .compact .btn {
    width: 30px;
    height: 30px;
  }
  .compact .menu {
    left: auto;
    right: 0;
    transform-origin: top right;
  }
  .menu {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 20;
    min-width: 240px;
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    box-shadow:
      var(--shadow-2),
      inset 0 0 0 1px var(--hairline);
    transform-origin: top left;
    animation: pop var(--t-med) var(--spring) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.94) translate3d(0, -4px, 0);
    }
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 34px;
    padding: 0 12px 0 10px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    white-space: nowrap;
    color: var(--label);
  }
  .menu button :global(svg) {
    color: var(--label-2);
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--fill-3);
  }
  .menu button.danger {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    margin: 5px 8px;
    background: var(--separator);
  }
</style>
