<script lang="ts">
  // The tab bar (Android MainShell's NavigationBar, drawn as iOS draws it): five tabs over a translucent material,
  // above the home indicator. A tap on the current tab returns it to its root, or to its top when already there.
  import Download from '@lucide/svelte/icons/download';
  import House from '@lucide/svelte/icons/house';
  import Library from '@lucide/svelte/icons/library';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import { t } from '$tv/i18n.svelte';
  import { nav, shell, TABS, type TabId } from '../lib/nav.svelte';

  const ICONS = { home: House, libraries: Library, search: Search, downloads: Download, settings: Settings };
  const LABELS: Record<TabId, string> = { home: 'tab_home', libraries: 'nav_libraries', search: 'tab_search', downloads: 'nav_downloads', settings: 'tab_settings' };
</script>

<nav class="bar material" aria-label="Wicaby">
  {#each TABS as tab (tab)}
    {@const Icon = ICONS[tab]}
    <button class="tab" class:on={shell.tab === tab} aria-current={shell.tab === tab ? 'page' : undefined} onclick={() => nav.selectTab(tab)}>
      <Icon size={25} strokeWidth={shell.tab === tab ? 2 : 1.6} aria-hidden="true" />
      <span class="name">{t(LABELS[tab])}</span>
    </button>
  {/each}
</nav>

<style>
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--tabbar);
    padding: 0 max(8px, var(--safe-left)) var(--safe-bottom) max(8px, var(--safe-right));
    display: flex;
    border-top: 0.5px solid var(--separator);
    z-index: 10;
  }
  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--label-3);
    min-width: 0;
  }
  .tab.on {
    color: var(--label);
  }
  .name {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>
