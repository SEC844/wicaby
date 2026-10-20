<script lang="ts">
  // Android TV HomeSection (Settings.kt): the home rows (HomeGroup: show or hide, move, posters or thumbnails), the
  // tab bar (TabBarGroup), the external ratings key (RatingsGroup) and whether a search lists episodes.
  import type { BaseItem } from '$shared/models';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { confirm, toggle } from '../../components/settings/rows';
  import TextField from '../../components/TextField.svelte';
  import { ratings, setRatingsKey } from '../../lib/ratings.svelte';
  import { showToast } from '../../lib/toast.svelte';
  import { defaults, latestViewId, move, NEXT_UP, RESUME, UPCOMING, BECAUSE, LIVE_NOW, MEMORIES } from '../../lib/home-rows';
  import { t } from '../../lib/i18n.svelte';
  import { showAlert } from '../../lib/overlay.svelte';
  import { isMulti, prefs, serverName } from '../../lib/session.svelte';
  import { extraViews, libraryRef } from '../../lib/servers';
  import { useLoad } from '../../lib/load.svelte';
  import { arrange, homeRows, setHomeRows, setTabBarPref, settings, tabBarPref } from '../../lib/settings.svelte';
  import type { TopTab } from '../../lib/tabs';

  let { views, tabs }: { views: BaseItem[]; tabs: TopTab[] } = $props();


  // --- Home rows (TP-07) ---
  const user = $derived(`${prefs.session!.server.id}/${prefs.session!.userId}`);
  const merged = $derived(settings.mergeContinue.value);
  const latestOf = (list: BaseItem[]) => list.filter((v) => !['playlists', 'livetv', 'folders'].includes(v.CollectionType ?? ''));
  // TP-06: the other servers' libraries have their rows too (HomeTab).
  const extras = useLoad(
    () => (isMulti() ? `extra-views-${(prefs.extras ?? []).map((e) => e.server.id).join(',')}` : 'extra-views-off'),
    () => (isMulti() ? extraViews() : Promise.resolve([])),
  );
  const latestViews = $derived([...latestOf(views), ...latestOf(extras.value ?? [])]);
  const homeDefaults = $derived(
    defaults(
      latestViews.map((v) => libraryRef(v, prefs.session!.server.id)),
      merged,
      views.some((v) => v.CollectionType === 'livetv'),
      views.some((v) => v.CollectionType === 'photos'),
    ),
  );
  const pref = $derived(homeRows(user, homeDefaults));
  const rows = $derived(arrange(homeDefaults, pref));

  function label(id: string): string {
    if (id === RESUME) return t(merged ? 'continue_watching_merged' : 'continue_watching');
    if (id === NEXT_UP) return t('next_up');
    if (id === UPCOMING) return t('row_upcoming');
    if (id === BECAUSE) return t('row_because_any');
    if (id === LIVE_NOW) return t('row_live_now');
    if (id === MEMORIES) return t('photos_memories_title');
    const v = latestViews.find((x) => libraryRef(x, prefs.session!.server.id) === latestViewId(id));
    const name = v?.ServerId && v.ServerId !== prefs.session!.server.id ? `${v.Name} · ${serverName(v.ServerId) ?? ''}` : (v?.Name ?? '');
    return t('latest_in', name);
  }

  function rowMenu(id: string, i: number): void {
    const hidden = pref.hidden.includes(id);
    const thumb = pref.thumb.includes(id);
    const save = (p: typeof pref) => setHomeRows(user, p);
    const actions = [
      { label: t(hidden ? 'home_row_show' : 'home_row_hide'), run: () => save({ ...pref, order: rows, hidden: hidden ? pref.hidden.filter((h) => h !== id) : [...pref.hidden, id] }) },
    ];
    if (i > 0) actions.push({ label: t('home_row_up'), run: () => save({ ...pref, order: move(rows, i, i - 1) }) });
    if (i < rows.length - 1) actions.push({ label: t('home_row_down'), run: () => save({ ...pref, order: move(rows, i, i + 1) }) });
    if (latestViewId(id) !== null)
      actions.push({ label: t(thumb ? 'home_row_posters' : 'home_row_thumbs'), run: () => save({ ...pref, order: rows, thumb: thumb ? pref.thumb.filter((h) => h !== id) : [...pref.thumb, id] }) });
    showAlert({ title: label(id), actions });
  }

  // --- #6: the tabs between Home and Search, in the user's order, each shown or hidden ---
  const tabPref = $derived(tabBarPref(user));
  const tabKeys = $derived(arrange(tabs.map((tb) => tb.key), tabPref));
  const tabLabel = (key: string) => tabs.find((tb) => tb.key === key)?.label ?? key;
  function tabMenu(key: string, i: number): void {
    const hidden = tabPref.hidden.includes(key);
    const save = (p: typeof tabPref) => setTabBarPref(user, p);
    const actions = [
      { label: t(hidden ? 'home_row_show' : 'home_row_hide'), run: () => save({ ...tabPref, order: tabKeys, hidden: hidden ? tabPref.hidden.filter((h) => h !== key) : [...tabPref.hidden, key] }) },
    ];
    if (i > 0) actions.push({ label: t('home_row_up'), run: () => save({ ...tabPref, order: move(tabKeys, i, i - 1) }) });
    if (i < tabKeys.length - 1) actions.push({ label: t('home_row_down'), run: () => save({ ...tabPref, order: move(tabKeys, i, i + 1) }) });
    showAlert({ title: tabLabel(key), actions });
  }

  // The MDBList key for IMDb, Rotten Tomatoes… on the detail pages (core/ratings). Off until set.
  let ratingsKey = $state('');
  function saveKey(key: string): void {
    if (setRatingsKey(key)) ratingsKey = '';
    else showToast(t('ratings_invalid'));
  }

  function rowValue(id: string): string {
    const state = t(pref.hidden.includes(id) ? 'home_row_hidden' : 'home_row_shown');
    if (latestViewId(id) === null || pref.hidden.includes(id)) return state;
    return `${state} · ${t(pref.thumb.includes(id) ? 'home_row_thumbs' : 'home_row_posters')}`;
  }
</script>

<SettingsGroup title={t('group_home')}>
  <SettingRow {...toggle(t('row_hero'), settings.rowHero)} />
  {#if settings.rowHero.value}<SettingRow {...toggle(t('hero_hide_watched'), settings.heroHideWatched)} />{/if}
  <SettingRow {...toggle(t('settings_merge_continue'), settings.mergeContinue)} />
</SettingsGroup>
<SettingsGroup title={t('group_home_rows')} hint={t('home_rows_hint')}>
  {#each rows as id, i (id)}
    <SettingRow label={label(id)} value={rowValue(id)} chevron onclick={() => rowMenu(id, i)} />
  {/each}
  <SettingRow {...confirm(t('home_rows_reset'), t('confirm_reset'), () => setHomeRows(user, { order: homeDefaults, hidden: [], thumb: [] }))} />
</SettingsGroup>

{#if tabs.length}
  <SettingsGroup title={t('group_tab_bar')} hint={t('tab_bar_hint')}>
    {#each tabKeys as key, i (key)}
      <SettingRow label={tabLabel(key)} value={t(tabPref.hidden.includes(key) ? 'tab_hidden' : 'tab_shown')} chevron onclick={() => tabMenu(key, i)} />
    {/each}
    <SettingRow {...confirm(t('tab_bar_reset'), t('confirm_reset'), () => setTabBarPref(user, { order: [], hidden: [], thumb: [] }))} />
  </SettingsGroup>
{/if}
<SettingsGroup title={t('ratings_title')} hint={t('ratings_desc')}>
  <TextField bind:value={ratingsKey} placeholder={t(ratings.configured ? 'ratings_saved' : 'ratings_key')} password onsubmit={() => ratingsKey.trim() && saveKey(ratingsKey)} />
  <SettingRow label={t('ratings_save')} chevron onclick={() => ratingsKey.trim() && saveKey(ratingsKey)} />
  {#if ratings.configured}<SettingRow label={t('ratings_remove')} onclick={() => saveKey('')} />{/if}
</SettingsGroup>
<p class="t-footnote label-3 hint">{t('ratings_hint')}</p>
<SettingsGroup title={t('tab_search')} hint={t('search_episodes_hint')}>
  <SettingRow {...toggle(t('search_episodes'), settings.searchEpisodes)} />
</SettingsGroup>

<style>
  .hint {
    margin: -16rem 18rem 26rem;
  }
</style>
