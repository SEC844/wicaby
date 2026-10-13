<script lang="ts">
  // First-run setup (onboarding spec 2): six short steps, each choice saved at once so quitting halfway loses
  // nothing. Steps 3 and 4 host the server page and the sign-in page. Settings > General runs it again (rerun).
  import { onMount, tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { ServerInfo, ServerSession } from '../../shared/contract';
  import { t } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import { onlineSessions, updateSettings } from '../lib/stores.svelte';
  import Done from './welcome/Done.svelte';
  import Extras from './welcome/Extras.svelte';
  import Intro from './welcome/Intro.svelte';
  import Look from './welcome/Look.svelte';
  import SignIn from './welcome/SignIn.svelte';
  import Where from './welcome/Where.svelte';

  let { rerun = false }: { rerun?: boolean } = $props();

  const COUNT = 6;
  let step = $state(1);
  // The server waiting for step 4's sign-in.
  let serverId = $state<string | null>(null);
  let card = $state<HTMLElement>();

  const tempo = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tempo')) || 1;
  const signedIn = $derived(onlineSessions().length > 0);

  async function go(next: number): Promise<void> {
    step = next;
    await tick();
    // The step's main action takes focus, so Enter moves on.
    card?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }

  // Done, Skip and the Remote access link: the setup is over, then the app lands where it does today (the
  // route guard picks /servers, /login or the start page from '/'). A rerun goes back to Settings.
  async function finish(path = rerun ? '/settings' : '/'): Promise<void> {
    await updateSettings({ ui: { onboarded: true } });
    navigate(path, { replace: true });
  }

  function ready(server: ServerInfo, status: ServerSession['status']): void {
    if (status === 'signed-in') void go(5);
    else {
      serverId = server.id;
      void go(4);
    }
  }

  function back(): void {
    void go(step === 5 ? 3 : step - 1);
  }

  // Esc on step 3 = Back, unless a sheet or a field has it.
  function onkey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || step !== 3 || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
    if (e.target instanceof HTMLInputElement && e.target.value) return;
    back();
  }

  onMount(() => void go(1));
</script>

<svelte:window onkeydown={onkey} />

<div class="welcome">
  <div class="stage">
    {#key step}
      <section class="card" class:wide={step === 3 || step === 4} data-step={step} bind:this={card} in:fly={{ y: 16, duration: 420 * tempo(), easing: cubicOut }}>
        {#if step === 1}
          <Intro />
        {:else if step === 2}
          <Look />
        {:else if step === 3}
          <Where onready={ready} />
        {:else if step === 4 && serverId}
          <SignIn {serverId} onsignedin={() => go(5)} onaddanother={() => go(3)} onoffline={() => go(3)} />
        {:else if step === 5}
          <Extras />
        {:else}
          <Done onremote={() => finish('/settings?pane=remote')} />
        {/if}

        <footer class="nav">
          {#if step >= 2}<button type="button" class="btn ghost" onclick={back}>{t('common.actions.back')}</button>{/if}
          <span class="grow"></span>
          {#if step === 2 || step === 5}<button type="button" class="btn ghost" onclick={() => go(step + 1)}>{t('welcome.actions.notNow')}</button>{/if}
          {#if step === 1}
            <button type="button" class="btn primary" data-autofocus data-action="start" onclick={() => go(2)}>{t('welcome.actions.start')}</button>
          {:else if step === 2 || step === 5 || (step === 3 && signedIn)}
            <button type="button" class="btn primary" data-autofocus data-action="continue" onclick={() => go(step === 3 ? 5 : step + 1)}>{t('common.actions.continue')}</button>
          {:else if step === 6}
            <button type="button" class="btn primary" data-autofocus data-action="finish" onclick={() => finish()}>{t('welcome.done.start')}</button>
          {/if}
        </footer>
      </section>
    {/key}

    <div class="below">
      <div class="dots" role="img" aria-label={t('welcome.progress', { step, count: COUNT })}>
        {#each { length: COUNT }, i (i)}<span class:on={i + 1 === step}></span>{/each}
      </div>
      {#if step < COUNT}<button type="button" class="skip" data-action="skip" onclick={() => finish()}>{t('welcome.actions.skip')}</button>{/if}
    </div>
  </div>
</div>

<style>
  .welcome {
    view-transition-name: page;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .stage {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: calc(var(--titlebar) + 24px) 24px 28px;
  }
  .card {
    width: min(580px, 100%);
    display: flex;
    flex-direction: column;
    gap: 26px;
    padding: 40px 40px 28px;
    border-radius: var(--r-xl);
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      inset 0 1px 0 rgb(255 255 255 / 0.05),
      var(--shadow-3);
  }
  .card.wide {
    width: min(720px, 100%);
  }
  /* Shared by the steps (routes/welcome/*.svelte). */
  .card :global(h1) {
    margin: 0;
    font-size: var(--fs-large-title);
    font-weight: 700;
    letter-spacing: -0.028em;
    line-height: 1.1;
    text-align: center;
  }
  .card :global(.lead) {
    margin: -14px auto 0;
    max-width: 44ch;
    font-size: var(--fs-headline);
    line-height: 1.45;
    color: var(--label-2);
    text-align: center;
  }
  .card :global(.quiet-link) {
    align-self: center;
    padding: 4px 6px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    border-radius: var(--r-xs);
  }
  .card :global(.quiet-link:is(:hover, :focus-visible)) {
    color: var(--label);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .below {
    position: relative;
    width: min(720px, 100%);
    display: flex;
    justify-content: center;
    margin-top: 18px;
  }
  .dots {
    display: flex;
    gap: 6px;
    padding: 6px 0;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--fill-3);
    transition:
      width var(--t-med) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .dots span.on {
    width: 18px;
    background: var(--label-2);
  }
  .skip {
    position: absolute;
    right: 0;
    top: 0;
    padding: 2px 6px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    border-radius: var(--r-xs);
  }
  .skip:is(:hover, :focus-visible) {
    color: var(--label);
  }
</style>
