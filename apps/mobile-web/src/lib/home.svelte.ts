// Home's data, as the TV web app's HomeTab loads it (apps/tv-web/src/tabs/HomeTab.svelte, Android Main.kt): the
// hero's titles, then the user's rows in their saved order (Settings > Home): Continue watching (merged with Next
// up, or apart), Upcoming, each library's Recently added, "Because you watched". Rows paint from the last visit
// (persisted) and refresh behind. Live TV now and photo memories join with M3.
// Call useHome() from a component's script: it sets up the component's loads.
import type { BaseItem } from '$shared/models';
import type { SeriesDates } from '$desktop/continue';
import type { Api } from '$tv/api';
import { continueSubtitle, loadContinueAll } from '$tv/continue-watching';
import { BECAUSE, becauseSeeds, defaults, latestViewId, NEXT_UP, RESUME, UPCOMING, unseen } from '$tv/home-rows';
import { t } from '$tv/i18n.svelte';
import { useLoad } from '$tv/load.svelte';
import { extraViews as loadExtraViews, libraryRef, merged as mergedAll } from '$tv/servers';
import { apiOf, isMulti, prefs, serverName } from '$tv/session.svelte';
import { arrange, homeRows, settings } from '$tv/settings.svelte';

export interface HomeRow {
  key: string;
  title: string;
  items: BaseItem[];
  // 16:9 cards with a progress bar (Continue watching, Next up…), else posters.
  wide: boolean;
  // A tap plays (Continue watching, Next up); elsewhere it opens the title's page.
  playable: boolean;
  subtitle?: (item: BaseItem) => string | undefined;
  // The merged Continue watching row's series dates: its cards' menu can remove them.
  continueRow?: SeriesDates;
}

// The libraries with a Recently added row: all but playlists, Live TV and folders (HomeLayout.kt latestViews).
// Music, photos and books join with their pages (M3).
const latestOf = (list: BaseItem[]) => list.filter((v) => !['playlists', 'livetv', 'folders', 'music', 'photos', 'books'].includes(v.CollectionType ?? ''));
const airDate = (i: BaseItem) => Date.parse(i.PremiereDate ?? '') || 0;

export function useHome(api: Api, views: () => BaseItem[]) {
  const serverId = prefs.session!.server.id;
  const user = `${serverId}/${prefs.session!.userId}`;
  const merged = $derived(settings.mergeContinue.value);
  const multi = $derived(isMulti());

  const extra = useLoad(
    () => (multi ? `extra-views-${(prefs.extras ?? []).map((e) => e.server.id).join(',')}` : 'extra-views-off'),
    () => (multi ? loadExtraViews() : Promise.resolve([])),
  );
  const latestViews = $derived([...latestOf(views()), ...latestOf(extra.value ?? [])]);
  const viewRef = (v: BaseItem) => libraryRef(v, serverId);
  const homeDefaults = $derived(defaults(latestViews.map(viewRef), merged));
  const pref = $derived(homeRows(user, homeDefaults));
  const shown = $derived(arrange(homeDefaults, pref).filter((id) => !pref.hidden.includes(id)));

  // #8: unwatched titles only when asked, all of them when everything is watched (Main.kt heroItems).
  const pickHero = async (unwatched: boolean) =>
    (
      await api.items({
        IncludeItemTypes: 'Movie,Series',
        Recursive: true,
        SortBy: 'Random',
        Limit: 10,
        ImageTypes: 'Backdrop',
        EnableImageTypes: 'Primary,Backdrop,Logo,Thumb',
        Fields: 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,ChildCount',
        Filters: unwatched ? 'IsUnplayed' : undefined,
      })
    ).Items.filter((i) => i.BackdropImageTags?.length).slice(0, 6);
  const hideWatched = $derived(settings.heroHideWatched.value);
  const hero = useLoad(
    () => (!settings.rowHero.value ? 'hero-off' : hideWatched ? 'hero-unwatched' : 'hero'),
    async () => {
      if (!settings.rowHero.value) return [];
      if (!hideWatched) return pickHero(false);
      const list = await pickHero(true);
      return list.length ? list : pickHero(false);
    },
    // A new draw per launch, stable for the session.
    { refresh: false },
  );

  const cont = useLoad(() => (merged ? 'continue' : 'continue-off'), () => (merged ? loadContinueAll(api, serverId) : Promise.resolve(null)), { persist: true });
  const resume = useLoad(() => (merged ? 'resume-off' : 'resume'), () => (merged ? Promise.resolve([]) : mergedAll((a) => a.resume(), true)), { persist: true });
  const nextUp = useLoad(() => (merged ? 'nextup-off' : 'nextup'), () => (merged ? Promise.resolve([]) : mergedAll((a) => a.nextUp())), { persist: true });
  const upcoming = useLoad(() => 'upcoming', async () => (await mergedAll((a) => a.upcoming())).sort((x, y) => airDate(x) - airDate(y)), { persist: true });
  // One load for every Recently added row: their order and visibility change without refetching.
  const latests = useLoad(
    () => `latest:${latestViews.map(viewRef).join(',')}`,
    async () =>
      Object.fromEntries(
        await Promise.all(
          latestViews.map(async (v) => {
            const a = apiOf(v.ServerId) ?? api;
            const items = await a.latest(v.Id).catch(() => [] as BaseItem[]);
            return [viewRef(v), items.map((i) => (i.ServerId ? i : { ...i, ServerId: a.serverId }))] as const;
          }),
        ),
      ),
    { persist: true },
  );
  // "Because you watched": titles similar to the two latest played, minus what the rows above show.
  const because = useLoad(
    () => 'because',
    async () => {
      const played = (await api.items({ Filters: 'IsPlayed', Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 20 })).Items;
      return Promise.all(becauseSeeds(played).map(async (seed) => ({ seed, items: await api.similar(seed.Id, 16).catch(() => []) })));
    },
  );

  const rows = $derived.by(() => {
    let seen: BaseItem[] = [...(cont.value?.items ?? []), ...(resume.value ?? []), ...(nextUp.value ?? []), ...Object.values(latests.value ?? {}).flat()];
    const out: HomeRow[] = [];
    for (const id of shown) {
      if (id === RESUME) {
        if (merged && cont.value?.items.length) out.push({ key: 'continue', title: t('continue_watching_merged'), items: cont.value.items, wide: true, playable: true, subtitle: continueSubtitle, continueRow: cont.value.series });
        if (!merged && resume.value?.length) out.push({ key: 'resume', title: t('continue_watching'), items: resume.value, wide: true, playable: true, continueRow: new Map() });
      } else if (id === NEXT_UP) {
        if (nextUp.value?.length) out.push({ key: 'nextup', title: t('next_up'), items: nextUp.value, wide: true, playable: true });
      } else if (id === UPCOMING) {
        if (upcoming.value?.length) out.push({ key: 'upcoming', title: t('row_upcoming'), items: upcoming.value, wide: true, playable: false });
      } else if (id === BECAUSE) {
        for (const b of because.value ?? []) {
          const items = unseen(b.items, seen);
          seen = [...seen, ...items];
          if (items.length) out.push({ key: `because-${b.seed.Id}`, title: t('row_because', b.seed.Name), items, wide: false, playable: false });
        }
      } else {
        const viewId = latestViewId(id);
        const view = latestViews.find((v) => viewRef(v) === viewId);
        const items = viewId ? latests.value?.[viewId] : undefined;
        // Another server's library names its server: "Films · <server name>".
        const name = view && view.ServerId && view.ServerId !== serverId ? `${view.Name} · ${serverName(view.ServerId) ?? ''}` : view?.Name;
        if (view && items?.length) out.push({ key: id, title: t('latest_in', name ?? ''), items, wide: pref.thumb.includes(id), playable: false });
      }
    }
    return out;
  });

  return {
    get hero() {
      return hero.value ?? [];
    },
    get rows() {
      return rows;
    },
    get loading() {
      return cont.loading && latests.loading;
    },
  };
}
