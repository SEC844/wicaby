<script lang="ts">
  import { tick } from 'svelte';
  import { itemPath } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { musicUi, playMix, toggleFavorite } from '../../lib/music-ui.svelte';
  import { queue } from '../../lib/queue.svelte';
  import { navigate } from '../../lib/router.svelte';
  import AddToSheet from '../AddToSheet.svelte';
  import Icon, { type IconName } from '../Icon.svelte';

  // A track's menu (music-spec §4.3), from a row's "…", its right click or the menu key: drawn once at the pointer.
  let root = $state<HTMLDivElement>();
  const m = $derived(musicUi.menu);
  const left = $derived(m ? Math.max(8, Math.min(m.x, window.innerWidth - 256)) : 0);
  const top = $derived(m ? Math.max(8, Math.min(m.y, window.innerHeight - 340)) : 0);

  const actions = $derived.by(() => {
    const it = m?.item;
    if (!it) return [];
    const artist = it.ArtistItems?.[0] ?? it.AlbumArtists?.[0];
    const out: { key: string; label: string; icon: IconName; run: () => void }[] = [
      { key: 'next', label: t('music.actions.playNext'), icon: 'playNext', run: () => void queue(it, 'next') },
      { key: 'last', label: t('music.actions.addToQueue'), icon: 'queue', run: () => void queue(it, 'last') },
      { key: 'playlist', label: t('music.actions.addToPlaylist'), icon: 'listPlus', run: () => (musicUi.addTo = it) },
      { key: 'mix', label: t('music.actions.mixFromTrack'), icon: 'sparkles', run: () => void playMix(it) },
      { key: 'radio', label: t('music.radio.start'), icon: 'live', run: () => void playMix(it, true) },
    ];
    if (artist) out.push({ key: 'artist', label: t('music.actions.goToArtist'), icon: 'user', run: () => navigate(itemPath({ Id: artist.Id, ServerId: it.ServerId })) });
    if (it.AlbumId) out.push({ key: 'album', label: t('music.actions.goToAlbum'), icon: 'music', run: () => navigate(itemPath({ Id: it.AlbumId!, ServerId: it.ServerId })) });
    const fav = Boolean(it.UserData?.IsFavorite);
    out.push({ key: 'favorite', label: t(fav ? 'music.favorite.remove' : 'music.favorite.add'), icon: 'heart', run: () => void toggleFavorite(it) });
    return out;
  });

  function close(refocus = true): void {
    const from = musicUi.menu?.from;
    musicUi.menu = null;
    if (refocus) from?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!m) return;
    void tick().then(() => root?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
    const down = (e: PointerEvent) => !root?.contains(e.target as Node) && close(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const away = () => close(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', away);
    window.addEventListener('hashchange', away);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('hashchange', away);
    };
  });
</script>

{#if m}
  <div class="menu material" role="menu" aria-label={m.item.Name} bind:this={root} style:left="{left}px" style:top="{top}px" data-track-menu>
    {#each actions as a (a.key)}
      <button
        role="menuitem"
        data-action={a.key}
        onclick={() => {
          close(a.key !== 'playlist');
          a.run();
        }}
      >
        <Icon name={a.icon} size={16} />
        {a.label}
      </button>
    {/each}
  </div>
{/if}
{#if musicUi.addTo}<AddToSheet kind="playlist" item={musicUi.addTo} ids={musicUi.addIds ?? undefined} onclose={() => ((musicUi.addTo = null), (musicUi.addIds = null))} />{/if}

<style>
  /* The card menu's material, at the pointer. */
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 230px;
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
      transform: scale(0.94);
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
</style>
