<script lang="ts">
  // Android TV TvAlert: a centred card over a dimmed screen, actions stacked full width.
  import { focusable, setFocus } from '../lib/focus';
  import { closeAlert, type Alert } from '../lib/overlay.svelte';
  import Icon from './Icon.svelte';
  import QrCode from './QrCode.svelte';

  let { alert }: { alert: Alert } = $props();
  let buttons: HTMLButtonElement[] = $state([]);

  // Each alert shown gets its default focus, also one opened by another one's action (the same dialog, new content).
  $effect(() => {
    const a = alert;
    const frame = requestAnimationFrame(() => {
      const b = buttons[a.focusIndex ?? a.selected ?? 0] ?? buttons[0];
      if (b) setFocus(b);
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="scrim" data-focus-trap>
  <div class="card">
    <h2 class="t-title2">{alert.title}</h2>
    {#if alert.message}<p class="t-body label-2">{alert.message}</p>{/if}
    {#if alert.qr}
      <div class="qr"><QrCode text={alert.qr} size={160} /></div>
      <p class="t-caption label-3 link">{alert.qr}</p>
    {/if}
    {#each alert.actions as a, i (i)}
      <button
        bind:this={buttons[i]}
        class="action t-headline"
        class:destructive={a.destructive}
        use:focusable
        onclick={() => {
          closeAlert();
          a.run();
        }}
        >{#if alert.selected !== undefined}<span class="mark">{#if i === alert.selected}<Icon name="Check" size={18} />{/if}</span>{/if}<span class="text">{a.label}</span></button
      >
    {/each}
  </div>
</div>

<style>
  .qr {
    display: flex;
    justify-content: center;
    margin-top: 18rem;
  }
  .link {
    margin: 10rem 0 6rem;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
    width: 460rem;
    padding: 28rem 20rem 20rem;
    border-radius: var(--r-xl);
    background: var(--elevated-2);
    text-align: center;
  }
  h2 {
    margin: 0 0 8rem;
  }
  p {
    margin: 0 0 8rem;
  }
  .action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    margin-top: 10rem;
    padding: 13rem;
    border-radius: var(--r-md);
    background: var(--fill-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .mark {
    width: 18rem;
    margin-right: 10rem;
  }
  .mark + .text {
    flex: 1;
    text-align: left;
  }
  .destructive {
    color: var(--red);
  }
  .action:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.03);
  }
</style>
