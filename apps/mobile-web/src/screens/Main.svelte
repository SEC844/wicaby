<script lang="ts">
  // The signed-in shell's tab roots (Android MainShell): each tab is mounted on its first visit and kept, so a tab
  // shows again where it was left. The tab bar lives in App.svelte, over the tabs' pushed pages too.
  import { shell, TABS, type TabId } from '../lib/nav.svelte';
  import HomeTab from '../tabs/HomeTab.svelte';
  import Placeholder from '../tabs/Placeholder.svelte';
  import SettingsTab from '../tabs/SettingsTab.svelte';

  const visited = $state<Record<TabId, boolean>>({ home: true, libraries: false, search: false, downloads: false, settings: false });
  $effect.pre(() => {
    visited[shell.tab] = true;
  });
</script>

{#each TABS as tab (tab)}
  {#if visited[tab]}
    <div class="tab" class:on={shell.tab === tab} inert={shell.tab !== tab}>
      {#if tab === 'home'}<HomeTab />
      {:else if tab === 'settings'}<SettingsTab />
      {:else}<Placeholder {tab} />{/if}
    </div>
  {/if}
{/each}

<style>
  .tab {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  .on {
    visibility: visible;
  }
</style>
