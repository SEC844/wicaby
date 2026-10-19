<script lang="ts">
  // Android TV AlphaRail (ui/AlphaRail.kt): the A–Z jump rail beside a library grid sorted by name. '#' and A–Z,
  // letters without items dimmed and skipped. Reachable only through enter() (the grid sends Left from its first
  // column): Down from the tab bar or Up from the grid never land in it. Up/Down move between letters and onbrowse
  // scrolls the grid there; OK or Right onpick that letter; Left is a dead end; Back is the grid's (onleave).
  import { onMount } from 'svelte';
  import { focusable, setFocus } from '../lib/focus';
  import { LETTERS, next } from '../lib/letter-index';

  let {
    offsets,
    onbrowse,
    onpick,
  }: { offsets: number[]; onbrowse: (i: number) => void; onpick: (i: number) => void } = $props();

  let rail: HTMLDivElement;
  let armed = $state(false);
  let focusedIndex = $state(-1);

  function letter(i: number): HTMLElement | null {
    return rail?.querySelector(`[data-letter="${i}"]`) ?? null;
  }

  // Arms the rail and focuses letter [i]; false when that letter cannot take it.
  export function enter(i: number): boolean {
    armed = true;
    // The letters become focusable on the next render.
    requestAnimationFrame(() => {
      const el = letter(i);
      if (el) setFocus(el);
      else armed = false;
    });
    return true;
  }

  export function holdsFocus(): boolean {
    return focusedIndex >= 0;
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    if (focusedIndex < 0) return;
    e.preventDefault();
    if (e.detail === 'right') onpick(focusedIndex);
    else if (e.detail === 'up' || e.detail === 'down') {
      const j = next(offsets, focusedIndex, e.detail === 'down' ? 1 : -1);
      if (j !== focusedIndex) setFocus(letter(j));
    }
  }

  onMount(() => {
    // Leaving the rail (for the grid) disarms it.
    const track = (e: Event) => {
      const el = e.target as HTMLElement;
      const i = rail.contains(el) ? Number(el.getAttribute('data-letter')) : -1;
      focusedIndex = i;
      if (i >= 0) onbrowse(i);
      else armed = false;
    };
    document.addEventListener('tvfocus', track);
    return () => document.removeEventListener('tvfocus', track);
  });
</script>

<!-- 15 dp letters: all 27 fit a 540 dp screen with the rail's 16 dp margins (Android's min(15 dp, …) is 15 there). -->
<div class="rail" bind:this={rail} data-focus-disabled={armed ? undefined : ''} ontvmove={onmove} aria-label="A–Z">
  {#each LETTERS.split('') as ch, i (ch)}
    {#if offsets[i] >= 0}
      <button class="letter has" class:on={focusedIndex === i} data-letter={i} use:focusable onclick={() => onpick(i)}>{ch}</button>
    {:else}
      <span class="letter">{ch}</span>
    {/if}
  {/each}
  {#if focusedIndex >= 0}
    <div class="big t-large-title" style="transform:translate3d(0,{15 * focusedIndex - 24}rem,0)">{LETTERS[focusedIndex]}</div>
  {/if}
</div>

<style>
  .rail {
    position: absolute;
    left: 12rem;
    top: 50%;
    width: 28rem;
    margin-top: -202.5rem; /* 27 letters × 15 dp, centred */
    z-index: 2;
  }
  .letter {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28rem;
    height: 15rem;
    font-size: 10rem;
    font-weight: 600;
    letter-spacing: 0.04rem;
    color: rgba(235, 235, 245, 0.06);
  }
  .letter.has {
    color: var(--label-2);
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), color var(--t-fast);
  }
  .letter.on {
    color: var(--accent);
    transform: scale(1.45);
  }
  .big {
    position: absolute;
    top: 0;
    left: 40rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64rem;
    height: 64rem;
    border-radius: var(--r-lg);
    background: rgba(28, 28, 31, 0.95);
    color: var(--accent);
    animation: fade var(--t-fast) var(--ease-out);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
