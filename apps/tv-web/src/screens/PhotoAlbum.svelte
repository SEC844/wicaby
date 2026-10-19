<script lang="ts">
  // Android TV PhotoAlbumScreen (ui/photos/PhotosTab.kt): a photo album's own timeline, its first photo focused.
  import { api } from '../lib/session.svelte';
  import PhotosTab from '../tabs/PhotosTab.svelte';

  let { id, title }: { id: string; title: string } = $props();
  const client = api()!;
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
