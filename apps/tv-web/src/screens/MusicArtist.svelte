<script lang="ts">
  // Android TV ArtistScreen (music/ArtistScreen.kt): the artist's art over their backdrop, Play / Shuffle (every track,
  // by album) and rows of albums, singles & EPs and "appears on", then similar artists; OK on an album opens its page.
  // Focus starts on Play.
  import type { BaseItem } from '$shared/models';
  import Backdrop from '../components/Backdrop.svelte';
  import Cover from '../components/music/Cover.svelte';
  import MediaRow from '../components/MediaRow.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { t } from '../lib/i18n.svelte';
  import { useLoad } from '../lib/load.svelte';
  import { playMusicItem } from '../lib/music.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import { apiOf } from '../lib/session.svelte';

  let { id, title, serverId }: { id: string; title: string; serverId?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;

  // A single or EP is an album of 1 to 3 tracks (ChildCount); an album credited to others is "appears on".
  const artist = useLoad(
    () => `music-artist-${id}`,
    async () => {
      const [item, albums] = await Promise.all([
        client.item(id),
        client.items({ ArtistIds: id, IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' }),
      ]);
      const own = albums.Items.filter((a) => !a.AlbumArtists?.length || a.AlbumArtists.some((x) => x.Id === id));
      const appearsOn = albums.Items.filter((a) => !own.includes(a));
      const single = (a: BaseItem) => (a.ChildCount ?? 0) >= 1 && (a.ChildCount ?? 0) <= 3;
      return { item, albums: own.filter((a) => !single(a)), singles: own.filter(single), appearsOn };
    },
  );
  const similar = useLoad(() => `music-artist-similar-${id}`, () => client.similar(id).catch(() => []));
  const a = $derived(artist.value);
  const rows = $derived(
    a
      ? [
          { key: 'albums', title: t('music_albums'), items: a.albums },
          { key: 'singles', title: t('music_singles'), items: a.singles },
          { key: 'appears', title: t('music_appears_on'), items: a.appearsOn },
          { key: 'similar', title: t('music_similar_artists'), items: similar.value ?? [] },
        ].filter((r) => r.items.length)
      : [],
  );

  let page = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    if (!page || !content) return;
    const band = ((e.target as HTMLElement).closest('[data-artist-row]') as HTMLElement | null) ?? (e.target as HTMLElement);
    const at = band.getBoundingClientRect().top - content.getBoundingClientRect().top;
    y = clamp(y + edgeDelta(at - y, band.offsetHeight, page.clientHeight, dp(56)), 0, Math.max(0, content.offsetHeight - page.clientHeight));
  }
</script>

<div class="artist" bind:this={page} ontvfocus={onfocus}>
  <Backdrop url={a ? client.backdrop(a.item) : undefined} dim={0.55} />
  {#if !a}
    <div class="center">
      {#if artist.error !== undefined}<p class="t-title3 label-2">{t('load_error')}</p>{:else}<Spinner size={40} />{/if}
    </div>
  {:else}
    <div class="content" bind:this={content} style="transform:translate3d(0,{-y}px,0)">
      <div class="head" data-artist-row>
        <Cover src={client.poster(a.item, 480)} name={a.item.Name || title} size={200} round font={64} />
        <div class="text">
          <h1 class="t-large-title name">{a.item.Name || title}</h1>
          <div class="actions">
            <Pill text={t('play')} icon="Play" primary autofocus onclick={() => playMusicItem(client, a.item)} />
            <Pill text={t('music_shuffle')} icon="Shuffle" onclick={() => playMusicItem(client, a.item, true)} />
          </div>
        </div>
      </div>
      {#each rows as r (r.key)}
        <div data-artist-row>
          <MediaRow title={r.title} items={r.items} api={client} square onclick={(i) => nav.push(itemRoute(i))} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .artist {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: var(--bg);
  }
  .content {
    position: relative;
    padding: 48rem 0 56rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .head {
    display: flex;
    align-items: center;
    padding: 0 64rem 16rem;
  }
  .text {
    margin-left: 40rem;
    min-width: 0;
  }
  .name {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    display: flex;
    margin-top: 20rem;
  }
  .actions > :global(* + *) {
    margin-left: 12rem;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
</style>
