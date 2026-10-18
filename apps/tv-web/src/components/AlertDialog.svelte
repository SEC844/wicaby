<script lang="ts">
  // Android TV TvAlert: a centred card over a dimmed screen, actions stacked full width.
  import { onMount } from 'svelte';
  import { focusable, setFocus } from '../lib/focus';
  import { closeAlert, type Alert } from '../lib/overlay.svelte';

  let { alert }: { alert: Alert } = $props();
  let buttons: HTMLButtonElement[] = $state([]);

  onMount(() => {
    requestAnimationFrame(() => {
      const b = buttons[alert.focusIndex ?? 0] ?? buttons[0];
      if (b) setFocus(b);
    });
  });
</script>

<div class="scrim" data-focus-trap>
  <div class="card">
    <h2 class="t-title2">{alert.title}</h2>
    {#if alert.message}<p class="t-body label-2">{alert.message}</p>{/if}
    {#each alert.actions as a, i (a.label)}
      <button
        bind:this={buttons[i]}
        class="action t-headline"
        class:destructive={a.destructive}
        use:focusable
        onclick={() => {
          closeAlert();
          a.run();
        }}>{a.label}</button
      >
    {/each}
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
    display: block;
    width: 100%;
    margin-top: 10rem;
    padding: 13rem;
    border-radius: var(--r-md);
    background: var(--fill-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
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
