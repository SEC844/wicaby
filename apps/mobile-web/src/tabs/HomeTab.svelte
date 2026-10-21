<script lang="ts">
  // Accueil, as the Apple TV app's Home: the hero first, full bleed under the status bar, then the user's rows
  // (lib/home.svelte.ts). Once the hero scrolls away, a bar of the floating chrome's material takes the top. Pulling down at the
  // top stretches the hero's artwork. Continue watching and Next up play on a tap; other cards open their page.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { play } from '$tv/playback';
  import { api } from '$tv/session.svelte';
  import Hero from '../components/Hero.svelte';
  import ProfileButton from '../components/ProfileButton.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { useHome } from '../lib/home.svelte';
  import { itemRoute, nav, shell } from '../lib/nav.svelte';

  const a = api()!;
  const views = useLoad<BaseItem[]>(() => 'views', () => a.views(), { persist: true });
  const home = useHome(a, () => views.value ?? []);

  let scroller: HTMLElement;
  let heroBox = $state<HTMLElement>();
  let solid = $state(false);

  function onScroll(): void {
    const y = scroller.scrollTop;
    // iOS reports the rubber band above the top as a negative offset.
    if (heroBox) heroBox.style.setProperty('--stretch', String(1 + Math.max(0, -y) / heroBox.offsetHeight));
    solid = y > (heroBox ? heroBox.offsetHeight - 120 : 40);
  }

  let seen = shell.reselect;
  $effect(() => {
    if (shell.reselect !== seen && shell.tab === 'home') scroller.scrollTo({ top: 0, behavior: 'smooth' });
    seen = shell.reselect;
  });

  const open = (item: BaseItem) => nav.push(itemRoute(item));
</script>

<div class="page">
  <div class="scroller" data-scroll bind:this={scroller} onscroll={onScroll}>
    {#if home.hero.length}
      <div bind:this={heroBox}><Hero items={home.hero} api={a} /></div>
    {:else}
      <h1 class="large-title plain">{t('tab_home')}</h1>
    {/if}
    {#each home.rows as row (row.key)}
      <Shelf title={row.title} items={row.items} api={a} wide={row.wide} subtitle={row.subtitle} onopen={row.playable ? (i) => play(i) : open} />
    {/each}
    {#if home.loading}<div class="loading"><Spinner /></div>{/if}
  </div>

  <div class="bar" class:solid>
    <span class="headline title">{t('tab_home')}</span>
  </div>
  <ProfileButton floating onMedia={!solid && home.hero.length > 0} />
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
    padding-bottom: calc(var(--tabbar) + 12px);
  }
  .plain {
    padding: calc(var(--safe-top) + 10px) var(--gutter) 0;
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
  .bar.solid {
    opacity: 1;
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 48px;
    color: var(--label-2);
  }
</style>
