<script lang="ts">
  // Android TV MusicHome (music/MusicHome.kt): a music library's tab as rows rather than tabs, the TV idiom. Recent
  // albums, recently played, playlists, artists, genres; a row the server leaves empty is not shown. The header's
  // pills open the whole library as a grid (albums, artists or songs). A track or a genre plays, the rest opens.
  import type { BaseItem } from '$shared/models';
  import MediaRow from '../components/MediaRow.svelte';
  import Pill from '../components/Pill.svelte';
  import type { Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { useLoad } from '../lib/load.svelte';
  import { playMusicItem } from '../lib/music.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';

  let { api, parentId, title, top = 104, onscrolled }: { api: Api; parentId: string; title: string; top?: number; onscrolled?: (s: boolean) => void } =
    $props();

  const ROW = 24;
  // svelte-ignore state_referenced_locally
  const id = parentId;
  const recentAlbums = useLoad(
    () => `music-${id}-recent-albums`,
    async () => (await api.items({ ParentId: id, IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending', Limit: ROW })).Items,
  );
  const recentlyPlayed = useLoad(
    () => `music-${id}-recently-played`,
    async () =>
      (
        await api.items({
          ParentId: id, IncludeItemTypes: 'Audio', Recursive: true, Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: ROW, Fields: api.trackFields,
        })
      ).Items,
  );
  // Playlists live outside the music library: the user's audio ones (a playlist keeps one media type).
  const playlists = useLoad(
    () => `music-${id}-playlists`,
    async () => (await api.items({ IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName', Limit: 100 })).Items.filter((p) => p.MediaType === 'Audio').slice(0, ROW),
  );
  const artists = useLoad(() => `music-${id}-artists`, async () => (await api.albumArtists({ ParentId: id, SortBy: 'SortName', Limit: ROW })).Items);
  const genres = useLoad(() => `music-${id}-genres`, async () => (await api.musicGenres(id)).Items.slice(0, ROW));

  const rows = $derived(
    [
      { key: 'recent-albums', title: t('music_row_recent_albums'), items: recentAlbums.value },
      { key: 'recently-played', title: t('music_row_recently_played'), items: recentlyPlayed.value },
      { key: 'playlists', title: t('music_row_playlists'), items: playlists.value },
      { key: 'artists', title: t('music_row_artists'), items: artists.value },
      { key: 'genres', title: t('music_row_genres'), items: genres.value },
    ].filter((r) => r.items?.length),
  );

  function open(item: BaseItem): void {
    if (item.Type === 'Audio' || item.Type === 'MusicGenre' || item.Type === 'Genre') void playMusicItem(api, item);
    else nav.push(itemRoute(item));
  }

  // --- Vertical scroll: the focused row comes into view by its edges ---
  let page = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    if (!page || !content) return;
    const band = ((e.target as HTMLElement).closest('[data-music-row]') as HTMLElement | null) ?? (e.target as HTMLElement);
    const at = band.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const max = Math.max(0, content.offsetHeight - page.clientHeight);
    y = clamp(y + edgeDelta(at - y, band.offsetHeight, page.clientHeight, dp(56)), 0, max);
    onscrolled?.(y > 60);
  }
</script>

<div class="music" bind:this={page} ontvfocus={onfocus}>
  <div class="content" bind:this={content} style="padding-top:{top}rem;transform:translate3d(0,{-y}px,0)">
    <div class="head" data-music-row>
      <h1 class="t-large-title ellipsis">{title}</h1>
      <div class="pills">
        <Pill text={t('music_albums')} onclick={() => nav.push({ name: 'musicLibrary', id, title, mode: 'albums' })} />
        <Pill text={t('music_artists')} onclick={() => nav.push({ name: 'musicLibrary', id, title, mode: 'artists' })} />
        <Pill text={t('music_songs')} onclick={() => nav.push({ name: 'musicLibrary', id, title, mode: 'songs' })} />
      </div>
    </div>
    {#each rows as r (r.key)}
      <div data-music-row>
        <MediaRow title={r.title} items={r.items ?? []} {api} square onclick={open} />
      </div>
    {/each}
  </div>
</div>

<style>
  .music {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
  }
  .content {
    padding-bottom: 56rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .head {
    display: flex;
    align-items: center;
    padding: 0 48rem 4rem;
  }
  h1 {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .pills {
    display: flex;
  }
  .pills > :global(* + *) {
    margin-left: 10rem;
  }
</style>
