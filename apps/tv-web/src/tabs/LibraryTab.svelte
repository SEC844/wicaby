<script lang="ts">
  // Android TV LibraryTab (Main.kt): a library tab's screen. Live TV opens on its own screen (LiveTvTab), music libraries on their rows (MusicHome),
  // every other type on the grid, with Shuffle (TP-04: the library in random order) except for Live TV, books, collections
  // and playlists. Photo libraries get their timeline in M3 and show the grid until then.
  import type { BaseItem } from '$shared/models';
  import LibraryGrid from '../components/LibraryGrid.svelte';
  import Pill from '../components/Pill.svelte';
  import type { Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { shuffle } from '../lib/playback';
  import LiveTvTab from './LiveTvTab.svelte';
  import MusicHome from './MusicHome.svelte';

  let { api, view, top = 104, onscrolled }: { api: Api; view: BaseItem; top?: number; onscrolled?: (scrolled: boolean) => void } = $props();

  const NO_SHUFFLE = ['livetv', 'books', 'boxsets', 'playlists'];
</script>

{#if view.CollectionType === 'livetv'}
  <LiveTvTab {api} title={view.Name} {top} {onscrolled} />
{:else if view.CollectionType === 'music'}
  <MusicHome {api} parentId={view.Id} title={view.Name} {top} {onscrolled} />
{:else}
  <LibraryGrid {api} parentId={view.Id} title={view.Name} collectionType={view.CollectionType} {top} {onscrolled}>
    {#snippet actions(total)}
      {#if total > 0 && !NO_SHUFFLE.includes(view.CollectionType ?? '')}
        <Pill text={t('shuffle')} icon="Shuffle" onclick={() => shuffle(view)} />
      {/if}
    {/snippet}
  </LibraryGrid>
{/if}
