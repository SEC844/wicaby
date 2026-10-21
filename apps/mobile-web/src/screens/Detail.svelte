<script lang="ts">
  // A title's page, as the Apple TV app lays it out on a phone, with Wicaby's own content (Android Detail.kt): the
  // artwork full bleed under the status bar (it stretches when pulled), the logo, facts and technical badges, Play
  // across the width (Resume with the time left), round glass actions under it, the overview, the version / audio /
  // subtitle choices, a series' seasons and episodes, the cast, bonus videos, similar titles and the details.
  // The data and its rules are the TV web app's (versions, track memory, Trakt, toggles answered at once).
  import type { BaseItem, MediaStream } from '$shared/models';
  import { episodeLine, runtimeText, TICKS_PER_MS } from '$tv/format';
  import { plural, t } from '$tv/i18n.svelte';
  import { placeholder } from '$tv/images';
  import { changed, useLoad } from '$tv/load.svelte';
  import { badges, hasTrailer, isBook, remoteTrailer, resumeMs, resumePage } from '$tv/media';
  import { openRemoteTrailer, play, playTrailer, read, shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { trackName } from '$tv/track-memory';
  import * as Trakt from '$tv/trakt.svelte';
  import * as Versions from '$tv/versions';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Clapperboard from '@lucide/svelte/icons/clapperboard';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Heart from '@lucide/svelte/icons/heart';
  import Play from '@lucide/svelte/icons/play';
  import Card from '../components/Card.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { factsLine } from '../lib/format';
  import { handleBack, itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';

  let { id, serverId }: { id: string; serverId?: string } = $props();
  // A page is opened for one title and never re-targeted: the initial value is the value.
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const dpr = Math.min(3, window.devicePixelRatio || 2);

  let reload = $state(0);
  const loaded = useLoad(() => `item-${id}-${reload}`, () => client.item(id));
  const item = $derived(loaded.value);
  const series = $derived(item?.Type === 'Series');
  const book = $derived(!!item && isBook(item));

  const seasons = useLoad(() => (series ? `seasons-${id}` : 'none'), () => (series ? client.seasons(id) : Promise.resolve([])));
  const nextUp = useLoad(() => (series ? `nextup-${id}` : 'none-next'), () => (series ? client.nextUp(id, 1) : Promise.resolve([])));
  // The season of the next episode to watch, else the first; then whichever the user picks.
  let picked = $state(-1);
  const nextKnown = $derived(nextUp.value !== undefined || nextUp.error !== undefined);
  const seasonIndex = $derived(picked >= 0 ? picked : Math.max(0, (seasons.value ?? []).findIndex((s) => s.Id === nextUp.value?.[0]?.SeasonId)));
  const season = $derived(picked >= 0 || nextKnown ? seasons.value?.[seasonIndex] : undefined);
  const episodes = useLoad(() => (season ? `episodes-${id}-${season.Id}` : 'none-ep'), () => (season ? client.episodes(id, season.Id) : Promise.resolve([])));
  // The last season's episodes stay while the next one loads, so the row does not collapse and shift the page.
  let shownEpisodes = $state<BaseItem[]>([]);
  $effect(() => {
    if (episodes.value !== undefined) shownEpisodes = episodes.value;
    else if (episodes.error !== undefined) shownEpisodes = [];
  });
  const extras = useLoad(() => (book ? 'none-extras' : `extras-${id}`), () => (book ? Promise.resolve([]) : client.specialFeatures(id)));
  const similar = useLoad(() => `similar-${id}`, () => client.similar(id, 16));

  // The toggles answer at once; the next load of the item takes over.
  let favorite = $derived(item?.UserData?.IsFavorite === true);
  let watched = $derived(item?.UserData?.Played === true);
  const target = $derived<BaseItem | undefined>(series ? (nextUp.value?.[0] ?? shownEpisodes[0]) : item);
  const resume = $derived(target ? resumeMs(target) : 0);
  const bookPage = $derived(item && book ? resumePage(item) : null);
  let sourceId = $derived(item ? Versions.selected(item)?.Id : undefined);
  const source = $derived(item?.MediaSources?.find((s) => s.Id === sourceId) ?? item?.MediaSources?.[0]);
  const tags = $derived(item ? badges(item, source) : []);

  const playLabel = $derived.by(() => {
    if (book) return bookPage !== null ? t('reader_resume_page', bookPage + 1) : t('reader_read');
    if (!target) return t('play');
    if (resume > 0) {
      const left = runtimeText(Math.max(0, (target.RunTimeTicks ?? 0) - resume * TICKS_PER_MS));
      return left ? t('resume_time_left', left) : t('resume');
    }
    if (series && target.IndexNumber != null) return t('play_episode', target.ParentIndexNumber ?? 1, target.IndexNumber);
    return t('play');
  });
  const resumeShare = $derived(target && resume > 0 && target.RunTimeTicks ? Math.min(1, (resume * TICKS_PER_MS) / target.RunTimeTicks) : 0);

  function onPlay(): void {
    if (book && item) read(item);
    else if (target) play(target);
  }

  function fromStart(): void {
    if (book && item) read(item, { fromStart: true });
    else if (target) play(target, { fromStart: true });
  }

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

  // A local trailer plays in the app's player (reporting nothing); a remote one opens elsewhere.
  async function trailer(): Promise<void> {
    if (!item) return;
    if ((item.LocalTrailerCount ?? 0) > 0) {
      const local = (await client.localTrailers(item.Id).catch(() => []))[0];
      if (local) return playTrailer(local);
    }
    const url = remoteTrailer(item);
    if (url) openRemoteTrailer(url);
  }

  function more(): void {
    if (!item) return;
    showAlert({
      title: item.Name,
      actions: [
        ...((book ? bookPage !== null : resume > 0) && target ? [{ label: t('from_start'), run: fromStart }] : []),
        ...(series || item.Type === 'Season' ? [{ label: t('shuffle'), run: () => void shuffle(item) }] : []),
        { label: watched ? t('mark_unplayed') : t('mark_played'), run: () => void toggleWatched() },
      ],
    });
  }

  // --- Version, audio, subtitles: each opens a picker; the lists are the selected version's. ---
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
  const subNames = $derived([t('subtitles_off'), ...subs.map((s: MediaStream) => trackName(s))]);

  function picker(title: string, labels: string[], selected: number, onpick: (i: number) => void): void {
    showAlert({ title, actions: labels.map((label, i) => ({ label, run: () => onpick(i) })), selected });
  }

  function setPick(p: Versions.TrackPick): void {
    if (!item || !source) return;
    Versions.setPick(item.Id, source.Id, { ...pick, ...p });
    pickVersion++;
  }

  function pickSeason(): void {
    const list = seasons.value ?? [];
    picker(t('seasons'), list.map((s, i) => s.Name?.trim() || t('season_n', s.IndexNumber ?? i + 1)), seasonIndex, (n) => (picked = n));
  }

  // --- The page: stretchy artwork, and a bar once the title has scrolled away. ---
  let scroller: HTMLElement;
  let art = $state<HTMLElement>();
  let solid = $state(false);
  let expanded = $state(false);
  function onScroll(): void {
    const y = scroller.scrollTop;
    if (art) art.style.setProperty('--stretch', String(1 + Math.max(0, -y) / art.offsetHeight));
    solid = y > (art ? art.offsetHeight - 110 : 60);
  }

  const people = $derived((item?.People ?? []).filter((p) => p.Type === 'Actor').slice(0, 20));
  const directors = $derived((item?.People ?? []).filter((p) => p.Type === 'Director').map((p) => p.Name));
  // Without a backdrop (books, home videos, some series) the poster fills the artwork.
  const backdrop = $derived(item ? (client.backdrop(item, Math.round(1100 * dpr)) ?? client.poster(item, Math.round(900 * dpr))) : undefined);
  const logo = $derived(item ? client.logo(item, Math.round(300 * dpr)) : undefined);
  const info = $derived.by(() => {
    if (!item) return [];
    return [
      [t('web_genres'), item.Genres?.join(', ')],
      [t('web_directed'), directors.join(', ')],
      [t('web_studio'), item.Studios?.map((s) => s.Name).join(', ')],
      [t('web_released'), item.PremiereDate ? new Date(item.PremiereDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : item.ProductionYear?.toString()],
      [t('web_runtime'), series ? undefined : runtimeText(item.RunTimeTicks)],
      [t('web_rated'), item.OfficialRating],
    ].filter((r): r is [string, string] => !!r[1]);
  });
</script>

<div class="page">
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    {#if !item}
      <div class="center">
        {#if loaded.error !== undefined}
          <p class="title-3 label-2">{t('load_error')}</p>
          <button class="btn-light pressable" onclick={() => reload++}>{t('retry')}</button>
        {:else}
          <Spinner size={32} />
        {/if}
      </div>
    {:else}
      <div class="art" bind:this={art} style:background-color={placeholder(item, 'Backdrop') ?? placeholder(item, 'Primary') ?? '#111'}>
        {#if backdrop}<img src={backdrop} alt="" decoding="async" fetchpriority="high" />{/if}
        <div class="shade"></div>
        <div class="mark">
          {#if logo}
            <img class="logo" src={logo} alt={item.Name} decoding="async" />
          {:else}
            <h1 class="title-1 name">{item.Type === 'Episode' ? (item.SeriesName ?? item.Name) : item.Name}</h1>
          {/if}
        </div>
      </div>

      <div class="body">
        {#if item.Type === 'Episode'}<p class="headline center-text">{episodeLine(item) ?? ''}</p>{/if}
        <p class="footnote label-2 center-text">{factsLine(item)}{item.CommunityRating ? ` · ★ ${item.CommunityRating.toFixed(1)}` : ''}</p>
        {#if tags.length}
          <div class="tags">
            {#each tags as tag (tag)}<span class="tag caption">{tag}</span>{/each}
          </div>
        {/if}

        <button class="btn-light play pressable" onclick={onPlay} disabled={!target && !book}>
          <Play size={20} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          <span class="ellipsis">{playLabel}</span>
        </button>
        {#if resumeShare > 0}<div class="resume" aria-hidden="true"><span style:transform="scaleX({resumeShare})"></span></div>{/if}

        <div class="actions">
          {#if hasTrailer(item)}
            <button class="action" onclick={trailer}><span class="btn-round glass"><Clapperboard size={21} aria-hidden="true" /></span><span class="caption label-2">{t('trailer')}</span></button>
          {/if}
          <button class="action" aria-pressed={favorite} onclick={toggleFavorite}>
            <span class="btn-round glass" class:on={favorite}><Heart size={21} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" /></span>
            <span class="caption label-2">{t('favorite')}</span>
          </button>
          <button class="action" aria-pressed={watched} onclick={toggleWatched}>
            <span class="btn-round glass" class:on={watched}><Check size={22} strokeWidth={watched ? 2.6 : 1.8} aria-hidden="true" /></span>
            <span class="caption label-2">{t('watched')}</span>
          </button>
          <button class="action" onclick={more}><span class="btn-round glass"><Ellipsis size={22} aria-hidden="true" /></span><span class="caption label-2">{t('more')}</span></button>
        </div>

        {#if item.Overview}
          <button class="overview callout" class:expanded onclick={() => (expanded = !expanded)}>
            <span class="text">{item.Overview}</span>
            {#if !expanded}<span class="more footnote">{t('more').toUpperCase()}</span>{/if}
          </button>
        {/if}

        {#if showTracks && source}
          <div class="group">
            {#if versions.length > 1}
              {@const i = Math.max(0, versions.findIndex((v) => v.Id === source.Id))}
              <button
                class="cell"
                onclick={() =>
                  picker(t('version'), versionLabels, i, (n) => {
                    sourceId = versions[n].Id;
                    Versions.select(item.Id, versions[n].Id);
                  })}
              >
                <span class="key">{t('version')}</span><span class="value label-2 ellipsis">{versionLabels[i] ?? ''}</span>
              </button>
            {/if}
            {#if audio.length > 1}
              <button class="cell" onclick={() => picker(t('audio'), audio.map((s) => trackName(s)), audioIndex, (n) => setPick({ audio: audio[n].Index }))}>
                <span class="key">{t('audio')}</span><span class="value label-2 ellipsis">{trackName(audio[audioIndex])}</span>
              </button>
            {/if}
            {#if subs.length}
              <button class="cell" onclick={() => picker(t('subtitles'), subNames, subIndex, (n) => setPick({ subtitle: n === 0 ? -1 : subs[n - 1].Index }))}>
                <span class="key">{t('subtitles')}</span><span class="value label-2 ellipsis">{subNames[subIndex]}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>

      {#if series && seasons.value?.length}
        <section class="episodes">
          <button class="season glass" onclick={pickSeason} disabled={seasons.value.length < 2}>
            <span class="headline">{season?.Name?.trim() || t('season_n', season?.IndexNumber ?? seasonIndex + 1)}</span>
            {#if seasons.value.length > 1}<ChevronDown size={18} strokeWidth={2.4} aria-hidden="true" />{/if}
          </button>
          <div class="shelf-row">
            {#each shownEpisodes as ep (ep.Id)}
              <div class="episode">
                <Card item={ep} api={client} wide width={Math.min(300, Math.round(window.innerWidth * 0.74))} subtitle={[t('episode_code', ep.ParentIndexNumber ?? 1, ep.IndexNumber ?? 0), runtimeText(ep.RunTimeTicks)].filter(Boolean).join(' · ')} onclick={() => play(ep)} />
                <p class="footnote label-2 synopsis">{ep.Overview ?? ''}</p>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if people.length}
        <section class="people">
          <h2 class="title-3 head">{t('cast')}</h2>
          <div class="shelf-row">
            {#each people as p (p.Id + (p.Role ?? ''))}
              {@const face = p.PrimaryImageTag ? client.image(p.Id, 'Primary', p.PrimaryImageTag, { maxHeight: Math.round(96 * dpr) }) : undefined}
              <div class="person">
                <span class="face">
                  {#if face}<img src={face} alt="" loading="lazy" decoding="async" />{:else}<span class="initial">{p.Name.slice(0, 1)}</span>{/if}
                </span>
                <span class="footnote ellipsis">{p.Name}</span>
                {#if p.Role}<span class="caption label-2 ellipsis">{p.Role}</span>{/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if extras.value?.length}
        <Shelf title={t('bonus')} items={extras.value} api={client} wide onopen={(i) => playTrailer(i)} />
      {/if}
      {#if similar.value?.length}
        <Shelf title={t('similar')} items={similar.value} api={client} onopen={(i) => nav.push(itemRoute(i))} />
      {/if}

      {#if info.length}
        <section class="info">
          <h2 class="title-3">{t('web_info')}</h2>
          <dl>
            {#each info as [k, v] (k)}
              <div><dt class="footnote label-2">{k}</dt><dd class="subhead">{v}</dd></div>
            {/each}
          </dl>
          {#if (item.MediaSources?.length ?? 0) > 1}<p class="footnote label-3">{plural('versions_count', item.MediaSources!.length, item.MediaSources!.length)}</p>{/if}
        </section>
      {/if}
    {/if}
  </div>

  <div class="bar" class:solid>
    <span class="headline ellipsis">{item?.Name ?? ''}</span>
  </div>
  <button class="back glass-media" class:solid aria-label={t('back')} onclick={() => handleBack()}>
    <ChevronLeft size={26} strokeWidth={2.2} aria-hidden="true" />
  </button>
</div>

<style>
  .page {
    position: relative;
    height: 100%;
  }
  .scroller {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding-bottom: calc(var(--tabbar) + 24px);
  }
  .center {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--label-2);
  }
  .art {
    position: relative;
    height: min(calc(100vw * 1.12), 540px);
    overflow: hidden;
    transform-origin: 50% 100%;
    transform: scale(var(--stretch, 1));
  }
  .art > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 25%;
  }
  .shade {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to bottom, rgb(0 0 0 / 0.45), rgb(0 0 0 / 0) 24%),
      linear-gradient(to top, var(--bg) 0%, color-mix(in srgb, var(--bg) 70%, transparent) 18%, rgb(0 0 0 / 0) 55%);
  }
  .mark {
    position: absolute;
    left: var(--gutter);
    right: var(--gutter);
    bottom: 14px;
    display: grid;
    place-items: center;
    text-align: center;
  }
  .logo {
    max-width: min(76vw, 320px);
    max-height: 120px;
    object-fit: contain;
    filter: drop-shadow(0 2px 14px rgb(0 0 0 / 0.5));
  }
  .name {
    color: #fff;
    text-shadow: 0 2px 16px rgb(0 0 0 / 0.55);
  }
  :global([data-theme='light']) .name {
    color: var(--label);
    text-shadow: none;
  }
  .body {
    padding: 4px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .center-text {
    text-align: center;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
  }
  .tag {
    padding: 2px 7px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1px var(--label-3);
    color: var(--label-2);
    font-weight: 600;
  }
  .play {
    width: 100%;
    margin-top: 6px;
  }
  .play:disabled {
    opacity: 0.5;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .resume {
    height: 3px;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
    margin: -4px 24px 0;
  }
  .resume span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }
  .actions {
    display: flex;
    justify-content: space-evenly;
    gap: 4px;
    margin-top: 4px;
  }
  .action {
    flex: 1;
    min-width: 0;
    max-width: 84px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .action .caption {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn-round.on {
    color: var(--accent);
  }
  .overview {
    text-align: left;
    position: relative;
    color: var(--label);
    line-height: 1.4;
  }
  .overview .text {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .overview.expanded .text {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .overview .more {
    position: absolute;
    right: 0;
    bottom: 0;
    padding-left: 32px;
    font-weight: 700;
    background: linear-gradient(to right, transparent, var(--bg) 28px);
  }
  .group {
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    overflow: hidden;
    margin-top: 6px;
  }
  .cell {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    text-align: left;
  }
  .cell + .cell {
    border-top: 0.5px solid var(--separator);
  }
  .cell:active {
    background: var(--fill-2);
  }
  .key {
    flex: none;
  }
  .value {
    flex: 1;
    text-align: right;
  }
  .episodes {
    margin-top: 28px;
  }
  .season {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 38px;
    padding: 0 16px;
    border-radius: 19px;
    margin: 0 0 14px max(var(--gutter), var(--safe-left));
  }
  .episode {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .synopsis {
    width: min(300px, 74vw);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .people {
    margin-top: 28px;
  }
  .head {
    padding: 0 max(var(--gutter), var(--safe-right)) 10px max(var(--gutter), var(--safe-left));
  }
  .person {
    width: 84px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    text-align: center;
  }
  .person .ellipsis {
    max-width: 100%;
  }
  .face {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--fill-2);
    display: grid;
    place-items: center;
    margin-bottom: 6px;
  }
  .face img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .initial {
    font-size: 28px;
    font-weight: 600;
    color: var(--label-2);
  }
  .info {
    margin: 32px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  dl {
    margin: 12px 0 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 16px;
  }
  dd {
    margin: 2px 0 0;
  }
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: calc(var(--safe-top) + 44px);
    padding: var(--safe-top) 64px 0;
    display: grid;
    place-items: center;
    background: var(--glass-fill);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    border-bottom: 0.5px solid var(--separator);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-fast) linear;
    z-index: 4;
  }
  .bar.solid {
    opacity: 1;
  }
  .back {
    position: absolute;
    top: calc(var(--safe-top) + 2px);
    left: max(12px, var(--safe-left));
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    z-index: 5;
  }
  .back.solid {
    background: transparent;
    box-shadow: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    color: var(--accent);
  }
</style>
