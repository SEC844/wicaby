<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../lib/i18n.svelte';
  import { cardMenu, queue, queueModes, type QueueMode } from '../lib/queue.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  // A card's right-click (or menu key) menu: play next, add to queue, shuffle.
  const LABELS: Record<QueueMode, { key: string; icon: IconName }> = {
    next: { key: 'item.menu.playNext', icon: 'playNext' },
    last: { key: 'item.menu.addToQueue', icon: 'queue' },
    shuffle: { key: 'common.actions.shuffle', icon: 'shuffle' },
  };

  let root = $state<HTMLDivElement>();
  const m = $derived(cardMenu.value);
  // Kept inside the window (menu ~240 x 3 rows).
  const left = $derived(m ? Math.max(8, Math.min(m.x, window.innerWidth - 256)) : 0);
  const top = $derived(m ? Math.max(8, Math.min(m.y, window.innerHeight - 140)) : 0);

  function close(refocus = true): void {
    const from = cardMenu.value?.from;
    cardMenu.value = null;
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
  <div class="menu material" role="menu" aria-label={m.item.Name} bind:this={root} style:left="{left}px" style:top="{top}px">
    {#each queueModes(m.item) as mode (mode)}
      <button
        role="menuitem"
        onclick={() => {
          const item = m.item;
          close();
          void queue(item, mode);
        }}
      >
        <Icon name={LABELS[mode].icon} size={16} />
        {t(LABELS[mode].key)}
      </button>
    {/each}
  </div>
{/if}

<style>
  /* Same material menu as ItemMenu, fixed at the pointer. */
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 220px;
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
