<script lang="ts" module>
  // Open sheet layers, oldest first: only the top one takes keys and focus.
  const stack: HTMLElement[] = [];

  // A real focus trap for aria-modal: the page and every sheet under the top one go inert.
  function sync(): void {
    document.getElementById('app')?.toggleAttribute('inert', stack.length > 0);
    stack.forEach((l, i) => l.toggleAttribute('inert', i < stack.length - 1));
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';

  // Modal sheet: a material panel over a dim scrim. Lives on <body> so no
  // scroller, containment or stacking context clips it.
  let {
    open,
    onclose,
    label,
    width = 520,
    align = 'center',
    onback,
    children,
  }: {
    open: boolean;
    onclose: () => void;
    label: string;
    width?: number;
    // 'top' pins the top edge, for a sheet whose height changes from step to step.
    align?: 'center' | 'top';
    // Back (gamepad B, BrowserBack, Backspace) goes one step back when given; Escape always closes.
    onback?: () => void;
    children: Snippet;
  } = $props();

  let panel = $state<HTMLDivElement>();
  let layer: HTMLElement | null = null;

  function portal(node: HTMLElement) {
    const opener = document.activeElement as HTMLElement | null;
    document.body.appendChild(node);
    layer = node;
    stack.push(node);
    sync();
    return {
      destroy: () => {
        node.remove();
        stack.splice(stack.indexOf(node), 1);
        sync();
        // After lifting inert, or the opener cannot take focus back.
        opener?.focus({ preventScroll: true });
      },
    };
  }

  $effect(() => {
    if (!open) return;
    void tick().then(() => (panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>('button:not([disabled]), input'))?.focus({ preventScroll: true }));
    const key = (e: KeyboardEvent) => {
      if (stack.at(-1) !== layer) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const back = e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing);
      if (e.key === 'Escape' || back) {
        e.preventDefault();
        e.stopImmediatePropagation();
        (back && onback ? onback : onclose)();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
</script>

{#if open}
  <div class="layer" class:top={align === 'top'} use:portal>
    <div class="scrim" role="presentation" onclick={onclose}></div>
    <div class="sheet material" role="dialog" aria-modal="true" aria-label={label} bind:this={panel} style:--w="{width}px">
      {@render children()}
      <!-- After the content so the first focus lands on the sheet's own action. -->
      <button class="close" onclick={onclose} aria-label={t('common.actions.close')}><Icon name="close" size={16} /></button>
    </div>
  </div>
{/if}

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 56px 24px 24px;
  }
  .layer.top {
    place-items: start center;
    padding-top: max(56px, 12vh);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    animation: fade var(--t-med) var(--ease-out) both;
  }
  .sheet {
    position: relative;
    width: min(var(--w), 100%);
    max-height: 100%;
    overflow-y: auto;
    border-radius: var(--r-xl);
    background: var(--material-thick);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-3);
    animation: sheet-in var(--t-slow) var(--spring) both;
  }
  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translate3d(0, 16px, 0) scale(0.97);
    }
  }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 2;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label-2);
    background: var(--fill-2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .close:hover,
  .close:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
</style>
