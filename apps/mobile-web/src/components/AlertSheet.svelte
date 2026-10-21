<script lang="ts">
  // The dialog layer (lib/overlay.svelte.ts): an iOS alert for two actions, an action sheet from the bottom for more
  // (or a picker). A destructive action is red; "cancel" closes. A link the TV shows as a QR code opens here instead.
  import Check from '@lucide/svelte/icons/check';
  import { fade, fly } from 'svelte/transition';
  import { t } from '$tv/i18n.svelte';
  import { closeAlert, type Alert } from '../lib/overlay.svelte';
  import { openUrl } from '../platform';

  let { alert }: { alert: Alert } = $props();
  const sheet = $derived(alert.actions.length > 2 || alert.selected !== undefined);

  function openLink(url: string): void {
    closeAlert();
    void openUrl(url);
  }

  function run(i: number): void {
    const a = alert.actions[i];
    closeAlert();
    a.run();
  }
</script>

<div class="scrim" role="presentation" onclick={closeAlert} transition:fade={{ duration: 200 }}></div>
{#if sheet}
  <div class="sheet" role="dialog" aria-modal="true" aria-label={alert.title} transition:fly={{ y: 400, duration: 320, opacity: 1 }}>
    <div class="group material">
      <div class="head">
        <p class="footnote label-2 strong">{alert.title}</p>
        {#if alert.message}<p class="footnote label-2">{alert.message}</p>{/if}
      </div>
      {#each alert.actions as a, i (i)}
        <button class="action" class:destructive={a.destructive} onclick={() => run(i)}>
          <span>{a.label}</span>
          {#if alert.selected === i}<Check size={20} aria-hidden="true" />{/if}
        </button>
      {/each}
      {#if alert.qr}<button class="action" onclick={() => openLink(alert.qr!)}>{alert.qr}</button>{/if}
    </div>
    <button class="group material action cancel" onclick={closeAlert}>{t('cancel')}</button>
  </div>
{:else}
  <div class="alert material" role="alertdialog" aria-modal="true" aria-label={alert.title} transition:fade={{ duration: 160 }}>
    <div class="head">
      <p class="headline">{alert.title}</p>
      {#if alert.message}<p class="footnote">{alert.message}</p>{/if}
    </div>
    <div class="buttons" class:stacked={alert.actions.length !== 2}>
      {#each alert.actions as a, i (i)}
        <button class="action" class:destructive={a.destructive} onclick={() => run(i)}>{a.label}</button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 50;
  }
  .sheet {
    position: fixed;
    left: max(8px, var(--safe-left));
    right: max(8px, var(--safe-right));
    bottom: max(8px, var(--safe-bottom));
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .group {
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--material-thick);
  }
  .head {
    padding: 14px 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .strong {
    font-weight: 600;
  }
  .action {
    width: 100%;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 19px;
    color: var(--accent);
    border-top: 0.5px solid var(--separator);
  }
  .action:active {
    background: var(--fill-2);
  }
  .destructive {
    color: var(--red);
  }
  .cancel {
    font-weight: 600;
    border-top: 0;
  }
  .alert {
    position: fixed;
    left: 50%;
    top: 50%;
    width: 270px;
    transform: translate(-50%, -50%);
    border-radius: var(--r-md);
    background: var(--material-thick);
    z-index: 51;
    overflow: hidden;
  }
  .alert .head {
    padding: 20px 16px;
  }
  .buttons {
    display: flex;
  }
  .buttons .action {
    font-size: 17px;
    min-height: 44px;
  }
  .buttons:not(.stacked) .action + .action {
    border-left: 0.5px solid var(--separator);
  }
  .stacked {
    flex-direction: column;
  }
</style>
