<script lang="ts">
  import type { BaseItem } from '../../../shared/models';
  import DeleteSheet from './DeleteSheet.svelte';
  import IdentifySheet from './IdentifySheet.svelte';
  import ImagesSheet from './ImagesSheet.svelte';
  import MetadataEditor from './MetadataEditor.svelte';
  import RefreshSheet from './RefreshSheet.svelte';
  import SubtitlesSheet from './SubtitlesSheet.svelte';
  import { isAdminFor, type AdminAction } from './metadata';

  // The item page's admin sheets, opened from ItemMenu's admin entries.
  let { action, item, onclose }: { action: AdminAction | null; item: BaseItem; onclose: () => void } = $props();
</script>

{#if isAdminFor(item)}
  <MetadataEditor open={action === 'edit'} {item} {onclose} />
  <IdentifySheet open={action === 'identify'} {item} {onclose} />
  <ImagesSheet open={action === 'images'} {item} {onclose} />
  <RefreshSheet open={action === 'refresh'} {item} {onclose} />
  <SubtitlesSheet open={action === 'subtitles'} {item} {onclose} />
  <DeleteSheet open={action === 'delete'} {item} {onclose} />
{/if}
