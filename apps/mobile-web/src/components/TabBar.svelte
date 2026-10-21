<script lang="ts">
  // The tab bar, as the Android mobile app's (MainShell's NavigationBar): the full width at the bottom, on the
  // elevated surface, five tabs with their labels; the current one has a soft pill behind its icon (selection
  // shows as a fill, never as the accent). A tap on the current tab returns it to its root, or to its top.
  import Download from '@lucide/svelte/icons/download';
  import House from '@lucide/svelte/icons/house';
  import Library from '@lucide/svelte/icons/library';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import { t } from '$tv/i18n.svelte';
  import { nav, shell, type TabId } from '../lib/nav.svelte';

  const TABS: { id: TabId; icon: typeof House; label: string }[] = [
    { id: 'home', icon: House, label: 'tab_home' },
    { id: 'libraries', icon: Library, label: 'nav_libraries' },
    { id: 'search', icon: Search, label: 'tab_search' },
    { id: 'downloads', icon: Download, label: 'nav_downloads' },
    { id: 'settings', icon: Settings, label: 'tab_settings' },
  ];
</script>

<nav class="bar" aria-label="Wicaby">
  {#each TABS as tab (tab.id)}
    {@const on = shell.tab === tab.id}
    <button class="tab" class:on aria-current={on ? 'page' : undefined} onclick={() => nav.selectTab(tab.id)}>
      <span class="pill-bg"><tab.icon size={22} strokeWidth={on ? 2 : 1.6} aria-hidden="true" /></span>
      <span class="name">{t(tab.label)}</span>
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
    padding: 6px max(4px, var(--safe-right)) var(--tabbar-inset) max(4px, var(--safe-left));
    display: flex;
    background: var(--bg-elevated);
    border-top: 0.5px solid var(--separator);
    z-index: 10;
  }
  .tab {
    flex: 1;
    min-width: 0;
    height: 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    color: var(--label-2);
  }
  .pill-bg {
    width: 58px;
    height: 30px;
    border-radius: 15px;
    display: grid;
    place-items: center;
  }
  .on {
    color: var(--label);
  }
  .on .pill-bg {
    background: var(--fill-3);
  }
  .name {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    padding: 0 2px;
  }
</style>
