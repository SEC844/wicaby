<script lang="ts">
  // Android TV FolderScreen (Main.kt): a pushed folder or collection, as a library grid with its first title focused.
  import LibraryGrid from '../components/LibraryGrid.svelte';
  import { apiOf } from '../lib/session.svelte';

  let { id, title, serverId }: { id: string; title: string; serverId?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
</script>

<div class="folder">
  <LibraryGrid api={client} parentId={id} {title} top={48} defaultFocus />
</div>

<style>
  .folder {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--bg);
  }
</style>
