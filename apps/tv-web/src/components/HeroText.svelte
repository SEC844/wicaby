<script lang="ts">
  // Android TV HeroText (Main.kt): the title's logo (or its name), the meta line and the overview, for the Home hero
  // and the details page.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '../lib/api';
  import { metaLine } from '../lib/format';
  import { locale } from '../lib/i18n.svelte';

  let { api, item, overviewLines = 3 }: { api: Api; item: BaseItem; overviewLines?: number } = $props();

  let logoFailed = $state<string | null>(null);
  const logo = $derived(logoFailed !== item.Id ? api.logo(item) : undefined);
</script>

{#if logo}
  <img class="logo" src={logo} alt={item.Name} onerror={() => (logoFailed = item.Id)} />
{:else}
  <h1 class="t-hero">{item.Type === 'Episode' ? (item.SeriesName ?? item.Name) : item.Name}</h1>
{/if}
<p class="meta t-callout">{metaLine(item, locale.current)}</p>
{#if item.Overview?.trim()}
  <p class="overview t-body" style="-webkit-line-clamp:{overviewLines};line-clamp:{overviewLines}">{item.Overview}</p>
{/if}

<style>
  .logo {
    display: block;
    max-height: 96rem;
    max-width: 380rem;
  }
  h1 {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    margin: 12rem 0 0;
    color: var(--label-2);
    white-space: nowrap;
  }
  .overview {
    margin: 10rem 0 0;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
