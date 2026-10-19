<script lang="ts">
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { t } from '../lib/i18n.svelte';
  import { dropToast, holdToast, releaseToast, toasts } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import { dur } from '../lib/motion';

  const ICON = { info: 'info', success: 'check', error: 'exclamation' } as const;

  // On <body>, outside #app: an open Sheet makes #app inert, and toasts must stay announced and clickable.
  const toBody = (node: HTMLElement) => void document.body.appendChild(node);

  // Pointer and focus both hold a toast: it is let go only when neither is still on it.
  function release(e: Event, id: number) {
    const el = e.currentTarget as HTMLElement;
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (e.type === 'focusout' ? !el.matches(':hover') && !el.contains(next) : !el.contains(document.activeElement)) releaseToast(id);
  }

  // Damped spring, ~7 % overshoot, lands exactly on 1.
  const spring = (p: number) => 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-p * 6.5);

  function drop(_node: Element) {
    return {
      duration: dur('slow'),
      css: (p: number) => {
        const s = spring(p);
        return `opacity: ${Math.min(1, p * 3)}; transform: translate3d(0, ${(1 - s) * -64}px, 0) scale(${0.86 + 0.14 * s});`;
      },
    };
  }

  function lift(_node: Element) {
    return {
      duration: dur('med'),
      easing: cubicOut,
      css: (p: number) => `opacity: ${p}; transform: translate3d(0, ${(1 - p) * -18}px, 0) scale(${0.9 + 0.1 * p}); filter: blur(${(1 - p) * 4}px);`,
    };
  }
</script>

<div class="toasts" aria-live="polite" use:toBody>
  {#each [...toasts.list].reverse() as toast (toast.id)}
    <div
      class="toast {toast.kind}"
      role="status"
      animate:flip={{ duration: dur('med'), easing: cubicOut }}
      in:drop
      out:lift
      onpointerenter={() => holdToast(toast.id)}
      onpointerleave={(e) => release(e, toast.id)}
      onfocusin={() => holdToast(toast.id)}
      onfocusout={(e) => release(e, toast.id)}
    >
      <span class="glyph"><Icon name={ICON[toast.kind]} size={15} stroke={2.1} /></span>
      <span class="msg">{toast.message}</span>
      {#if toast.action}
        {@const action = toast.action}
        <button class="act" onclick={() => (dropToast(toast.id), action.run())}>{action.label}</button>
      {/if}
      <button class="x" onclick={() => dropToast(toast.id)} aria-label={t('common.actions.close')} tabindex="-1"><Icon name="close" size={11} stroke={2.4} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: calc(var(--titlebar) + 6px);
    left: 50%;
    z-index: 1000;
    width: min(520px, calc(100vw - 2 * var(--caption-buttons)));
    translate: -50% 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    min-height: 44px;
    padding: 7px 14px 7px 8px;
    border-radius: 999px;
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    transform-origin: top center;
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label);
  }
  .msg {
    font-size: var(--fs-callout);
    font-weight: 500;
    line-height: 1.35;
    color: var(--label);
    overflow-wrap: anywhere;
  }
  .act {
    flex: none;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
    font-size: var(--fs-callout);
    font-weight: 600;
  }
  .act:hover {
    background: var(--fill-3);
  }
  .x {
    position: absolute;
    top: -4px;
    left: -4px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--bg-elevated-2);
    color: var(--label-2);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-1);
    opacity: 0;
    transform: scale(0.6);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .toast:hover .x {
    opacity: 1;
    transform: none;
  }
  .x:hover {
    color: var(--label);
  }
</style>
