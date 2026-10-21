<script lang="ts">
  // Accueil (M0): "Continue watching" and each library's latest, through the shared TV web logic. Rows paint from
  // the last visit at once (persisted cache) and refresh behind. The full Home (hero, row settings) is M1.
  import type { BaseItem } from '$shared/models';
  import { continueSubtitle, loadContinue } from '$tv/continue-watching';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { api, prefs } from '$tv/session.svelte';
  import LatestShelf from '../components/LatestShelf.svelte';
  import PosterCard from '../components/PosterCard.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { itemRoute, nav, shell } from '../lib/nav.svelte';

  const a = api()!;
  const VIDEO = new Set(['movies', 'tvshows', 'homevideos', 'musicvideos', undefined]);

  const resume = useLoad<BaseItem[]>(() => 'm.home.continue', async () => (await loadContinue(a, prefs.session!.server.id)).items, { persist: true });
  const views = useLoad<BaseItem[]>(() => 'm.home.views', () => a.views(), { persist: true });
  const shelves = $derived((views.value ?? []).filter((v) => VIDEO.has(v.CollectionType)));

  let scroller: HTMLElement;
  // A tap on the current tab's icon at its root: back to the top.
  let seen = shell.reselect;
  $effect(() => {
    if (shell.reselect !== seen && shell.tab === 'home') scroller.scrollTo({ top: 0, behavior: 'smooth' });
    seen = shell.reselect;
  });
</script>

<div class="page" bind:this={scroller}>
  <h1 class="large-title head">{t('tab_home')}</h1>
  {#if resume.value?.length}
    <section class="shelf">
      <h2 class="title-3 shelf-title">{t('continue_watching')}</h2>
      <div class="shelf-row">
        {#each resume.value as item (item.Id)}
          <PosterCard {item} api={a} thumb width={260} subtitle={continueSubtitle(item)} onclick={() => nav.push(itemRoute(item))} />
        {/each}
      </div>
    </section>
  {/if}
  {#each shelves as view (view.Id)}
    <LatestShelf {view} api={a} />
  {/each}
  {#if views.loading}<div class="loading"><Spinner /></div>{/if}
</div>


<style>
  .page {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding: calc(var(--safe-top) + 12px) 0 calc(var(--tabbar) + 24px);
  }
  .head {
    padding: 0 max(var(--gutter), var(--safe-right)) 12px max(var(--gutter), var(--safe-left));
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 48px;
    color: var(--label-2);
  }
</style>
