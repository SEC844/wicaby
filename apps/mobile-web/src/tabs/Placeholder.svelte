<script lang="ts">
  // A tab not built yet on the phone (M1): its title, and a note.
  import { t } from '$tv/i18n.svelte';
  import type { TabId } from '../lib/nav.svelte';

  let { tab }: { tab: TabId } = $props();
  const TITLES: Record<TabId, string> = { home: 'tab_home', libraries: 'nav_libraries', search: 'tab_search', downloads: 'nav_downloads', settings: 'tab_settings' };
</script>

<div class="page">
  <h1 class="large-title">{t(TITLES[tab])}</h1>
  <p class="callout label-2">{t('web_coming')}</p>
</div>

<style>
  .page {
    height: 100%;
    padding: calc(var(--safe-top) + 16px) max(var(--gutter), var(--safe-right)) var(--tabbar) max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
