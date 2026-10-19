<script lang="ts">
  // Android TV MainScreen (ui/Main.kt): the floating tab bar over the selected tab. Home first, then the libraries,
  // then Search and Settings pinned as icons. Tabs visited stay mounted (hidden) so coming back keeps their scroll
  // and focus; Back from the content goes up to the bar, from the bar the app shell asks to quit.
  import type { BaseItem } from '$shared/models';
  import { getContext, onMount } from 'svelte';
  import TopBar from '../components/TopBar.svelte';
  import { focused, setFocus } from '../lib/focus';
  import { t } from '../lib/i18n.svelte';
  import { clearCache, useLoad } from '../lib/load.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { api, prefs, signOut } from '../lib/session.svelte';
  import { settings } from '../lib/settings.svelte';
  import { browsable, type TopTab } from '../lib/tabs';
  import HomeTab from '../tabs/HomeTab.svelte';
  import LibraryTab from '../tabs/LibraryTab.svelte';
  import SearchTab from '../tabs/SearchTab.svelte';
  import SettingsTab from '../tabs/SettingsTab.svelte';

  const client = api()!;
  const session = prefs.session!;
  const views = useLoad(() => 'views', () => client.views(), { persist: true });
  const tabViews = $derived((views.value ?? []).filter((v) => browsable(v.CollectionType)));

  const tabs = $derived<TopTab[]>([
    { key: 'home', label: t('tab_home') },
    ...tabViews.map((v) => ({ key: `lib:${v.Id}`, label: v.Name })),
    { key: 'search', label: t('tab_search'), icon: 'Search' },
    { key: 'settings', label: t('tab_settings'), icon: 'Gear' },
  ]);

  let tab = $state('home');
  // Tabs mounted so far, kept alive while hidden.
  let visited = $state<string[]>(['home']);
  let scrolled = $state(false);
  let barFocused = $state(false);

  function select(key: string): void {
    if (tab === key) return;
    tab = key;
    scrolled = false;
    if (!visited.includes(key)) visited = [...visited, key];
  }

  function view(key: string): BaseItem | undefined {
    return tabViews.find((v) => `lib:${v.Id}` === key);
  }

  function selectedTab(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-screen-top] [data-tab="${tab}"]`);
  }

  function leave(forget: boolean): void {
    signOut(forget);
    clearCache();
    nav.reset({ name: 'login', server: session.server });
  }

  function openProfile(): void {
    showAlert({
      title: session.userName,
      message: session.server.name,
      actions: [
        { label: t('switch_user'), run: () => leave(false) },
        { label: t('switch_server'), run: () => nav.reset({ name: 'servers' }) },
        { label: t('tab_settings'), run: () => { select('settings'); requestAnimationFrame(() => setFocus(selectedTab())); } },
        { label: t('sign_out'), destructive: true, run: () => leave(true) },
      ],
    });
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    const track = (e: Event) => {
      barFocused = !!(e.target as HTMLElement).closest('.topbar');
    };
    document.addEventListener('tvfocus', track);
    // Back: from the content, up to the bar (tvOS); from the bar, false lets the shell ask to quit.
    const stop = onBack(screen, () => {
      if (focused()?.closest('.topbar')) return false;
      setFocus(selectedTab());
      return true;
    });
    return () => {
      document.removeEventListener('tvfocus', track);
      stop();
    };
  });
</script>

<div class="main">
  {#each visited as key (key)}
    <div class="tab" class:hidden={key !== tab} data-focus-group>
      {#if key === 'home'}
        <HomeTab api={client} views={views.value ?? []} onscrolled={(s) => (scrolled = s)} />
      {:else if key === 'search'}
        <SearchTab api={client} />
      {:else if key === 'settings'}
        <SettingsTab api={client} views={views.value ?? []} onscrolled={(s) => (scrolled = s)} />
      {:else if view(key)}
        <LibraryTab api={client} view={view(key)!} onscrolled={(s) => (scrolled = s)} />
      {/if}
    </div>
  {/each}
  <TopBar
    {tabs}
    selected={tab}
    visible={barFocused || !scrolled}
    showClock={settings.clock.value}
    userName={session.userName}
    userImage={client.userImage({ Id: session.userId }, 160)}
    onselect={select}
    onavatar={openProfile}
  />
</div>

<style>
  .main,
  .tab {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .hidden {
    display: none;
  }
</style>
