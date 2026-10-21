<script lang="ts">
  // A page with a large title (the desktop's page heads, Android's screen titles): the title at the top of the
  // content; once it scrolls away, a bar of the floating chrome's material takes over with the title small. The switch is a class flip on a threshold (no work per frame).
  // A pushed page (back) gets a round Back button above its title. A tap on the current tab's icon at its root
  // scrolls back to the top.
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import type { Snippet } from 'svelte';
  import { t } from '$tv/i18n.svelte';
  import { handleBack, shell, type TabId } from '../lib/nav.svelte';
  import ProfileButton from './ProfileButton.svelte';

  let {
    title,
    tab,
    back = false,
    trailing,
    header,
    children,
    scroller = $bindable(),
  }: { title: string; tab?: TabId; back?: boolean; trailing?: Snippet; header?: Snippet; children: Snippet; scroller?: HTMLElement } = $props();

  let collapsed = $state(false);

  let seen = shell.reselect;
  $effect(() => {
    if (shell.reselect !== seen && shell.tab === tab) scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    seen = shell.reselect;
  });
</script>

<div class="page">
  <div class="scroller" class:back data-scroll bind:this={scroller} onscroll={() => (collapsed = scroller!.scrollTop > (back ? 60 : 38))}>
    <header class="head">
      <h1 class="large-title">{title}</h1>
      {#if trailing}<div class="trailing">{@render trailing()}</div>{/if}
      <!-- The account, on every tab's root but Settings (which opens with it). -->
      {#if tab && tab !== 'settings'}<ProfileButton />{/if}
    </header>
    {@render header?.()}
    {@render children()}
  </div>
  <div class="bar" class:collapsed aria-hidden={!collapsed}>
    <span class="headline ellipsis">{title}</span>
  </div>
  {#if back}
    <button class="back-btn round" aria-label={t('back')} onclick={() => handleBack()}><ChevronLeft size={26} strokeWidth={2.2} aria-hidden="true" /></button>
  {/if}
</div>

<style>
  .page {
    position: relative;
    height: 100%;
  }
  .scroller {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding: calc(var(--safe-top) + 10px) 0 calc(var(--tabbar) + 16px);
  }
  .scroller.back {
    padding-top: calc(var(--safe-top) + 56px);
  }
  .back-btn {
    position: absolute;
    top: calc(var(--safe-top) + 2px);
    left: max(12px, var(--safe-left));
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    z-index: 5;
  }
  .ellipsis {
    max-width: calc(100% - 128px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 max(var(--gutter), var(--safe-right)) 8px max(var(--gutter), var(--safe-left));
  }
  .head h1 {
    flex: 1;
    min-width: 0;
  }
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: calc(var(--safe-top) + 44px);
    padding-top: var(--safe-top);
    display: grid;
    place-items: center;
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    border-bottom: 0.5px solid var(--separator);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-fast) linear;
    z-index: 4;
  }
  .bar.collapsed {
    opacity: 1;
  }
</style>
