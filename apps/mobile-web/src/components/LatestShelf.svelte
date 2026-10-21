<script lang="ts">
  // A library's latest additions, as a horizontal row of posters (persisted: it paints from the last visit).
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import PosterCard from './PosterCard.svelte';

  let { view, api }: { view: BaseItem; api: Api } = $props();
  const latest = useLoad<BaseItem[]>(() => `m.home.latest:${view.Id}`, () => api.latest(view.Id), { persist: true });
</script>

{#if latest.value?.length}
  <section class="shelf">
    <h2 class="title-3 shelf-title">{t('latest_in', view.Name)}</h2>
    <div class="shelf-row">
      {#each latest.value as item (item.Id)}
        <PosterCard {item} {api} width={120} onclick={() => nav.push(itemRoute(item))} />
      {/each}
    </div>
  </section>
{/if}
