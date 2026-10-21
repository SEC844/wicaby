<script lang="ts">
  // The tab bar, as iOS 26 draws it in the Apple TV app: a floating glass capsule with the four tabs, and Search as
  // its own round button beside it. The current tab sits on a soft fill (Wicaby marks selection with a fill, never
  // with an accent pill). A tap on the current tab returns it to its root, or to its top when already there.
  import Download from '@lucide/svelte/icons/download';
  import House from '@lucide/svelte/icons/house';
  import Library from '@lucide/svelte/icons/library';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import { t } from '$tv/i18n.svelte';
  import { nav, shell, type TabId } from '../lib/nav.svelte';

  const MAIN: { id: TabId; icon: typeof House; label: string }[] = [
    { id: 'home', icon: House, label: 'tab_home' },
    { id: 'libraries', icon: Library, label: 'nav_libraries' },
    { id: 'downloads', icon: Download, label: 'nav_downloads' },
    { id: 'settings', icon: Settings, label: 'tab_settings' },
  ];
</script>

<nav class="dock" aria-label="Wicaby">
  <div class="bar glass">
    {#each MAIN as tab (tab.id)}
      {@const on = shell.tab === tab.id}
      <button class="tab" class:on aria-current={on ? 'page' : undefined} onclick={() => nav.selectTab(tab.id)}>
        <tab.icon size={23} strokeWidth={on ? 2.1 : 1.7} aria-hidden="true" />
        <span class="name">{t(tab.label)}</span>
      </button>
    {/each}
  </div>
  <button class="search glass" class:on={shell.tab === 'search'} aria-label={t('tab_search')} aria-current={shell.tab === 'search' ? 'page' : undefined} onclick={() => nav.selectTab('search')}>
    <Search size={24} strokeWidth={shell.tab === 'search' ? 2.3 : 1.9} aria-hidden="true" />
  </button>
</nav>

<style>
  .dock {
    position: absolute;
    left: max(16px, var(--safe-left));
    right: max(16px, var(--safe-right));
    bottom: var(--tabbar-gap);
    display: flex;
    gap: 10px;
    z-index: 10;
    pointer-events: none;
  }
  .bar,
  .search {
    pointer-events: auto;
    height: 62px;
    border-radius: 31px;
  }
  .bar {
    flex: 1;
    display: flex;
    padding: 4px;
    min-width: 0;
  }
  .tab {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border-radius: 27px;
    color: var(--label-2);
  }
  .tab.on {
    background: var(--fill-3);
    color: var(--label);
  }
  .name {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    padding: 0 2px;
  }
  .search {
    width: 62px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .search.on {
    color: var(--label);
  }
</style>
