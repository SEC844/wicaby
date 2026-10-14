<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { comicPageFromTicks, TICKS_PER_MS, type PlayRequest } from '../../shared/contract';
  import { hdrChip, hdrFromStream } from '../../shared/hdr';
  import type { BaseItem, MediaStream } from '../../shared/models';
  import BrowseMenu from '../components/BrowseMenu.svelte';
  import ItemMenu from '../components/ItemMenu.svelte';
  import PlaylistItems from '../components/PlaylistItems.svelte';
  import AlbumTracks from '../components/music/AlbumTracks.svelte';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import Row from '../components/Row.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { apiFor, fanOut, itemKey, itemPath, markPlayed, playQueueFor, sameTitle } from '../lib/api';
  import { w } from '../lib/bridge';
  import { castOptions, openCastPicker } from '../lib/cast.svelte';
  import { badges, bytes, clock, endsAt, episodeCode, progress, remaining, runtime, typeLabel, yearRange } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { backdropUrl, imageUrl, logoUrl, posterUrl, thumbUrl } from '../lib/images';
  import { morphFrom, morphName, peek, peekSrc, remember, reveal, scrollMemory, takeMorph } from '../lib/motion';
  import { artColour, initials as musicInitials, isMusicItem, musicArtLater, needsLookup, placeholderBg } from '../lib/music-art';
  import { playMix, playTracks } from '../lib/music-ui.svelte';
  import { queue, queueModes } from '../lib/queue.svelte';
  import { resumeAt } from '../lib/resume.svelte';
  import { navigate } from '../lib/router.svelte';
  import { dataVersion, downloads, errorMessage, multiServer, serverName, sessionFor, toast } from '../lib/stores.svelte';
  import { caps } from '../../shared/server-caps';
  import { releaseType } from '../../shared/music-ui';

  // server: the item's server (absent in older links: the primary one).
  let { id, server }: { id: string; server?: string } = $props();
  const sid = untrack(() => server ?? sessionFor()?.server.id);
  const key = itemKey({ Id: untrack(() => id), ServerId: sid });
  const api = apiFor(sid);
  // What this item's source offers (file sources: no cast, favorites or downloads).
  const can = $derived(caps(sessionFor(sid)?.server.kind));

  // Paint at once with what the clicked card knew; /Items/{id} fills in the rest.
  let item = $state<BaseItem | null>(untrack(() => peek(key)));
  const cardSrc = untrack(() => peekSrc(key));
  let morphing = $state(untrack(() => takeMorph(key)));
  // The same film or series on other servers (matching provider ids), this one first.
  let copies = $state<BaseItem[]>([]);
  let loadedId = '';
  let error = $state('');
  let seasons = $state<BaseItem[]>([]);
  let seasonId = $state<string | null>(null);
  const ALL_EPISODES = '*';
  let episodes = $state<BaseItem[]>([]);
  let episodesLoading = $state(false);
  let tracks = $state<BaseItem[]>([]);
  let children = $state<BaseItem[]>([]);
  let filmography = $state<BaseItem[]>([]);
  // Artist page (music-spec §4.3): top songs; the discography splits into own albums, singles & EPs and "appears on".
  let topSongs = $state<BaseItem[]>([]);
  const own = $derived(item?.Type === 'MusicArtist' ? filmography.filter((a) => !a.AlbumArtists?.length || a.AlbumArtists.some((x) => x.Id === item!.Id)) : filmography);
  // shortcut: a single/EP is an album of 1 to 3 tracks (spec's ChildCount ≤ 3 heuristic). UNVERIFIED that Emby fills
  // ChildCount with the track count on albums; without it the album stays under Albums. Upgrade to a release-type tag if servers expose one.
  const isSingle = (a: BaseItem) => item?.Type === 'MusicArtist' && a.Type === 'MusicAlbum' && typeof a.ChildCount === 'number' && a.ChildCount >= 1 && a.ChildCount <= 3;
  const ownAlbums = $derived(own.filter((a) => !isSingle(a)));
  const singles = $derived(own.filter(isSingle));
  const appearsOn = $derived(item?.Type === 'MusicArtist' ? filmography.filter((a) => !own.includes(a)) : []);
  let similar = $state<BaseItem[]>([]);
  // Album page (music spec C4): the release type from its tracks, more albums by its artist, the cover full size.
  let moreFrom = $state<BaseItem[]>([]);
  const albumArtist = $derived(item?.Type === 'MusicAlbum' ? item.AlbumArtists?.[0] : undefined);
  const release = $derived(
    item?.Type === 'MusicAlbum' && tracks.length ? releaseType(tracks.length, tracks.reduce((n, tr) => n + (tr.RunTimeTicks ?? 0), 0) / TICKS_PER_MS, item.AlbumArtist) : null,
  );
  let zoom = $state<HTMLDialogElement>();
  let zoomSrc = $state('');
  async function openZoom(): Promise<void> {
    if (!item) return;
    zoomSrc = posterUrl(item, 1200) ?? (await musicArtLater(item, 1200)) ?? poster ?? '';
    if (zoomSrc) zoom?.showModal();
  }
  let siblings = $state<BaseItem[]>([]);
  let nextUpId = $state<string | null>(null);
  let busy = $state(false);

  let sourceId = $state('');
  let audioIndex = $state<number | null>(null);
  let subtitleIndex = $state<number>(-1);
  let overviewOpen = $state(false);

  const playableTypes = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Audio', 'Trailer'];
  const isPlayableLeaf = $derived(item ? playableTypes.includes(item.Type) : false);
  const isContainer = $derived(item ? ['Series', 'Season', 'MusicAlbum', 'Playlist', 'BoxSet'].includes(item.Type) : false);
  const source = $derived(item?.MediaSources?.find((s) => s.Id === sourceId) ?? item?.MediaSources?.[0]);
  const streams = $derived<MediaStream[]>(source?.MediaStreams ?? item?.MediaStreams ?? []);
  const audioStreams = $derived(streams.filter((s) => s.Type === 'Audio'));
  const subStreams = $derived(streams.filter((s) => s.Type === 'Subtitle'));
  const quality = $derived(badges(streams));
  const resumeTicks = $derived(item?.UserData?.PlaybackPositionTicks ?? 0);
  const canResume = $derived(isPlayableLeaf && resumeTicks > 0);
  const isBook = $derived(item?.Type === 'Book');
  const bookPage = $derived(isBook && !item?.UserData?.Played ? comicPageFromTicks(resumeTicks) : 0);
  const downloaded = $derived(downloads.list.find((d) => d.itemId === id && d.serverId === sid));
  const ends = $derived(item && isPlayableLeaf ? endsAt(item) : '');
  // Trailers: one stored on the server plays in the player; a YouTube link opens in a sheet; any other link in the browser.
  let localTrailers = $state<BaseItem[]>([]);
  // Extras (deleted scenes, making-of): played like trailers, so they never touch the watched state.
  let bonus = $state<BaseItem[]>([]);
  let youtubeOpen = $state(false);
  const remoteTrailer = $derived(item?.RemoteTrailers?.find((r) => r.Url)?.Url);
  const youtubeId = $derived(remoteTrailer ? youtubeVideoId(remoteTrailer) : null);
  const hasTrailer = $derived(localTrailers.length > 0 || Boolean(remoteTrailer));

  const backdrop = $derived(item ? backdropUrl(item, 1920) : null);
  const logo = $derived(item ? logoUrl(item, 720) : null);
  // Music (music spec §4.A): an album or artist without art borrows its first track's or album's cover, else its
  // initials; the hero is tinted with the cover's dominant colour (never text or controls).
  const music = $derived(item ? isMusicItem(item) : false);
  let latePoster = $state<{ id: string; src: string | null } | null>(null);
  $effect(() => {
    const it = item;
    if (!it || !isMusicItem(it) || posterUrl(it, 330) || !needsLookup(it)) return;
    void musicArtLater(it, 330).then((s) => (latePoster = { id: it.Id, src: s }));
  });
  const poster = $derived(item ? (posterUrl(item, 330) ?? (latePoster?.id === item.Id ? latePoster.src : null)) : null);
  let tint = $state<string | null>(null);
  $effect(() => {
    const p = music ? poster : null;
    tint = null;
    if (!p) return;
    let live = true;
    void artColour(p).then((c) => live && (tint = c));
    return () => (live = false);
  });
  const round = $derived(item?.Type === 'Person' || item?.Type === 'MusicArtist');
  const squarePoster = $derived(item ? ['MusicAlbum', 'Audio', 'Playlist'].includes(item.Type) : false);
  // Apple TV layout: full-bleed backdrop when there is one, a poster beside the text otherwise.
  const showPoster = $derived((Boolean(poster) || music) && (!backdrop || round || squarePoster));
  const ambient = $derived(cardSrc ?? (item ? (thumbUrl(item, 400) ?? poster) : null));
  const displayTitle = $derived(item ? (item.Type === 'Episode' || item.Type === 'Season' ? (item.SeriesName ?? item.Name) : item.Name) : '');
  // Emby can credit one person twice in the same role: one card (a repeated {#each} key throws).
  const people = $derived(
    (item?.People ?? [])
      .filter((p) => p.Type === 'Actor' || p.Type === 'Director' || p.Type === 'GuestStar')
      .filter((p, i, all) => all.findIndex((q) => q.Id === p.Id && q.Role === p.Role && q.Type === p.Type) === i)
      .slice(0, 30),
  );

  function initSelection(it: BaseItem): void {
    const src = it.MediaSources?.[0];
    sourceId = src?.Id ?? '';
    const s = src?.MediaStreams ?? it.MediaStreams ?? [];
    const audio = s.filter((x) => x.Type === 'Audio');
    audioIndex = src?.DefaultAudioStreamIndex ?? (audio.find((a) => a.IsDefault) ?? audio[0])?.Index ?? null;
    subtitleIndex = src?.DefaultSubtitleStreamIndex ?? -1;
  }

  async function load(): Promise<void> {
    error = '';
    try {
      const it = await api.item(id);
      const first = loadedId !== it.Id;
      loadedId = it.Id;
      item = it;
      if (first) initSelection(it);
      void loadExtras(it, first);
      if (first) void findCopies(it);
    } catch (err) {
      error = errorMessage(err);
    }
  }

  // Searched by name on the other servers, kept when a provider id matches; one copy per server.
  async function findCopies(it: BaseItem): Promise<void> {
    if (!multiServer() || (it.Type !== 'Movie' && it.Type !== 'Series') || !it.ProviderIds) return;
    const found = await fanOut((a, s) =>
      s === sid ? Promise.resolve(null) : a.items({ SearchTerm: it.Name, Recursive: true, IncludeItemTypes: it.Type, Limit: 20 }),
    );
    const others = found.map((r) => r?.Items.find((x) => sameTitle(x, it))).filter((x): x is BaseItem => Boolean(x));
    copies = others.length > 0 ? [it, ...others] : [];
  }

  async function loadExtras(it: BaseItem, first: boolean): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (first) localTrailers = [];
    if ((it.LocalTrailerCount ?? 0) > 0 && first) tasks.push(api.localTrailers(it.Id).then((r) => (localTrailers = r ?? [])).catch(() => (localTrailers = [])));
    if (first) bonus = [];
    // A server without the route (or extras) just shows no row.
    if (first && ['Movie', 'Series', 'Season', 'Episode', 'MusicVideo'].includes(it.Type))
      tasks.push(api.specialFeatures(it.Id).then((r) => (bonus = Array.isArray(r) ? r : [])).catch(() => (bonus = [])));
    if (it.Type === 'MusicAlbum' && first && it.AlbumArtists?.[0]) {
      moreFrom = [];
      // Emby's AlbumArtistIds is unverified on 4.8+ (music spec §3.2): same branch as lookupQuery.
      tasks.push(
        api
          .items({ ...(sessionFor(sid)?.server.kind !== 'jellyfin' ? { ArtistIds: it.AlbumArtists[0].Id, ArtistType: 'AlbumArtist' } : { AlbumArtistIds: it.AlbumArtists[0].Id }), Recursive: true, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', Limit: 25 })
          .then((r) => (moreFrom = r.Items.filter((x) => x.Id !== it.Id)))
          .catch(() => (moreFrom = [])),
      );
    }
    // Artists too (C7): /Items/{id}/Similar answers similar artists on both servers.
    if (['Movie', 'Series', 'Episode', 'MusicAlbum', 'MusicArtist', 'BoxSet'].includes(it.Type) && first) {
      const simId = it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id;
      tasks.push(api.similar(simId).then((r) => (similar = r.Items)).catch(() => (similar = [])));
    }
    if (it.Type === 'Series') {
      tasks.push(
        api.seasons(it.Id).then((r) => {
          seasons = r.Items;
          if (!seasonId || !r.Items.some((s) => s.Id === seasonId)) {
            const unwatched = r.Items.find((s) => !s.UserData?.Played && (s.IndexNumber ?? 0) > 0);
            // No seasons (a Plex show with seasons hidden, plex-spec §4): every episode of the series.
            seasonId = (unwatched ?? r.Items.find((s) => (s.IndexNumber ?? 0) > 0) ?? r.Items[0])?.Id ?? ALL_EPISODES;
          }
        }),
      );
      tasks.push(
        w.api
          .get<{ Items: BaseItem[] }>('/Shows/NextUp', { SeriesId: it.Id, UserId: sessionFor(sid)?.user?.id, Limit: 1 }, sid)
          .then((r) => (nextUpId = r.Items?.[0]?.Id ?? null))
          .catch(() => (nextUpId = null)),
      );
    } else if (it.Type === 'Season') {
      seasonId = it.Id;
    } else if (it.Type === 'Episode' && it.SeriesId) {
      tasks.push(api.episodes(it.SeriesId, it.SeasonId).then((r) => (siblings = r.Items)).catch(() => (siblings = [])));
    } else if (it.Type === 'MusicAlbum' || it.Type === 'Playlist') {
      tasks.push(
        api
          .items({ ParentId: it.Id, SortBy: it.Type === 'Playlist' ? undefined : 'ParentIndexNumber,IndexNumber,SortName', Fields: 'MediaSources' })
          .then((r) => (tracks = r.Items)),
      );
    } else if (it.Type === 'BoxSet' || it.IsFolder) {
      if (it.Type !== 'Series' && it.Type !== 'MusicArtist') tasks.push(api.items({ ParentId: it.Id, SortBy: 'ProductionYear,SortName' }).then((r) => (children = r.Items)));
    }
    if (it.Type === 'Person' || it.Type === 'MusicArtist') {
      const q =
        it.Type === 'Person'
          ? { PersonIds: it.Id, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' }
          : { ArtistIds: it.Id, Recursive: true, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' };
      tasks.push(api.items(q).then((r) => (filmography = r.Items)));
      if (it.Type === 'MusicArtist')
        tasks.push(api.items({ ArtistIds: it.Id, Recursive: true, IncludeItemTypes: 'Audio', SortBy: 'PlayCount,SortName', SortOrder: 'Descending', Limit: 5 }).then((r) => (topSongs = r.Items)));
    }
    await Promise.allSettled(tasks);
  }

  // Episodes of the selected season (series or season page).
  $effect(() => {
    const sid = seasonId;
    const it = item;
    if (!sid || !it || (it.Type !== 'Series' && it.Type !== 'Season')) return;
    const seriesId = it.Type === 'Series' ? it.Id : it.SeriesId;
    if (!seriesId) return;
    void dataVersion.userData;
    episodesLoading = untrack(() => episodes.length === 0);
    api
      .episodes(seriesId, sid === ALL_EPISODES ? undefined : sid)
      .then((r) => {
        if (seasonId === sid) episodes = r.Items;
      })
      .catch(() => undefined)
      .finally(() => (episodesLoading = false));
  });

  $effect(() => {
    void id;
    void dataVersion.userData;
    void load();
  });

  onMount(() => {
    // The morph names only matter for the transition that brought us here.
    if (morphing) setTimeout(() => (morphing = false), 900);
    return scrollMemory();
  });

  // What the Play button plays ("Lire sur…" casts the same); null when the resume question was dismissed.
  async function playRequest(it: BaseItem, fromStart: boolean): Promise<PlayRequest | null> {
    if (isPlayableLeaf) {
      const q = await playQueueFor(it);
      const same = q.itemIds[q.startIndex] === it.Id;
      return {
        ...q,
        mediaSourceId: same ? sourceId || undefined : undefined,
        audioStreamIndex: same ? (audioIndex ?? undefined) : undefined,
        subtitleStreamIndex: same ? subtitleIndex : undefined,
        startPositionTicks: same && !fromStart ? resumeTicks : undefined,
      };
    }
    if (it.Type === 'Series' && nextUpId) {
      const q = await playQueueFor({ ...it, Type: 'Series' });
      const idx = q.itemIds.indexOf(nextUpId);
      const ep = episodes.find((e) => e.Id === nextUpId);
      const at = await resumeAt(ep?.UserData?.PlaybackPositionTicks, ep?.Name ?? it.Name);
      if (at === null) return null;
      return { itemIds: q.itemIds, startIndex: idx >= 0 ? idx : q.startIndex, startPositionTicks: at, serverId: sid };
    }
    const q = await playQueueFor(it);
    if (q.itemIds.length === 0) throw new Error(t('item.errors.nothingToPlay'));
    return q;
  }

  // The Play buttons stay enabled while busy (aria-disabled): a disabled button drops the focus, which must be
  // there again when the player closes.
  async function play(fromStart = false): Promise<void> {
    if (!item || busy) return;
    if (isBook) return navigate(`${itemPath(item, 'read')}${fromStart ? '?page=0' : ''}`);
    busy = true;
    try {
      const req = await playRequest(item, fromStart);
      if (req) await w.playback.play(req);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  // youtube.com/watch?v=, youtu.be/, /embed/ and /shorts/ links; null for anything else.
  function youtubeVideoId(url: string): string | null {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^(www|m)\./, '');
      const id =
        host === 'youtu.be'
          ? u.pathname.slice(1)
          : host === 'youtube.com' || host === 'youtube-nocookie.com'
            ? (u.searchParams.get('v') ?? /^\/(?:embed|shorts)\/([^/?]+)/.exec(u.pathname)?.[1] ?? '')
            : '';
      return /^[\w-]{6,20}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  async function playTrailer(): Promise<void> {
    if (localTrailers[0]) {
      try {
        await w.playback.play({ itemIds: [localTrailers[0].Id], serverId: sid, trailer: true });
      } catch (err) {
        toast('error', errorMessage(err));
      }
    } else if (youtubeId) {
      youtubeOpen = true;
    } else if (remoteTrailer) {
      void w.app.openExternal(remoteTrailer);
    }
  }

  async function playBonus(index: number): Promise<void> {
    try {
      await w.playback.play({ itemIds: bonus.map((b) => b.Id), startIndex: index, serverId: sid, trailer: true });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function playEpisode(ep: BaseItem): Promise<void> {
    try {
      const ids = episodes.map((e) => e.Id);
      const q = item?.SeriesId || item?.Type === 'Series' ? await playQueueFor(ep) : { itemIds: ids, startIndex: ids.indexOf(ep.Id), serverId: sid };
      const at = await resumeAt(ep.UserData?.PlaybackPositionTicks, ep.Name);
      if (at === null) return;
      await w.playback.play({ ...q, startPositionTicks: at });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function toggleFavorite(): Promise<void> {
    if (!item) return;
    const next = !item.UserData?.IsFavorite;
    item.UserData = { ...item.UserData, IsFavorite: next };
    try {
      await api.setFavorite(item.Id, next);
    } catch (err) {
      item.UserData = { ...item.UserData, IsFavorite: !next };
      toast('error', errorMessage(err));
    }
  }

  async function togglePlayed(target: BaseItem = item!): Promise<void> {
    const next = !target.UserData?.Played;
    try {
      await api.setPlayed(target.Id, next);
      toast('success', next ? t('item.toast.markedWatched') : t('item.toast.markedUnwatched'));
      await load();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function download(): Promise<void> {
    if (!item) return;
    try {
      await w.downloads.add([item.Id], sid);
      toast('success', isContainer ? t('item.toast.downloadAdded') : t('item.toast.downloadAddedNamed', { name: item.Name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function streamLabel(s: MediaStream): string {
    return s.DisplayTitle || [s.Language, s.Codec?.toUpperCase()].filter(Boolean).join(' · ') || t('item.streams.track', { index: s.Index });
  }

  function personRole(p: { Role?: string; Type?: string }): string {
    if (p.Type === 'Director') return t('item.people.director');
    return p.Role ?? '';
  }

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase() ?? '')
      .join('');
  }

  function openItem(e: MouseEvent, target: BaseItem, artwork?: HTMLElement | null, src?: string | null): void {
    e.preventDefault();
    const dest = { ...target, ServerId: target.ServerId ?? sid };
    remember(dest, src);
    morphFrom(artwork, itemKey(dest));
    navigate(itemPath(dest));
  }

  function languages(list: MediaStream[]): string {
    const out = new Set<string>();
    for (const s of list) {
      if (s.Language) out.add(fmt.language(s.Language));
    }
    return [...out].map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join(', ');
  }

  const nextUpEpisode = $derived(episodes.find((e) => e.Id === nextUpId));
  const seasonPlayed = $derived(episodes.length > 0 && episodes.every((e) => e.UserData?.Played));
  const playLabel = $derived(
    isBook
      ? bookPage > 0
        ? t('item.play.resumeReading', { page: bookPage + 1 })
        : t('item.play.read')
      : canResume
        ? t('item.play.resume')
        : item?.Type === 'Series' && nextUpEpisode
          ? t('item.play.episode', { code: episodeCode(nextUpEpisode) })
          : t('item.play.play'),
  );
  const video = $derived(streams.find((s) => s.Type === 'Video'));
  const facts = $derived.by(() => {
    if (!item) return [] as [string, string][];
    const out: [string, string][] = [];
    if (item.Genres?.length) out.push([t('item.facts.genres'), item.Genres.join(', ')]);
    if (item.PremiereDate) out.push([t('item.facts.released'), fmt.date(item.PremiereDate)]);
    if (item.RunTimeTicks && isPlayableLeaf) out.push([t('item.facts.runtime'), runtime(item.RunTimeTicks)]);
    // Selected version: the chip text, plus the Dolby Vision profile here only.
    const chip = hdrChip(video);
    const hdr = hdrFromStream(video);
    const dvProfile = hdr?.kind === 'dv' ? hdr.dvProfile : undefined;
    if (chip) out.push([t('item.facts.dynamicRange'), dvProfile ? t('item.facts.dvProfile', { format: chip, profile: dvProfile }) : chip]);
    if (item.OfficialRating) out.push([t('item.facts.ageRating'), item.OfficialRating]);
    if (item.Studios?.length) out.push([t('item.facts.studio'), item.Studios.map((s) => s.Name).slice(0, 3).join(', ')]);
    const directors = (item.People ?? []).filter((p) => p.Type === 'Director').map((p) => p.Name);
    if (directors.length) out.push([t('item.facts.directors'), directors.join(', ')]);
    if (audioStreams.length) out.push([t('item.facts.audio'), languages(audioStreams) || t('item.facts.tracks', { count: audioStreams.length })]);
    if (subStreams.length) out.push([t('item.facts.subtitles'), languages(subStreams) || t('item.facts.tracks', { count: subStreams.length })]);
    return out;
  });
  const fileInfo = $derived(
    source && isPlayableLeaf
      ? [source.Container?.toUpperCase(), video?.Codec?.toUpperCase(), video?.Width && video.Height ? `${video.Width}×${video.Height}` : '', source.Size ? bytes(source.Size) : '']
          .filter(Boolean)
          .join(' · ')
      : '',
  );
</script>

{#if error && !item}
  <div class="state">
    <Icon name="exclamation" size={40} stroke={1.5} />
    <h1 class="title-2">{t('item.notFound')}</h1>
    <p class="footnote">{error}</p>
    <button class="btn" onclick={() => history.back()}><Icon name="arrowLeft" size={16} /> {t('common.actions.back')}</button>
  </div>
{:else if !item}
  <div class="loading" aria-busy="true">
    <div class="sk-title skeleton"></div>
    <div class="sk-line skeleton"></div>
    <div class="sk-actions"><span class="skeleton"></span><span class="skeleton"></span></div>
  </div>
{:else}
  <article class="item" data-type={item.Type}>
    <!-- Sticky stage: stays put while the page scrolls over it, dimming and blurring as it goes. -->
    <div class="stage" class:bare={!backdrop} class:tinted={Boolean(tint)} style:--tint={tint} style:view-transition-name={morphing && !showPoster ? morphName(key) : null} style:view-transition-class={morphing && !showPoster ? 'morph' : null}>
      {#if ambient}<img class="ambient" src={ambient} alt="" decoding="async" />{/if}
      {#if backdrop}
        <div class="sharp"><img class="reveal" use:reveal src={backdrop} alt="" decoding="async" fetchpriority="high" /></div>
      {/if}
      <div class="dim"></div>
      <div class="scrim"></div>
    </div>

    <header class="hero" class:with-poster={showPoster} style:view-transition-name={morphing ? 'item-info' : null}>
      {#if showPoster}
        <div
          class="poster"
          class:square={squarePoster}
          class:round
          style:view-transition-name={morphing ? morphName(key) : null}
          style:view-transition-class={morphing ? 'morph' : null}
        >
          {#if poster && music}
            <button class="zoom" title={t('music.albumPage.enlarge')} aria-label={t('music.albumPage.enlarge')} data-zoom onclick={openZoom}><img class="reveal" use:reveal src={poster} alt="" decoding="async" /></button>
          {:else if poster}<img class="reveal" use:reveal src={poster} alt="" decoding="async" />
          {:else}<span class="ph-initials" style:background={placeholderBg(item.Name ?? '')} aria-hidden="true">{musicInitials(item.Name ?? '')}</span>{/if}
        </div>
      {/if}

      <div class="info">
        <div class="eyebrow">
          <span data-release={release ?? undefined}>{release ? t(`music.release.${release}`) : typeLabel(item.Type)}</span>{#if item.Genres?.length}<span class="dot">·</span>{item.Genres.slice(0, 2).join(', ')}{/if}
        </div>

        {#if logo && !round}
          <img class="logo reveal" use:reveal src={logo} alt={displayTitle} decoding="async" />
        {:else}
          <h1 class="title" class:long={displayTitle.length > 26}>{displayTitle}</h1>
        {/if}

        {#if item.Type === 'Episode'}
          <h2 class="subtitle"><span class="code">{episodeCode(item)}</span>{item.Name}</h2>
        {:else if item.Type === 'Season'}
          <h2 class="subtitle">{item.Name}</h2>
        {/if}

        <div class="meta">
          {#if yearRange(item)}<span class="m">{yearRange(item)}</span>{/if}
          {#if item.RunTimeTicks && isPlayableLeaf}<span class="m">{runtime(item.RunTimeTicks)}</span>{/if}
          {#if item.Type === 'Series' && item.ChildCount}<span class="m">{t('common.count.seasons', { count: item.ChildCount })}</span>{/if}
          {#if item.Type === 'MusicAlbum' && item.AlbumArtist}<span class="m">{item.AlbumArtist}</span>{/if}
          {#if item.CommunityRating}
            <span class="m rating"><Icon name="star" size={12} fill stroke={0} />{fmt.number(item.CommunityRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
          {/if}
          {#if item.CriticRating}<span class="m">{t('item.meta.criticRating', { value: item.CriticRating })}</span>{/if}
          {#if item.OfficialRating}<span class="chip">{item.OfficialRating}</span>{/if}
          {#each quality as b (b)}<span class="chip">{b}</span>{/each}
        </div>

        {#if item.Taglines?.[0]}<p class="tagline">{item.Taglines[0]}</p>{/if}

        {#if item.Type !== 'Person' && item.Type !== 'MusicArtist' && item.LocationType !== 'Virtual'}
          <div class="actions">
            <button class="btn light lg" onclick={() => play(false)} aria-disabled={busy}>
              {#if isBook}<Icon name="book" size={17} stroke={2} />{:else}<Icon name="play" size={17} fill stroke={0} />{/if}
              {playLabel}
            </button>
            {#if !isBook && can.castSend}
              <button
                class="btn lg icon glass"
                title={t('cast.button')}
                aria-label={t('cast.button')}
                aria-haspopup="dialog"
                onclick={() => item && openCastPicker({ itemId: item.Id, serverId: sid, options: async () => castOptions(await playRequest(item!, false)) })}
              >
                <Icon name="cast" size={18} stroke={1.9} />
              </button>
            {/if}
            {#if canResume || bookPage > 0}
              <button class="btn lg glass" onclick={() => play(true)} aria-disabled={busy}>
                <Icon name="refresh" size={16} stroke={2} /> {t('item.actions.fromStart')}
              </button>
            {/if}
            {#if queueModes(item).includes('shuffle') || item.Type === 'MusicAlbum'}
              <button class="btn lg glass" onclick={() => item && queue(item, 'shuffle')}>
                <Icon name="shuffle" size={16} stroke={2} /> {t('common.actions.shuffle')}
              </button>
            {/if}
            {#if item.Type === 'MusicAlbum' || item.Type === 'Audio' || (item.Type === 'Playlist' && item.MediaType === 'Audio')}
              <button class="btn lg glass" data-mix onclick={() => item && playMix(item)}>
                <Icon name="sparkles" size={16} /> {t('music.actions.mix')}
              </button>
            {/if}
            {#if hasTrailer}
              <button class="btn lg glass" onclick={playTrailer}>
                <Icon name="trailer" size={17} /> {t('item.actions.trailer')}
              </button>
            {/if}
            <span class="icons">
              {#if can.favorites}
              <button
                class="btn lg icon glass"
                class:on={item.UserData?.IsFavorite}
                onclick={toggleFavorite}
                title={item.UserData?.IsFavorite ? t('item.actions.removeFavorite') : t('item.actions.addFavorite')}
                aria-pressed={Boolean(item.UserData?.IsFavorite)}
              >
                <Icon name="heart" size={18} fill={Boolean(item.UserData?.IsFavorite)} stroke={item.UserData?.IsFavorite ? 0 : 1.9} />
              </button>
              {/if}
              <button
                class="btn lg icon glass"
                class:on={item.UserData?.Played}
                onclick={() => togglePlayed()}
                title={item.UserData?.Played ? t('item.actions.markUnplayed', { kind: isBook ? 'book' : 'video' }) : t('item.actions.markPlayed', { kind: isBook ? 'book' : 'video' })}
                aria-pressed={Boolean(item.UserData?.Played)}
              >
                <Icon name="check" size={18} stroke={2.3} />
              </button>
              {#if item.Type !== 'BoxSet' && can.castSend}
                <button
                  class="btn lg icon glass"
                  class:on={downloaded?.status === 'done'}
                  onclick={download}
                  disabled={Boolean(downloaded) && !isContainer}
                  title={downloaded ? (downloaded.status === 'done' ? t('item.actions.availableOffline') : t('item.actions.downloading')) : t('common.actions.download')}
                >
                  <Icon name="download" size={18} stroke={1.9} />
                </button>
              {/if}
              <ItemMenu {item} />
            </span>
          </div>
        {/if}

        {#if canResume}
          <div class="resume">
            <span class="bar"><span style:transform="scaleX({progress(item) / 100})"></span></span>
            <span>{clock(resumeTicks / TICKS_PER_MS)} · {remaining(item)}{ends ? ` · ${ends}` : ''}</span>
          </div>
        {:else if ends}
          <div class="resume"><span>{ends}</span></div>
        {/if}

        {#if item.Overview}
          <p class="overview" class:open={overviewOpen}>{item.Overview}</p>
          {#if item.Overview.length > 280}
            <button class="more" onclick={() => (overviewOpen = !overviewOpen)}>{overviewOpen ? t('item.overview.less') : t('item.overview.more')}</button>
          {/if}
        {/if}

        {#if copies.length > 1 || (isPlayableLeaf && item.MediaType === 'Video' && (item.MediaSources?.length ?? 0) > 0)}
          <div class="selectors">
            {#if copies.length > 1}
              <BrowseMenu
                label={t('item.copies.availableOn', { count: copies.length })}
                icon="server"
                options={copies.map((c) => ({ value: itemKey(c), label: serverName(c.ServerId), checked: c.ServerId === sid }))}
                onselect={(v) => {
                  const c = copies.find((x) => itemKey(x) === v);
                  if (c && c.ServerId !== sid) navigate(itemPath(c), { replace: true });
                }}
              />
            {/if}
            {#if isPlayableLeaf && item.MediaType === 'Video' && (item.MediaSources?.length ?? 0) > 1}
              <!-- i18n-ignore -->
              <BrowseMenu icon="film"
                label={source?.Name ?? t('item.streams.version')}
                options={(item.MediaSources ?? []).map((s) => ({ value: s.Id, label: s.Name ?? s.Id, checked: s.Id === sourceId }))}
                onselect={(v) => (sourceId = v)}
              />
            {/if}
            {#if audioStreams.length > 0}
              <BrowseMenu
                label={streamLabel(audioStreams.find((s) => s.Index === audioIndex) ?? audioStreams[0])}
                icon="audio"
                options={audioStreams.map((s) => ({ value: String(s.Index), label: streamLabel(s), checked: s.Index === audioIndex }))}
                onselect={(v) => (audioIndex = Number(v))}
              />
            {/if}
            {#if subStreams.length > 0}
              <BrowseMenu
                label={subtitleIndex >= 0 ? streamLabel(subStreams.find((s) => s.Index === subtitleIndex) ?? subStreams[0]) : t('item.streams.subtitlesOff')}
                icon="subtitles"
                options={[
                  { value: '-1', label: t('item.streams.subtitlesNone'), checked: subtitleIndex < 0 },
                  ...subStreams.map((s, i) => ({
                    value: String(s.Index),
                    label: s.IsForced ? t('item.streams.forced', { label: streamLabel(s) }) : streamLabel(s),
                    checked: s.Index === subtitleIndex,
                    section: i === 0 ? (true as const) : undefined,
                  })),
                ]}
                onselect={(v) => (subtitleIndex = Number(v))}
              />
            {/if}
          </div>
        {/if}

        {#if item.Type === 'Episode' && item.SeriesId}
          <a class="series-link" href={`#/item/${sid}/${item.SeriesId}`} onclick={(e) => openItem(e, { Id: item!.SeriesId!, Name: item!.SeriesName ?? '', Type: 'Series' })}>
            {item.SeriesName ?? t('item.goToShow')}<Icon name="chevronRight" size={14} stroke={2.2} />
          </a>
        {/if}
      </div>
    </header>

    <div class="content">
      {#if item.Type === 'Series' || item.Type === 'Season'}
        <section class="episodes">
          <div class="ep-head">
            {#if item.Type === 'Series' && seasons.length > 1}
              <div class="seasons" role="tablist" aria-label={t('item.episodes.seasons')}>
                {#each seasons as s (s.Id)}
                  <button class="season" class:on={seasonId === s.Id} role="tab" aria-selected={seasonId === s.Id} onclick={() => (seasonId = s.Id)}>
                    {s.Name}
                    {#if s.UserData?.UnplayedItemCount}<span class="n">{s.UserData.UnplayedItemCount}</span>{/if}
                  </button>
                {/each}
              </div>
            {:else}
              <h2 class="sec-title">{seasons[0]?.Name ?? t('item.episodes.title')}</h2>
            {/if}
            {#if episodes.length > 0}
              <button class="btn glass" onclick={() => markPlayed(episodes, !seasonPlayed, sid)}>
                <Icon name="check" size={15} stroke={2.2} />
                {seasonPlayed ? t('item.actions.markSeasonUnplayed') : t('item.actions.markSeasonPlayed')}
              </button>
            {/if}
          </div>
          <Row title="" variant="thumb" loading={episodesLoading}>
            {#each episodes as ep, i (ep.Id)}
              {@const pct = progress(ep)}
              {@const thumb = thumbUrl(ep, 400)}
              <div class="ep enter" class:next={ep.Id === nextUpId} class:played={ep.UserData?.Played} style:--i={Math.min(i, 12)}>
                <div class="ep-lift">
                  <button class="ep-thumb" onclick={() => playEpisode(ep)} aria-label={t('item.episodes.play', { name: ep.Name })}>
                    <span class="ep-ph">{episodeCode(ep)}</span>
                    {#if thumb}<img class="reveal" use:reveal src={thumb} alt="" loading="lazy" decoding="async" />{/if}
                    <span class="ep-play"><Icon name="play" size={18} fill stroke={0} /></span>
                    {#if pct > 0 && !ep.UserData?.Played}<span class="ep-bar"><span style:transform="scaleX({pct / 100})"></span></span>{/if}
                  </button>
                  <button
                    class="ep-seen"
                    class:on={ep.UserData?.Played}
                    onclick={() => togglePlayed(ep)}
                    title={ep.UserData?.Played ? t('item.actions.markUnplayed', { kind: 'video' }) : t('item.actions.markPlayed', { kind: 'video' })}
                    aria-pressed={Boolean(ep.UserData?.Played)}
                  >
                    <Icon name="check" size={13} stroke={2.8} />
                  </button>
                </div>
                <a class="ep-text" href={`#${itemPath(ep)}`} onclick={(e) => openItem(e, ep, (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement, thumb)}>
                  <div class="ep-eyebrow">
                    {#if ep.Id === nextUpId}<span class="nextup">{t('item.episodes.nextUp')}</span>{/if}
                    <span>{ep.IndexNumber != null ? t('item.episodes.number', { number: ep.IndexNumber }) : t('item.episodes.episode')}</span>
                    {#if ep.RunTimeTicks}<span class="rt">{pct > 0 && !ep.UserData?.Played ? remaining(ep) : runtime(ep.RunTimeTicks)}</span>{/if}
                  </div>
                  <div class="ep-name">{ep.Name}</div>
                  {#if ep.Overview}<p class="ep-ov">{ep.Overview}</p>{/if}
                </a>
              </div>
            {/each}
          </Row>
        </section>
      {/if}

      {#if item.Type === 'Playlist'}<PlaylistItems playlist={item} />{/if}
      {#if item.Type === 'MusicAlbum' && tracks.length > 0}<AlbumTracks album={item} {tracks} serverId={sid} />{/if}

      {#if children.length > 0}
        <section class="grid-section">
          <h2 class="sec-title">{t('item.sections.contents')}</h2>
          <div class="grid">
            {#each children as c, i (c.Id)}
              <div class="enter" style:--i={Math.min(i, 12)}><Card item={c} variant={c.Type === 'Episode' ? 'thumb' : 'poster'} /></div>
            {/each}
          </div>
        </section>
      {/if}

      {#if item.Type === 'MusicArtist'}
        <div class="artist-actions">
          <button class="btn lg light" onclick={() => item && api.items({ ArtistIds: item.Id, Recursive: true, IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: 300 }).then((r) => playTracks(r.Items.map((x) => x.Id), 0, sid))}>
            <Icon name="shuffle" size={16} stroke={2} /> {t('music.actions.shuffle')}
          </button>
          <button class="btn lg glass" onclick={() => item && playMix(item)}><Icon name="sparkles" size={16} /> {t('music.actions.mix')}</button>
        </div>
        {#if topSongs.length > 0}
          <h2 class="sec-title artist-sec">{t('music.artist.topSongs')}</h2>
          <AlbumTracks album={item} tracks={topSongs} serverId={sid} plain />
        {/if}
      {/if}

      {#if ownAlbums.length > 0}
        <section class="grid-section">
          <h2 class="sec-title">{item.Type === 'MusicArtist' ? t('music.artist.albums') : t('item.sections.filmography')}</h2>
          <div class="grid">
            {#each ownAlbums as c, i (c.Id)}
              <div class="enter" style:--i={Math.min(i, 12)}><Card item={c} variant={c.Type === 'MusicAlbum' ? 'square' : 'poster'} /></div>
            {/each}
          </div>
        </section>
      {/if}

      {#if singles.length > 0}
        <section class="grid-section">
          <h2 class="sec-title">{t('music.artist.singles')}</h2>
          <div class="grid">
            {#each singles as c, i (c.Id)}
              <div class="enter" style:--i={Math.min(i, 12)}><Card item={c} variant="square" /></div>
            {/each}
          </div>
        </section>
      {/if}

      {#if appearsOn.length > 0}
        <section class="grid-section">
          <h2 class="sec-title">{t('music.artist.appearsOn')}</h2>
          <div class="grid">
            {#each appearsOn as c, i (c.Id)}
              <div class="enter" style:--i={Math.min(i, 12)}><Card item={c} variant="square" /></div>
            {/each}
          </div>
        </section>
      {/if}

      {#if bonus.length > 0}
        <Row title={t('item.sections.bonus')} variant="thumb">
          {#each bonus as b, i (b.Id)}
            {@const thumb = thumbUrl(b, 400)}
            <div class="ep enter" style:--i={Math.min(i, 12)}>
              <div class="ep-lift">
                <button class="ep-thumb" onclick={() => playBonus(i)} aria-label={t('item.episodes.play', { name: b.Name })}>
                  <span class="ep-ph"><Icon name="film" size={22} /></span>
                  {#if thumb}<img class="reveal" use:reveal src={thumb} alt="" loading="lazy" decoding="async" />{/if}
                  <span class="ep-play"><Icon name="play" size={18} fill stroke={0} /></span>
                </button>
              </div>
              <div class="ep-text">
                {#if b.RunTimeTicks}<div class="ep-eyebrow"><span class="rt">{runtime(b.RunTimeTicks)}</span></div>{/if}
                <div class="ep-name">{b.Name}</div>
              </div>
            </div>
          {/each}
        </Row>
      {/if}

      {#if item.Type === 'Episode' && siblings.length > 1}
        <Row title={t('item.sections.moreEpisodes')} items={siblings.filter((s) => s.Id !== item!.Id)} variant="thumb" />
      {/if}

      {#if people.length > 0}
        <Row title={t('item.sections.castCrew')} variant="square">
          {#each people as p, i (p.Id + (p.Role ?? '') + (p.Type ?? ''))}
            {@const face = p.PrimaryImageTag ? imageUrl(p.Id, 'Primary', { tag: p.PrimaryImageTag, maxHeight: 330, server: sid }) : null}
            <a
              class="person enter"
              style:--i={Math.min(i, 12)}
              href={`#/item/${sid}/${p.Id}`}
              onclick={(e) =>
                openItem(
                  e,
                  { Id: p.Id, Name: p.Name, Type: 'Person', ImageTags: p.PrimaryImageTag ? { Primary: p.PrimaryImageTag } : undefined },
                  (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.face'),
                  face,
                )}
            >
              <span class="face">
                <span class="initials">{initials(p.Name)}</span>
                {#if face}<img class="reveal" use:reveal src={face} alt="" loading="lazy" decoding="async" />{/if}
              </span>
              <span class="p-name">{p.Name}</span>
              {#if personRole(p)}<span class="p-role">{personRole(p)}</span>{/if}
            </a>
          {/each}
        </Row>
      {/if}

      {#if moreFrom.length > 0 && albumArtist}
        <Row title={t('music.albumPage.moreFrom', { name: albumArtist.Name })} items={moreFrom} variant="square" />
      {/if}

      {#if similar.length > 0}
        <Row
          title={item.Type === 'MusicArtist' ? t('music.artistPage.similar') : t('item.sections.similar')}
          items={similar}
          variant={item.Type === 'MusicAlbum' || item.Type === 'MusicArtist' ? 'square' : 'poster'}
        />
      {/if}

      {#if facts.length > 0 || fileInfo}
        <section class="about">
          <h2 class="sec-title">{t('item.sections.about')}</h2>
          <dl>
            {#each facts as [k, v] (k)}
              <div><dt>{k}</dt><dd>{v}</dd></div>
            {/each}
          </dl>
          {#if fileInfo}<p class="file caption">{fileInfo}</p>{/if}
        </section>
      {/if}
    </div>
    {#if music}
      <!-- The cover full size (C4): a modal dialog, Escape or a click closes it. -->
      <dialog class="zoom-view" bind:this={zoom} aria-label={t('music.albumPage.enlarge')} onclick={() => zoom?.close()}>
        {#if zoomSrc}<img src={zoomSrc} alt={item.Name} decoding="async" />{/if}
      </dialog>
    {/if}
  </article>
{/if}

<Sheet open={youtubeOpen} onclose={() => (youtubeOpen = false)} label={t('item.trailer.title', { name: item?.Name ?? '' })} width={960}>
  {#if youtubeId}
    <div class="yt">
      <!-- Privacy-enhanced embed: no YouTube cookies until the viewer interacts. -->
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
        title={t('item.trailer.title', { name: item?.Name ?? '' })}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
      ></iframe>
    </div>
    <div class="yt-actions">
      <button class="btn glass" onclick={() => remoteTrailer && w.app.openExternal(remoteTrailer)}>
        <Icon name="externalLink" size={15} /> {t('item.trailer.openBrowser')}
      </button>
    </div>
  {/if}
</Sheet>

<style>
  .yt {
    aspect-ratio: 16 / 9;
    margin: 44px 16px 0;
    border-radius: var(--r-md);
    overflow: hidden;
    background: #000;
  }
  .yt iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .yt-actions {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px 16px;
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 18vh var(--gutter);
    text-align: center;
    color: var(--label-3);
  }
  .state h1 {
    margin: 8px 0 0;
    color: var(--label);
  }
  .state p {
    margin: 0 0 12px;
  }
  .loading {
    display: grid;
    align-content: end;
    gap: 14px;
    height: calc(100vh - var(--titlebar) - 120px);
    padding: 0 var(--gutter) 48px;
  }
  .sk-title {
    width: min(420px, 50%);
    height: 56px;
    border-radius: var(--r-sm);
  }
  .sk-line {
    width: min(560px, 70%);
    height: 14px;
    border-radius: 4px;
  }
  .sk-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .sk-actions span {
    width: 150px;
    height: 46px;
    border-radius: 999px;
  }

  .item {
    --stage-h: calc(100vh - var(--titlebar));
    position: relative;
    padding-bottom: 64px;
  }

  /* ---------- Stage (backdrop) ---------- */
  .stage {
    position: sticky;
    top: 0;
    height: var(--stage-h);
    margin-bottom: calc(-1 * var(--stage-h));
    /* clip, not hidden: a hidden box is a scroll container and would capture the scroll() timelines below. */
    overflow: clip;
    background: var(--bg);
    pointer-events: none;
  }
  /* A music album or artist: its cover's dominant colour fades into the canvas behind the hero (MU-A3). */
  .stage.tinted {
    background: linear-gradient(to bottom, color-mix(in oklab, var(--tint) 35%, var(--bg)), var(--bg));
  }
  :global(html[data-reduce-transparency]) .stage.tinted {
    background: var(--bg);
  }
  .stage img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 22%;
  }
  .ambient {
    filter: blur(40px) saturate(1.4);
    transform: scale(1.2);
    opacity: 0.85;
  }
  .bare .ambient {
    opacity: 0.4;
  }
  .sharp {
    position: absolute;
    inset: 0;
    animation: sharp-out linear both;
    animation-timeline: scroll(nearest block);
    animation-range: 0 70vh;
  }
  .sharp img {
    animation: settle calc(1.2s * var(--tempo)) var(--ease-out) both;
  }
  @keyframes settle {
    from {
      transform: scale(1.04);
    }
  }
  /* Scrolling down: the sharp image fades to its blurred twin, slightly zoomed. */
  @keyframes sharp-out {
    to {
      opacity: 0;
      transform: scale(1.06);
    }
  }
  .dim {
    position: absolute;
    inset: 0;
    background: rgb(11 11 13 / 0.62);
    opacity: 0;
    animation: dim-in linear both;
    animation-timeline: scroll(nearest block);
    animation-range: 0 70vh;
  }
  .bare .dim {
    opacity: 0.5;
    animation: none;
  }
  @keyframes dim-in {
    to {
      opacity: 1;
    }
  }
  .scrim {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to top, rgb(0 0 0 / 0.78) 0%, rgb(0 0 0 / 0.42) 30%, transparent 62%),
      linear-gradient(to right, rgb(0 0 0 / 0.6) 0%, rgb(0 0 0 / 0.22) 40%, transparent 66%),
      linear-gradient(to bottom, rgb(0 0 0 / 0.28), transparent 18%);
  }
  :global(html[data-reduce-motion]) .sharp {
    animation-name: sharp-fade;
  }
  @keyframes sharp-fade {
    to {
      opacity: 0;
    }
  }

  /* ---------- Hero ---------- */
  .hero {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: clamp(24px, 3vw, 48px);
    min-height: calc(var(--stage-h) - 96px);
    padding: 64px var(--gutter) 36px;
  }
  .hero.with-poster {
    min-height: 0;
    padding-top: clamp(48px, 12vh, 140px);
  }
  .poster {
    flex: none;
    width: clamp(170px, 16vw, 250px);
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--fill-1);
    box-shadow: var(--shadow-3);
  }
  .poster.square {
    aspect-ratio: 1;
    width: clamp(200px, 20vw, 300px);
  }
  .poster.round {
    aspect-ratio: 1;
    border-radius: 50%;
    width: clamp(160px, 15vw, 220px);
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .zoom {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    cursor: zoom-in;
  }
  .zoom-view {
    max-width: min(92vw, 1200px);
    max-height: 92vh;
    padding: 0;
    border: 0;
    border-radius: var(--r-lg);
    background: transparent;
    box-shadow: var(--shadow-3);
    overflow: hidden;
  }
  .zoom-view::backdrop {
    background: rgb(0 0 0 / 0.75);
  }
  .zoom-view img {
    display: block;
    max-width: min(92vw, 1200px);
    max-height: 92vh;
    object-fit: contain;
    cursor: zoom-out;
  }
  .poster .ph-initials {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: clamp(56px, 6vw, 96px);
    font-weight: 650;
    letter-spacing: -0.02em;
    color: rgb(255 255 255 / 0.92);
    user-select: none;
  }
  .info {
    min-width: 0;
    max-width: 720px;
  }
  .eyebrow {
    color: var(--label-2);
    margin-bottom: 12px;
  }
  .eyebrow .dot {
    margin: 0 6px;
  }
  .logo {
    display: block;
    max-width: min(440px, 100%);
    max-height: 150px;
    object-fit: contain;
    object-position: left bottom;
    margin-bottom: 16px;
    filter: drop-shadow(0 2px 18px rgb(0 0 0 / 0.5));
  }
  .title {
    margin: 0 0 10px;
    font-size: var(--fs-hero);
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1;
    text-wrap: balance;
    text-shadow: 0 2px 30px rgb(0 0 0 / 0.35);
  }
  .title.long {
    font-size: clamp(34px, 3.6vw, 52px);
  }
  .subtitle {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0 0 8px;
    font-size: var(--fs-title-2);
    font-weight: 650;
    letter-spacing: -0.018em;
  }
  .code {
    color: var(--label-2);
    font-weight: 560;
    font-variant-numeric: tabular-nums;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .m + .m::before {
    content: '·';
    margin-right: 6px;
    color: var(--label-3);
  }
  .meta .chip:first-of-type {
    margin-left: 6px;
  }
  .rating {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .rating :global(svg) {
    color: var(--label-2);
  }
  .tagline {
    margin: 12px 0 0;
    color: var(--label);
    font-size: var(--fs-headline);
    font-weight: 560;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 22px;
  }
  .icons {
    display: inline-flex;
    gap: 10px;
  }
  .glass {
    background: rgb(255 255 255 / 0.16);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .glass:hover,
  .glass:focus-visible {
    background: rgb(255 255 255 / 0.24);
  }
  .actions .btn:focus-visible {
    transform: scale(1.05);
  }
  .actions .btn.light:focus-visible {
    background: #fff;
  }
  .glass.on {
    background: var(--label);
    color: #000;
  }
  .resume {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    width: 120px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.22);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }
  .overview {
    margin: 16px 0 0;
    max-width: 64ch;
    font-size: var(--fs-headline);
    line-height: 1.5;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    user-select: text;
    text-wrap: pretty;
  }
  .overview.open {
    display: block;
  }
  .more {
    margin-top: 4px;
    font-size: var(--fs-callout);
    font-weight: 650;
    color: var(--label);
  }
  .more:hover {
    color: var(--label-2);
  }
  .selectors {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }
  .selectors :global(.trigger) {
    height: 32px;
    background: rgb(255 255 255 / 0.1);
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .series-link {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-top: 16px;
    font-weight: 600;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .series-link:hover {
    color: var(--label-2);
  }

  /* ---------- Content over the dimmed stage ---------- */
  .content {
    position: relative;
  }
  .sec-title {
    margin: 0;
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.016em;
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * 30ms * var(--tempo));
  }

  .episodes {
    margin-bottom: 8px;
  }
  .ep-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 var(--gutter);
  }
  .seasons {
    display: inline-flex;
    max-width: 100%;
    overflow-x: auto;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.1);
    scrollbar-width: none;
  }
  .season {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 16px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .season:hover {
    color: var(--label);
  }
  .season:active {
    transform: scale(0.96);
  }
  .season.on {
    background: var(--label);
    color: #000;
  }
  .season:not(.on):focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .season:focus-visible {
    border-radius: 999px;
  }
  .season .n {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    background: var(--fill-3);
  }
  .season.on .n {
    background: rgb(0 0 0 / 0.1);
  }

  .ep {
    position: relative;
    width: var(--card-w);
  }
  .ep-lift {
    position: relative;
    isolation: isolate;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-md);
    transition: transform var(--t-slow) var(--spring);
  }
  .ep-lift::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-3);
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .ep-thumb {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--r-md);
    background: linear-gradient(160deg, var(--bg-elevated-2), var(--bg-elevated));
  }
  .ep-thumb:focus-visible {
    border-radius: var(--r-md);
  }
  .ep-thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ep.played .ep-thumb img {
    filter: saturate(0.7) brightness(0.82);
  }
  .ep-ph {
    font-weight: 650;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .ep-play {
    position: absolute;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.5);
    color: var(--label);
    opacity: 0;
    transform: scale(0.85);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .ep-play :global(svg) {
    margin-left: 2px;
  }
  .ep-bar {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.28);
  }
  .ep-bar span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }
  .ep-seen {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.5);
    color: var(--label-2);
    opacity: 0;
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring),
      background-color var(--t-fast) var(--ease);
  }
  .ep-seen:hover {
    color: var(--label);
    background: rgb(0 0 0 / 0.7);
  }
  .ep-seen:active {
    transform: scale(0.9);
  }
  .ep-seen.on {
    opacity: 1;
    background: var(--label);
    color: #000;
  }
  .ep-seen:focus-visible {
    opacity: 1;
    border-radius: 50%;
  }
  .ep:hover .ep-lift,
  .ep:focus-within .ep-lift {
    will-change: transform;
    transform: scale(1.04);
  }
  .ep:hover,
  .ep:focus-within {
    z-index: 1;
  }
  .ep:hover .ep-lift::after,
  .ep:focus-within .ep-lift::after,
  .ep:hover .ep-play,
  .ep:focus-within .ep-play,
  .ep:hover .ep-seen,
  .ep:focus-within .ep-seen {
    opacity: 1;
  }
  .ep:hover .ep-play,
  .ep:focus-within .ep-play {
    transform: scale(1);
  }
  .ep-text {
    display: block;
    padding: 12px 2px 0;
    transition: transform var(--t-slow) var(--spring);
  }
  .ep:hover .ep-text,
  .ep:focus-within .ep-text {
    transform: translate3d(0, 4px, 0);
  }
  .ep-eyebrow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .ep-eyebrow .rt {
    margin-left: auto;
  }
  .nextup {
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--fill-3);
    color: var(--label);
    font-size: var(--fs-caption);
    font-weight: 650;
  }
  .ep-name {
    margin: 3px 0 4px;
    font-weight: 600;
    font-size: var(--fs-body);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ep-ov {
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .artist-actions {
    display: flex;
    gap: 10px;
    padding: 0 var(--gutter) 24px;
  }
  .artist-sec {
    padding: 0 var(--gutter);
    margin-bottom: 14px;
  }
  .grid-section {
    padding: 8px var(--gutter) 28px;
  }
  .grid-section .sec-title {
    margin-bottom: 16px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(clamp(140px, 11vw, 200px) * var(--card-scale, 1)), 1fr));
    gap: 28px clamp(14px, 1.3vw, 22px);
  }

  .person {
    display: grid;
    justify-items: center;
    width: clamp(108px, 8vw, 136px);
    text-align: center;
  }
  .person:focus-visible {
    box-shadow: none;
  }
  .face {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1;
    margin-bottom: 10px;
    border-radius: 50%;
    overflow: hidden;
    background: linear-gradient(160deg, var(--bg-elevated-2), var(--bg-elevated));
    transition: transform var(--t-slow) var(--spring);
  }
  .face img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .initials {
    font-size: var(--fs-title-2);
    font-weight: 650;
    color: var(--label-3);
  }
  .person:hover .face,
  .person:focus-visible .face {
    will-change: transform;
    transform: scale(1.06);
  }
  .p-name {
    max-width: 100%;
    font-size: var(--fs-callout);
    font-weight: 560;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .p-role {
    max-width: 100%;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .about {
    margin: 12px var(--gutter) 0;
    padding-top: 22px;
    border-top: 1px solid var(--separator);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 18px 32px;
    margin: 16px 0 0;
  }
  dt {
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-3);
    margin-bottom: 3px;
  }
  dd {
    margin: 0;
    font-size: var(--fs-callout);
    color: var(--label-2);
    user-select: text;
  }
  .file {
    margin: 22px 0 0;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 1000px) {
    .hero.with-poster .poster:not(.round):not(.square) {
      display: none;
    }
  }
</style>
