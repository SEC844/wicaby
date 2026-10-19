<script lang="ts">
  // Android TV LibraryTab (Main.kt): a library tab's screen. Android opens music libraries on their rows (MusicHome)
  // and photo libraries on their timeline (PhotosTab); those screens are M3, and until then these libraries show the
  // grid, as Android does for every other type.
  import type { BaseItem } from '$shared/models';
  import LibraryGrid from '../components/LibraryGrid.svelte';
  import type { Api } from '../lib/api';

  let { api, view, top = 104, onscrolled }: { api: Api; view: BaseItem; top?: number; onscrolled?: (scrolled: boolean) => void } = $props();
</script>

<LibraryGrid {api} parentId={view.Id} title={view.Name} collectionType={view.CollectionType} {top} {onscrolled} />
