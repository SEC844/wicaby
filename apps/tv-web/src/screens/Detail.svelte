<script lang="ts">
  // Android TV DetailScreen (Detail.kt): the title over its backdrop, its technical badges, the actions (Play or
  // Resume, From the start, Shuffle, Trailer, Favorite, Watched, More), the version / audio / subtitle pickers, then a
  // series' seasons and episodes, and the bonus videos. The page stays at the top while the focus is on the first
  // screen, then scrolls by its edges (HeroSpec).
  // Left out: the external player (Android only) and "Available on 2 servers" (Android's copies on other servers).
  import type { BaseItem } from '$shared/models';
  import Backdrop from '../components/Backdrop.svelte';
  import Card from '../components/Card.svelte';
  import HeroText from '../components/HeroText.svelte';
  import HScroll from '../components/HScroll.svelte';
  import ItemActions from '../components/ItemActions.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TogetherSheet from '../components/TogetherSheet.svelte';
  import { focusable } from '../lib/focus';
  import { episodeLine, runtimeText, TICKS_PER_MS } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { changed, useLoad } from '../lib/load.svelte';
  import { badges, hasTrailer, isBook, remoteTrailer, resumeMs, resumePage } from '../lib/media';
  import { showAlert } from '../lib/overlay.svelte';
  import { openRemoteTrailer, play, playTrailer, read, shuffle } from '../lib/playback';
  import { dp } from '../lib/screen';
  import { clamp, heroDelta } from '../lib/scroll';
  import { externalRatings, ratingLabel, ratings } from '../lib/ratings.svelte';
  import { syncAvailable } from '../lib/syncplay.svelte';
  import * as Trakt from '../lib/trakt.svelte';
  import { apiOf } from '../lib/session.svelte';
  import { trackName } from '../lib/track-memory';
  import * as Versions from '../lib/versions';

  let { id, serverId }: { id: string; serverId?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;

  let reload = $state(0);
  const loaded = useLoad(() => `item-${id}-${reload}`, () => client.item(id));
  const item = $derived(loaded.value);
  const series = $derived(item?.Type === 'Series');
  const book = $derived(!!item && isBook(item));

  const seasons = useLoad(() => (series ? `seasons-${id}` : 'none'), () => (series ? client.seasons(id) : Promise.resolve([])));
  const nextUp = useLoad(() => (series ? `nextup-${id}` : 'none-next'), () => (series ? client.nextUp(id, 1) : Promise.resolve([])));
  // The season of the next episode to watch, else the first; then whichever the user picks. Next-up is waited for:
  // a seasons reply that lands first must not pin Season 1.
  let picked = $state(-1);
  const nextKnown = $derived(nextUp.value !== undefined || nextUp.error !== undefined);
  const seasonIndex = $derived(
    picked >= 0 ? picked : Math.max(0, (seasons.value ?? []).findIndex((s) => s.Id === nextUp.value?.[0]?.SeasonId)),
  );
  const season = $derived(picked >= 0 || nextKnown ? seasons.value?.[seasonIndex] : undefined);
  const episodes = useLoad(() => (season ? `episodes-${id}-${season.Id}` : 'none-ep'), () => (season ? client.episodes(id, season.Id) : Promise.resolve([])));
  // The last season's episodes stay while the next one loads, so the row does not collapse and shift the page.
  let shownEpisodes = $state<BaseItem[]>([]);
  $effect(() => {
    if (episodes.value !== undefined) shownEpisodes = episodes.value;
    else if (episodes.error !== undefined) shownEpisodes = [];
  });
  // IMDb, Rotten Tomatoes…: only once the user set an MDBList key (Settings > Home and libraries).
  const external = useLoad(
    () => (item ? `ratings-${id}-${ratings.configured}` : 'ratings-none'),
    () => (ratings.configured && item ? externalRatings(item) : Promise.resolve([])),
    { refresh: false },
  );
  // Making-of, deleted scenes…: none for books, and none when the server lacks the route.
  const extras = useLoad(() => (book ? 'none-extras' : `extras-${id}`), () => (book ? Promise.resolve([]) : client.specialFeatures(id)));

  // The toggles answer at once; the next load of the item takes over.
  let favorite = $derived(item?.UserData?.IsFavorite === true);
  let watched = $derived(item?.UserData?.Played === true);
  const target = $derived<BaseItem | undefined>(series ? (nextUp.value?.[0] ?? episodes.value?.[0]) : item);
  const resume = $derived(target ? resumeMs(target) : 0);
  const bookPage = $derived(item && book ? resumePage(item) : null);
  // Versions: the remembered one; audio and subtitles follow the selected version.
  let sourceId = $derived(item ? Versions.selected(item)?.Id : undefined);
  const source = $derived(item?.MediaSources?.find((s) => s.Id === sourceId) ?? item?.MediaSources?.[0]);
  const tags = $derived(item ? badges(item, source) : []);
  const ratingTags = $derived((external.value ?? []).map(ratingLabel));

  const playLabel = $derived.by(() => {
    if (book) return bookPage !== null ? t('reader_resume_page', bookPage + 1) : t('reader_read');
    if (!target) return t('play');
    if (resume > 0) {
      const left = runtimeText(Math.max(0, (target.RunTimeTicks ?? 0) - resume * TICKS_PER_MS));
      return left ? t('resume_time_left', left) : t('resume');
    }
    if (series && target.IndexNumber != null) return t('play_episode', t('episode_code', target.ParentIndexNumber ?? 1, target.IndexNumber ?? 0));
    return t('play');
  });

  function onPlay(): void {
    if (book && item) read(item);
    else if (target) play(target);
  }

  function fromStart(): void {
    if (book && item) read(item, { fromStart: true });
    else if (target) play(target, { fromStart: true });
  }

  // Flipped at once (a second press before the reply then sends the right value), back on a failure.
  async function toggleFavorite(): Promise<void> {
    if (!item) return;
    const on = !favorite;
    favorite = on;
    try {
      await client.setFavorite(item.Id, on);
      changed();
    } catch {
      favorite = !on;
    }
  }

  async function toggleWatched(): Promise<void> {
    if (!item) return;
    const on = !watched;
    watched = on;
    try {
      await client.setPlayed(item.Id, on);
      Trakt.history(client, item, on);
      changed();
    } catch {
      watched = !on;
    }
  }

  let together = $state(false);

  // "Bande-annonce": a local trailer plays in the app's player (reporting nothing); a remote one opens elsewhere.
  async function trailer(): Promise<void> {
    if (!item) return;
    if ((item.LocalTrailerCount ?? 0) > 0) {
      const local = (await client.localTrailers(item.Id).catch(() => []))[0];
      if (local) return playTrailer(local);
    }
    const url = remoteTrailer(item);
    if (url) openRemoteTrailer(url);
  }

  // --- Version, Audio, Subtitles: each opens a picker; the lists are the selected version's. ---
  const audio = $derived(source?.MediaStreams?.filter((s) => s.Type === 'Audio') ?? []);
  const subs = $derived(source?.MediaStreams?.filter((s) => s.Type === 'Subtitle') ?? []);
  const versions = $derived(item?.MediaSources ?? []);
  const versionLabels = $derived(item ? Versions.labels(item) : []);
  let pickVersion = $state(0);
  const pick = $derived.by(() => {
    void pickVersion;
    return item && source ? Versions.pick(item.Id, source.Id) : undefined;
  });
  const audioIndex = $derived(Math.max(0, audio.findIndex((s) => s.Index === (pick?.audio ?? (source ? Versions.defaultAudioStream(source)?.Index : undefined)))));
  const subIndex = $derived(Math.max(0, subs.findIndex((s) => s.Index === (pick?.subtitle ?? (source ? Versions.defaultSubtitleIndex(source) : -1))) + 1));
  const showTracks = $derived(!series && !book && !!source && (versions.length > 1 || audio.length > 1 || subs.length > 0));

  function picker(title: string, labels: string[], selected: number, onpick: (i: number) => void): void {
    showAlert({ title, actions: labels.map((label, i) => ({ label, run: () => onpick(i) })), selected });
  }

  function setPick(p: Versions.TrackPick): void {
    if (!item || !source) return;
    Versions.setPick(item.Id, source.Id, { ...pick, ...p });
    pickVersion++;
  }

  // --- Vertical scroll (HeroSpec, 56 dp margin) ---
  let page = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    if (!page || !content) return;
    const el = e.target as HTMLElement;
    // The focused element's band: its row when it sits in one (a card's lift must not move the page).
    const band = (el.closest('[data-detail-band]') as HTMLElement | null) ?? el;
    const top = band.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const max = Math.max(0, content.offsetHeight - page.clientHeight);
    y = clamp(y + heroDelta(top - y, band.offsetHeight, page.clientHeight, dp(56), y), 0, max);
  }
</script>

<div class="detail" bind:this={page} ontvfocus={onfocus}>
  <!-- Books rarely have a backdrop: their cover fills the background. -->
  <Backdrop url={item ? (client.backdrop(item) ?? (book ? client.poster(item, 1080) : undefined)) : undefined} />
  {#if !item}
    <div class="center">
      {#if loaded.error !== undefined}
        <p class="t-title3 label-2">{t('load_error')}</p>
        <Pill text={t('retry')} icon="Refresh" autofocus onclick={() => reload++} />
      {:else}
        <Spinner size={40} />
      {/if}
    </div>
  {:else}
    <div class="content" bind:this={content} style="transform:translate3d(0,{-y}px,0)">
      <div class="head" class:series>
        <div data-detail-band>
          {#if item.Type === 'Episode'}<p class="episode t-title3">{episodeLine(item) ?? ''}</p>{/if}
          <div class="hero-text"><HeroText api={client} {item} overviewLines={4} /></div>
          {#each [ratingTags, tags] as list, n (n)}
            {#if list.length}
              <div class="tags">
                {#each list as tag (tag)}<span class="tag t-caption">{tag}</span>{/each}
              </div>
            {/if}
          {/each}
        </div>
        <div class="actions" data-detail-band data-focus-group>
          <Pill text={playLabel} icon="Play" primary autofocus onclick={onPlay} />
          {#if (book ? bookPage !== null : resume > 0) && target}
            <Pill text={t('from_start')} icon="Restart" onclick={fromStart} />
          {/if}
          <!-- TP-04: every episode in random order, as a play queue. -->
          {#if series || item.Type === 'Season'}
            <Pill text={t('shuffle')} icon="Shuffle" onclick={() => shuffle(item)} />
          {/if}
          <!-- Jellyfin SyncPlay: watch this with others, or join a group. -->
          {#if !book && target && syncAvailable(client)}<Pill icon="Group" description={t('syncplay_title')} onclick={() => (together = true)} />{/if}
          {#if hasTrailer(item)}<Pill text={t('trailer')} icon="Movie" onclick={trailer} />{/if}
          <Pill icon={favorite ? 'Heart' : 'HeartOutline'} description={t('favorite')} onclick={toggleFavorite} />
          <!-- The icon carries the state, like the heart: a focused pill is white whatever `selected` says. -->
          <Pill icon={watched ? 'CheckCircle' : 'Check'} selected={watched} description={t('watched')} onclick={toggleWatched} />
          <ItemActions api={client} {item} />
        </div>
        {#if showTracks && source}
          <div class="tracks" data-detail-band data-focus-group>
            {#if versions.length > 1}
              {@const i = Math.max(0, versions.findIndex((v) => v.Id === source.Id))}
              <button class="selector" use:focusable onclick={() => picker(t('version'), versionLabels, i, (n) => {
                sourceId = versions[n].Id;
                Versions.select(item.Id, versions[n].Id);
              })}>
                <span class="key t-callout">{t('version')}</span><span class="value t-callout ellipsis">{versionLabels[i] ?? ''}</span>
              </button>
            {/if}
            {#if audio.length > 1}
              <button class="selector" use:focusable onclick={() => picker(t('audio'), audio.map(trackName), audioIndex, (n) => setPick({ audio: audio[n].Index }))}>
                <span class="key t-callout">{t('audio')}</span><span class="value t-callout ellipsis">{trackName(audio[audioIndex])}</span>
              </button>
            {/if}
            {#if subs.length}
              {@const names = [t('subtitles_off'), ...subs.map(trackName)]}
              <button class="selector" use:focusable onclick={() => picker(t('subtitles'), names, subIndex, (n) => setPick({ subtitle: n === 0 ? -1 : subs[n - 1].Index }))}>
                <span class="key t-callout">{t('subtitles')}</span><span class="value t-callout ellipsis">{names[subIndex]}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>

      {#if series && seasons.value?.length}
        <div class="seasons" data-detail-band>
          <HScroll spacing={10} padding={[6, 56, 6, 56]}>
            {#each seasons.value as s, i (s.Id)}
              <div data-row-item ontvfocus={() => (picked = i)}>
                <Pill text={s.Name?.trim() || t('season_n', s.IndexNumber ?? i + 1)} primary={i === seasonIndex} onclick={() => (picked = i)} />
              </div>
            {/each}
          </HScroll>
        </div>
        <div data-detail-band>
          <HScroll spacing={22} padding={[18, 56, 40, 56]}>
            {#each shownEpisodes as ep (ep.Id)}
              <div data-row-item><Card item={ep} api={client} variant="thumb" inSeries onclick={() => play(ep)} /></div>
            {/each}
          </HScroll>
        </div>
      {:else}
        <div class="spacer"></div>
      {/if}

      {#if extras.value?.length}
        <h3 class="t-title3 bonus">{t('bonus')}</h3>
        <div data-detail-band>
          <!-- Played like a trailer: from the start, nothing reported. -->
          <HScroll spacing={22} padding={[14, 56, 40, 56]}>
            {#each extras.value as ex (ex.Id)}
              <div data-row-item><Card item={ex} api={client} variant="thumb" inSeries onclick={() => playTrailer(ex)} /></div>
            {/each}
          </HScroll>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if together && target}
  <TogetherSheet api={client} itemId={target.Id} startMs={resume} onclose={() => (together = false)} />
{/if}

<style>
  .detail {
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
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .head {
    padding: 150rem 0 0 56rem;
  }
  .head.series {
    padding-top: 110rem;
  }
  .episode {
    margin: 0 0 6rem;
  }
  .hero-text {
    width: 600rem;
  }
  .tags {
    display: flex;
    margin-top: 14rem;
  }
  .tag {
    margin-right: 8rem;
    padding: 3rem 7rem;
    border: 1rem solid var(--label-3);
    border-radius: var(--r-xs);
    color: var(--label-2);
  }
  .actions {
    display: flex;
    margin-top: 24rem;
  }
  .actions > :global(*) {
    margin-right: 12rem;
  }
  .tracks {
    display: flex;
    margin-top: 16rem;
  }
  /* "Version  4K HDR · HEVC": a quiet two-tone pill, white when focused. */
  .selector {
    display: flex;
    align-items: center;
    margin-right: 10rem;
    padding: 8rem 16rem;
    border-radius: 999rem;
    background: var(--fill-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .selector:global(.focused) {
    background: #fff;
    transform: scale(1.06);
  }
  .key {
    margin-right: 8rem;
    color: var(--label-3);
  }
  .value {
    max-width: 260rem;
    color: var(--label);
  }
  .selector:global(.focused) .key {
    color: rgba(0, 0, 0, 0.6);
  }
  .selector:global(.focused) .value {
    color: #000;
  }
  .seasons {
    margin-top: 30rem;
  }
  .spacer {
    height: 48rem;
  }
  .bonus {
    margin: 0 0 0 56rem;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .center p {
    margin: 0 0 16rem;
  }
</style>
