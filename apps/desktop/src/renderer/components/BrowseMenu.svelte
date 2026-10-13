<script lang="ts" module>
  export interface MenuOption {
    value: string;
    label: string;
    checked?: boolean;
    // Draw a separator (and optional section title) above this option.
    section?: string | true;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  let {
    label,
    icon,
    options,
    onselect,
    align = 'start',
    active = false,
  }: { label: string; icon?: IconName; options: MenuOption[]; onselect: (value: string) => void; align?: 'start' | 'end'; active?: boolean } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  async function toggle(): Promise<void> {
    open = !open;
    if (!open) return;
    await tick();
    (root?.querySelector<HTMLElement>('[aria-checked="true"]') ?? root?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus({ preventScroll: true });
  }

  function close(refocus = true): void {
    open = false;
    if (refocus) button?.focus({ preventScroll: true });
  }

  function pick(v: string): void {
    onselect(v);
    close();
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

<div class="menu-root" bind:this={root}>
  <button class="btn trigger" class:active class:open bind:this={button} onclick={toggle} aria-haspopup="menu" aria-expanded={open}>
    {#if icon}<Icon name={icon} size={15} stroke={2} />{/if}
    <span class="label">{label}</span>
    <span class="chev"><Icon name="chevronDown" size={13} stroke={2.4} /></span>
  </button>
  {#if open}
    <div class="menu material" class:end={align === 'end'} role="menu">
      {#each options as o (o.value)}
        {#if o.section}
          <div class="sep" role="separator"></div>
          {#if typeof o.section === 'string'}<div class="section">{o.section}</div>{/if}
        {/if}
        <button class="opt" role="menuitemradio" aria-checked={Boolean(o.checked)} onclick={() => pick(o.value)}>
          <span class="tick">{#if o.checked}<Icon name="check" size={14} stroke={2.6} />{/if}</span>
          {o.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu-root {
    position: relative;
  }
  .trigger {
    gap: 6px;
    padding: 0 12px 0 14px;
  }
  .trigger.active {
    background: var(--fill-3);
    color: var(--label);
  }
  .label {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chev {
    display: grid;
    color: var(--label-3);
    transition: transform var(--t-med) var(--spring);
  }
  .active .chev {
    color: inherit;
  }
  .open .chev {
    transform: rotate(180deg);
  }
  .menu {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 20;
    min-width: 220px;
    max-height: min(420px, 60vh);
    overflow-y: auto;
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    box-shadow: var(--shadow-2), inset 0 0 0 1px var(--hairline);
    transform-origin: top left;
    animation: pop var(--t-med) var(--spring) both;
  }
  .menu.end {
    left: auto;
    right: 0;
    transform-origin: top right;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.94) translate3d(0, -4px, 0);
    }
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 32px;
    padding: 0 12px 0 6px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    white-space: nowrap;
    color: var(--label);
  }
  .opt:hover,
  .opt:focus-visible {
    background: var(--fill-3);
    box-shadow: none;
    border-radius: var(--r-xs);
  }
  .tick {
    display: grid;
    place-items: center;
    width: 18px;
  }
  .sep {
    height: 1px;
    margin: 6px 8px;
    background: var(--separator);
  }
  .section {
    padding: 4px 12px 4px 30px;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--label-3);
  }
</style>
