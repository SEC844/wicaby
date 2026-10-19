<script lang="ts">
  // Android TV AlbumScreen (music/AlbumScreen.kt): an album or audio playlist, its art and title on the left, Play /
  // Shuffle / Mix and the tracks on the right, then more by the album artist. OK on a track plays the whole list from
  // it; now playing opens over this page, and Back from it lands here with the music still playing. The cover's
  // colour washes the page (from its BlurHash: the TV cannot read a cross-origin image's pixels).
  import type { BaseItem } from '$shared/models';
  import { releaseType } from '$shared/music-ui';
  import Cover from '../components/music/Cover.svelte';
  import MediaRow from '../components/MediaRow.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { focusable } from '../lib/focus';
  import { clock } from '../lib/format';
  import { plural, t } from '../lib/i18n.svelte';
  import { placeholder } from '../lib/images';
  import { useLoad } from '../lib/load.svelte';
  import { music, playMusic } from '../lib/music.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { edgeDelta } from '../lib/scroll';
  import { api } from '../lib/session.svelte';
  import { showToast } from '../lib/toast.svelte';

  let { id, title }: { id: string; title: string } = $props();
  const client = api()!;

  const album = useLoad(
    () => `music-album-${id}`,
    async () => {
      const item = await client.item(id);
      // A playlist keeps its own order; an album goes by disc and track number.
      const order = item.Type === 'Playlist' ? {} : { SortBy: 'ParentIndexNumber,IndexNumber,SortName' };
      const tracks = (await client.items({ ParentId: id, IncludeItemTypes: 'Audio', Recursive: true, ...order, Limit: 1000, Fields: client.trackFields })).Items;
      return { item, tracks };
    },
  );
  const item = $derived(album.value?.item);
  const tracks = $derived(album.value?.tracks ?? []);
  const playlist = $derived(item?.Type === 'Playlist');
  const byArtist = $derived(item?.Type === 'MusicAlbum' ? item.AlbumArtists?.[0] : undefined);
  const more = useLoad(
    () => `music-more-from-${id}-${byArtist?.Id ?? ''}`,
    async () => {
      if (!byArtist) return [] as BaseItem[];
      const by = client.isEmby ? { ArtistIds: byArtist.Id, ArtistType: 'AlbumArtist' } : { AlbumArtistIds: byArtist.Id };
      return (await client.items({ ...by, IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', Limit: 25 })).Items.filter(
        (a) => a.Id !== id,
      );
    },
  );

  const RELEASE: Record<string, string> = { album: 'music_release_album', ep: 'music_release_ep', single: 'music_release_single', compilation: 'music_release_compilation' };
  const totalMs = $derived(tracks.reduce((n, tr) => n + (tr.RunTimeTicks ?? 0), 0) / 10_000);
  const meta = $derived(
    [item?.ProductionYear?.toString(), plural('items_count', tracks.length, tracks.length), totalMs > 0 ? clock(totalMs) : undefined].filter(Boolean).join(' · '),
  );
  const wash = $derived(item ? placeholder(item, 'Primary') : undefined);

  function start(i: number, shuffle = false): void {
    if (!tracks.length) return;
    playMusic(client, tracks, i, shuffle);
    nav.push({ name: 'nowPlaying' });
  }

  async function mix(): Promise<void> {
    if (!item) return;
    const list = (await client.instantMix(item.Id).catch(() => null))?.Items ?? [];
    if (!list.length) return showToast(t('music_mix_none'));
    playMusic(client, list, 0);
    nav.push({ name: 'nowPlaying' });
  }

  // The tracks scroll with the focus.
  let list = $state<HTMLDivElement>();
  function scroll(e: CustomEvent): void {
    if (!list) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    list.scrollTop += edgeDelta(r.top - list.getBoundingClientRect().top, r.height, list.clientHeight, 48);
  }
</script>

<div class="album" style={wash ? `background:linear-gradient(to bottom, ${wash}, var(--bg) 70%), var(--bg)` : ''}>
  {#if !item}
    <div class="center">
      {#if album.error !== undefined}<p class="t-title3 label-2">{t('load_error')}</p>{:else}<Spinner size={40} />{/if}
    </div>
  {:else}
    <div class="side">
      <Cover src={client.poster(item, 640)} name={item.Name || title} size={320} />
      {#if item.Type === 'MusicAlbum' && tracks.length}
        <p class="t-footnote label-3 kind">{t(RELEASE[releaseType(tracks.length, totalMs, item.AlbumArtist)])}</p>
      {/if}
      <p class="t-title2 name" class:first={item.Type !== 'MusicAlbum'}>{item.Name || title}</p>
      {#if item.AlbumArtist}<p class="t-callout label-2 ellipsis">{item.AlbumArtist}</p>{/if}
      <p class="t-footnote label-3 meta">{meta}</p>
    </div>
    <div class="main">
      <div class="actions">
        <Pill text={t('play')} icon="Play" primary autofocus onclick={() => start(0)} />
        <Pill text={t('music_shuffle')} icon="Shuffle" onclick={() => start(Math.floor(Math.random() * tracks.length), true)} />
        <Pill text={t('music_mix')} icon="Mix" onclick={mix} />
      </div>
      <div class="tracks" bind:this={list} ontvfocus={scroll}>
        {#each tracks as tr, i (`${i}:${tr.Id}`)}
          {@const artist = tr.Artists?.join(', ')}
          <button class="track" use:focusable onclick={() => start(i)}>
            <span class="num mono">
              {#if music.session?.currentId === tr.Id && !music.session.released}<span class="dot"></span>{:else}{(playlist ? null : tr.IndexNumber) ?? i + 1}{/if}
            </span>
            <span class="text">
              <span class="t-headline ellipsis title">{tr.Name}</span>
              <!-- The artist only where it differs from the album's (a compilation, a featured artist, a playlist). -->
              {#if artist && artist !== item.AlbumArtist}<span class="t-callout ellipsis sub">{artist}</span>{/if}
            </span>
            {#if tr.RunTimeTicks}<span class="mono time">{clock(tr.RunTimeTicks / 10_000)}</span>{/if}
          </button>
        {/each}
        {#if byArtist && more.value?.length}
          <div class="more">
            <MediaRow title={t('music_more_from', byArtist.Name)} items={more.value} api={client} square onclick={(a) => nav.push(itemRoute(a))} />
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .album {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    padding: 48rem 64rem 0;
    background: var(--bg);
  }
  .side {
    width: 320rem;
    flex-shrink: 0;
  }
  p {
    margin: 0;
  }
  .kind {
    margin-top: 20rem;
  }
  .name {
    margin-top: 2rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .name.first {
    margin-top: 20rem;
  }
  .meta {
    margin-top: 4rem;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    margin-left: 48rem;
  }
  .actions {
    display: flex;
  }
  .actions > :global(* + *) {
    margin-left: 12rem;
  }
  .tracks {
    flex: 1;
    margin-top: 16rem;
    padding: 8rem 0 48rem;
    overflow: hidden;
  }
  .track {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 10rem 16rem;
    border-radius: var(--r-sm);
    color: var(--label);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .track:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.02);
  }
  .num {
    width: 36rem;
    flex-shrink: 0;
  }
  .mono {
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
    color: var(--label-3);
  }
  .track:global(.focused) .mono,
  .track:global(.focused) .sub {
    color: rgba(0, 0, 0, 0.6);
  }
  .dot {
    display: block;
    width: 8rem;
    height: 8rem;
    border-radius: 50%;
    background: var(--accent);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sub {
    color: var(--label-3);
  }
  .time {
    margin-left: 16rem;
  }
  .more {
    margin-top: 24rem;
    margin-left: -48rem;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
</style>
