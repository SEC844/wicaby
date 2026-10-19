<script lang="ts">
  // Android TV PhotoAlbumScreen (ui/photos/PhotosTab.kt): a photo album's own timeline, its first photo focused.
  import { apiOf } from '../lib/session.svelte';
  import PhotosTab from '../tabs/PhotosTab.svelte';

  let { id, title, serverId }: { id: string; title: string; serverId?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
</script>

<div class="album">
  <PhotosTab api={client} parentId={id} {title} top={48} album />
</div>

<style>
  .album {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--bg);
  }
</style>
