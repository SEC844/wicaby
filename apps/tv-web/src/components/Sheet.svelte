<script lang="ts">
  // Android TV TvSheet (Chrome.kt): a card over the dimmed screen that keeps the focus (data-focus-trap) and closes
  // on Back. Focus goes to its first element (or its [data-autofocus] one) when it opens, back to where it was when it
  // closes. It is drawn in <body>: inside a page that scrolls by transform, `position: fixed` would follow the page
  // instead of the screen.
  import { getContext, onMount, type Snippet } from 'svelte';
  import { focusFirst, focused, setFocus } from '../lib/focus';
  import { onBack, SCREEN } from '../lib/nav.svelte';

  let { width = 460, onclose, children }: { width?: number; onclose: () => void; children: Snippet } = $props();

  let card: HTMLDivElement;
  const screen = getContext<number>(SCREEN);

  function toBody(node: HTMLElement): void {
    document.body.appendChild(node);
  }

  onMount(() => {
    const returnTo = focused();
    requestAnimationFrame(() => focusFirst(card));
    const stop = onBack(screen, () => {
      onclose();
      return true;
    });
    return () => {
      stop();
      // Only when the focus is still in the sheet: an action may have moved it on purpose.
      const now = focused();
      if (returnTo?.isConnected && (!now || !now.isConnected || card.contains(now))) setFocus(returnTo);
    };
  });
</script>

<div class="scrim" data-focus-trap use:toBody>
  <div class="card" bind:this={card} style="width:{width}rem">
    {@render children()}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.72);
  }
  .card {
    padding: 28rem;
    border-radius: var(--r-xl);
    background: var(--elevated-2);
    animation: in 220ms var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: scale(0.94);
    }
  }
</style>
