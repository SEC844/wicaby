<script lang="ts" generics="T extends string | number">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';

  // Pop-up button: a quiet pill that opens a material menu with a
  // check next to the current choice. role="menu" keeps spatial nav inside it.
  let {
    value,
    options,
    onchange,
    label,
  }: { value: T; options: { value: T; label: string }[]; onchange: (value: T) => void; label?: string } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let menu = $state<HTMLDivElement>();
  const current = $derived(options.find((o) => o.value === value)?.label ?? String(value));

  async function show(): Promise<void> {
    open = true;
    await tick();
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLElement>('button'))?.focus();
  }

  function close(refocus = true): void {
    if (!open) return;
    open = false;
    if (refocus) root?.querySelector<HTMLElement>('.pill')?.focus();
  }

  // Capture phase, like the other menus: Escape or Back closes the menu only (not the page, nor a Sheet around it,
  // which leaves keys to an open menu).
  $effect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === 'Escape' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  function pick(v: T): void {
    close();
    if (v !== value) onchange(v);
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) close(false);
  }}
/>

<div class="picker" bind:this={root}>
  <button type="button" class="pill" class:open aria-haspopup="menu" aria-expanded={open} aria-label={label} onclick={() => (open ? close() : void show())}>
    <span class="cur">{current}</span>
    <svg class="chev" width="10" height="14" viewBox="0 0 10 14" aria-hidden="true"><path d="M2 5l3-3 3 3M2 9l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>
  {#if open}
    <div class="menu material" role="menu" bind:this={menu}>
      {#each options as opt (opt.value)}
        <button type="button" role="menuitemradio" aria-checked={opt.value === value} onclick={() => pick(opt.value)}>
          <span class="check">{#if opt.value === value}<Icon name="check" size={14} />{/if}</span>
          <span class="lbl">{opt.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    flex: none;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    max-width: 260px;
    padding: 0 8px 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
  }
  .pill:hover,
  .pill:focus-visible,
  .pill.open {
    background: var(--fill-3);
  }
  .cur {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    flex: none;
    color: var(--label-3);
  }
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    min-width: max(100%, 200px);
    max-height: 320px;
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--r-sm);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-2);
    animation: menu-in var(--t-fast) var(--ease-out) both;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translate3d(0, -3px, 0);
    }
  }
  .menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px 0 6px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .menu button[aria-checked='true'] {
    color: var(--label);
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .check {
    width: 18px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label);
  }
  .lbl {
    flex: 1;
    white-space: nowrap;
  }
</style>
