<script lang="ts">
  // Android TV PinPad, PinEntrySheet and SetPinSheet (Profiles.kt, TP-10): a keypad the D-pad walks (and the remote's
  // digit keys); the 4th digit submits. "enter" asks [name]'s PIN through [check] (wrong: it says so, and how long to
  // wait, and clears); "set" asks a new PIN twice.
  import { onMount } from 'svelte';
  import { focusable } from '../lib/focus';
  import { clock } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { PIN_LENGTH } from '../lib/pin';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let {
    mode,
    name = '',
    check,
    onok,
    onsave,
    onclose,
  }: {
    mode: 'enter' | 'set';
    name?: string;
    check?: (pin: string) => Promise<{ ok: boolean; waitMs: number }>;
    onok?: () => void;
    onsave?: (pin: string) => Promise<void>;
    onclose: () => void;
  } = $props();

  let pin = $state('');
  let error = $state<string | null>(null);
  let first = $state<string | null>(null);
  let busy = false;
  const title = $derived(mode === 'enter' ? t('pin_for', name) : t(first === null ? 'pin_new' : 'pin_confirm'));

  async function complete(p: string): Promise<void> {
    busy = true;
    if (mode === 'enter') {
      const r = await check!(p);
      if (r.ok) return onok?.();
      error = r.waitMs <= 0 ? t('pin_wrong') : t('pin_wait', clock(Math.ceil(r.waitMs / 1000) * 1000));
    } else if (first === null) {
      first = p;
      error = null;
    } else if (first === p) {
      await onsave?.(p);
      return onclose();
    } else {
      first = null;
      error = t('pin_mismatch');
    }
    pin = '';
    busy = false;
  }

  function type(d: string): void {
    if (busy || pin.length >= PIN_LENGTH) return;
    pin += d;
    if (pin.length === PIN_LENGTH) void complete(pin);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = e.keyCode >= 48 && e.keyCode <= 57 ? e.keyCode - 48 : e.keyCode >= 96 && e.keyCode <= 105 ? e.keyCode - 96 : -1;
      if (d < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      type(String(d));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const ROWS = ['123', '456', '789', ' 0<'];
</script>

<Sheet width={360} {onclose}>
  <div class="pad">
    <p class="t-title3">{title}</p>
    <div class="dots">
      {#each Array.from({ length: PIN_LENGTH }) as _, i (i)}<span class="dot" class:on={i < pin.length}></span>{/each}
    </div>
    <p class="t-callout error">{error ?? ''}</p>
    {#each ROWS as row, r (r)}
      <div class="row">
        {#each row.split('') as k, c (c)}
          {#if k === ' '}
            <span class="key blank"></span>
          {:else if k === '<'}
            <button class="key" aria-label={t('pin_delete')} use:focusable onclick={() => (pin = pin.slice(0, -1))}><Icon name="Backspace" size={24} /></button>
          {:else}
            <button class="key t-title2" use:focusable={k === '1'} onclick={() => type(k)}>{k}</button>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
</Sheet>

<style>
  .pad {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  p {
    margin: 0;
    text-align: center;
  }
  .dots {
    display: flex;
    margin: 18rem 0 10rem;
  }
  .dot {
    width: 14rem;
    height: 14rem;
    margin: 0 7rem;
    border-radius: 50%;
    background: var(--fill-2);
  }
  .dot.on {
    background: var(--label);
  }
  .error {
    height: 24rem;
    color: var(--red);
  }
  .row {
    display: flex;
    margin-top: 10rem;
  }
  .key {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64rem;
    height: 64rem;
    margin: 0 7rem;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .key.blank {
    background: none;
  }
  .key:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.1);
  }
</style>
