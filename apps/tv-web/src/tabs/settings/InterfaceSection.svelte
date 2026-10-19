<script lang="ts">
  // Android TV InterfaceSection (Settings.kt): language, appearance (theme, accent, clock) and the home rows
  // (HomeGroup: show or hide, move, posters or thumbnails). The screensaver group arrives with the photos (M3).
  import type { BaseItem } from '$shared/models';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, toggle } from '../../components/settings/rows';
  import { focusable } from '../../lib/focus';
  import { defaults, latestViewId, move, NEXT_UP, RESUME, UPCOMING, BECAUSE, LIVE_NOW, MEMORIES } from '../../lib/home-rows';
  import { setLanguage, t } from '../../lib/i18n.svelte';
  import { showAlert } from '../../lib/overlay.svelte';
  import { prefs } from '../../lib/session.svelte';
  import { arrange, homeRows, setHomeRows, setTabBarPref, settings, tabBarPref } from '../../lib/settings.svelte';
  import type { TopTab } from '../../lib/tabs';
  import { palette } from '../../lib/theme';
  import Icon from '../../components/Icon.svelte';
  import ThemeCards from '../../components/ThemeCards.svelte';

  let { views, tabs }: { views: BaseItem[]; tabs: TopTab[] } = $props();

  const LANGS = ['auto', 'fr', 'en'] as const;

  // --- Home rows (TP-07) ---
  const user = $derived(`${prefs.session!.server.id}/${prefs.session!.userId}`);
  const merged = $derived(settings.mergeContinue.value);
  const latestViews = $derived(views.filter((v) => !['playlists', 'livetv', 'folders'].includes(v.CollectionType ?? '')));
  const homeDefaults = $derived(defaults(latestViews.map((v) => v.Id), merged));
  const pref = $derived(homeRows(user, homeDefaults));
  const rows = $derived(arrange(homeDefaults, pref));

  function label(id: string): string {
    if (id === RESUME) return t(merged ? 'continue_watching_merged' : 'continue_watching');
    if (id === NEXT_UP) return t('next_up');
    if (id === UPCOMING) return t('row_upcoming');
    if (id === BECAUSE) return t('row_because_any');
    if (id === LIVE_NOW) return t('row_live_now');
    if (id === MEMORIES) return t('photos_memories_title');
    return t('latest_in', latestViews.find((v) => v.Id === latestViewId(id))?.Name ?? '');
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

  function rowValue(id: string): string {
    const state = t(pref.hidden.includes(id) ? 'home_row_hidden' : 'home_row_shown');
    if (latestViewId(id) === null || pref.hidden.includes(id)) return state;
    return `${state} · ${t(pref.thumb.includes(id) ? 'home_row_thumbs' : 'home_row_posters')}`;
  }
</script>

<SettingsGroup>
  <!-- The language names stay in their own language, so either reader can find theirs. -->
  <SettingRow
    {...choice(t('language'), [t('language_system'), t('language_fr'), t('language_en')], LANGS.indexOf(settings.language.value), (i) => {
      settings.language.value = LANGS[i];
      setLanguage(LANGS[i]);
    })}
  />
</SettingsGroup>

<SettingsGroup title={t('section_appearance')}>
  <!-- Each card is drawn in its own theme; picking one applies it to the whole screen at once. -->
  <p class="t-headline theme-title">{t('settings_theme')}</p>
  <ThemeCards
    current={palette(settings.theme.value).id}
    onpick={(id) => {
      settings.theme.value = id;
      settings.themeHintShown.value = true;
    }}
  />
  <div class="accent-row">
    <span class="t-headline">{t('settings_accent')}</span>
    <div class="accents">
      {#each palette(settings.theme.value).accents as a, i (i)}
        <button class="accent" style="background:{a.color};color:{a.fg}" aria-label={a.color} use:focusable onclick={() => (settings.accent.value = i)}>
          {#if i === settings.accent.value}<Icon name="Check" size={16} />{/if}
        </button>
      {/each}
    </div>
  </div>
  <SettingRow {...toggle(t('show_clock'), settings.clock)} />
</SettingsGroup>

<SettingsGroup title={t('group_home')} hint={t('home_rows_hint')}>
  <SettingRow {...toggle(t('row_hero'), settings.rowHero)} />
  {#if settings.rowHero.value}<SettingRow {...toggle(t('hero_hide_watched'), settings.heroHideWatched)} />{/if}
  <SettingRow {...toggle(t('settings_merge_continue'), settings.mergeContinue)} />
  {#each rows as id, i (id)}
    <SettingRow label={label(id)} value={rowValue(id)} chevron onclick={() => rowMenu(id, i)} />
  {/each}
  <SettingRow label={t('home_rows_reset')} onclick={() => setHomeRows(user, { order: homeDefaults, hidden: [], thumb: [] })} />
</SettingsGroup>

{#if tabs.length}
  <SettingsGroup title={t('group_tab_bar')} hint={t('tab_bar_hint')}>
    {#each tabKeys as key, i (key)}
      <SettingRow label={tabLabel(key)} value={t(tabPref.hidden.includes(key) ? 'tab_hidden' : 'tab_shown')} chevron onclick={() => tabMenu(key, i)} />
    {/each}
    <SettingRow label={t('tab_bar_reset')} onclick={() => setTabBarPref(user, { order: [], hidden: [], thumb: [] })} />
  </SettingsGroup>
{/if}

<style>
  .theme-title {
    margin: 4rem 0 0 18rem;
  }
  .accent-row {
    display: flex;
    align-items: center;
    margin-top: 4rem;
    padding: 12rem 18rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .accent-row > span {
    flex: 1;
  }
  .accents {
    display: flex;
  }
  .accent {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28rem;
    height: 28rem;
    margin-left: 12rem;
    border-radius: 50%;
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med);
  }
  .accent:global(.focused) {
    transform: scale(1.3);
    box-shadow: 0 10rem 20rem rgba(0, 0, 0, 0.5);
  }
</style>
