<script lang="ts">
  // Android TV MusicLibraryScreen (music/MusicHome.kt): a music library's whole grid, on albums, artists or songs; the
  // header's pills switch between them (the current one in the accent) and Shuffle plays the library in random order.
  // A song plays on through its album.
  import LibraryGrid from '../components/LibraryGrid.svelte';
  import Pill from '../components/Pill.svelte';
  import { t } from '../lib/i18n.svelte';
  import { playMusic, playMusicItem } from '../lib/music.svelte';
  import { nav } from '../lib/nav.svelte';
  import { api } from '../lib/session.svelte';
  import { showToast } from '../lib/toast.svelte';

  let { id, title, mode: initial }: { id: string; title: string; mode: 'albums' | 'artists' | 'songs' } = $props();
  const client = api()!;
  // svelte-ignore state_referenced_locally
  let mode = $state(initial);
  const MODES = [
    { m: 'albums', label: 'music_albums' },
    { m: 'artists', label: 'music_artists' },
    { m: 'songs', label: 'music_songs' },
  ] as const;

  async function shuffleAll(): Promise<void> {
    const tracks = (await client.items({ ParentId: id, Recursive: true, IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: 500, Fields: client.trackFields }).catch(() => null))?.Items ?? [];
    if (!tracks.length) return showToast(t('nothing_to_play'));
    playMusic(client, tracks, 0);
    nav.push({ name: 'nowPlaying' });
  }
</script>

<div class="library">
  {#key mode}
    <LibraryGrid
      api={client}
      parentId={id}
      {title}
      collectionType="music"
      {mode}
      top={48}
      defaultFocus
      onopen={(item) => item.Type === 'Audio' && (void playMusicItem(client, item), true)}
    >
      {#snippet actions(total)}
        {#each MODES as x (x.m)}
          <Pill text={t(x.label)} primary={mode === x.m} onclick={() => (mode = x.m)} />
        {/each}
        {#if total > 0}<Pill text={t('shuffle')} icon="Shuffle" onclick={shuffleAll} />{/if}
      {/snippet}
    </LibraryGrid>
  {/key}
</div>

<style>
  .library {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--bg);
  }
</style>
