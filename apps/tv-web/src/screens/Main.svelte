<script lang="ts">
  // Android TV MainScreen (ui/Main.kt): the floating tab bar over the selected tab. Home first, then the libraries,
  // then Search and Settings pinned as icons. Tabs visited stay mounted (hidden) so coming back keeps their scroll
  // and focus; Back from the content goes up to the bar, from the bar the app shell asks to quit.
  import type { BaseItem } from '$shared/models';
  import { unauthorized } from '../lib/api';
  import { getContext, onMount } from 'svelte';
  import ProfileMenu from '../components/ProfileMenu.svelte';
  import TopBar from '../components/TopBar.svelte';
  import { focused, setFocus } from '../lib/focus';
  import { repick } from '../lib/addresses.svelte';
  import { runHomeRefresh } from '../lib/auto-refresh';
  import { forgetPin } from '../lib/profiles.svelte';
  import { runRemoteControl } from '../lib/remote-control';
  import { runScrobbleRetries } from '../lib/scrobble.svelte';
  import { postCapabilities } from '../lib/server-socket';
  import { t } from '../lib/i18n.svelte';
  import { clearCache, useLoad } from '../lib/load.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { api, prefs, signOut } from '../lib/session.svelte';
  import { settings, tabBarPref } from '../lib/settings.svelte';
  import { browsable, movableTabs, tabBar, type TopTab } from '../lib/tabs';
  import HomeTab from '../tabs/HomeTab.svelte';
  import LibraryTab from '../tabs/LibraryTab.svelte';
  import SearchTab from '../tabs/SearchTab.svelte';
  import SettingsTab from '../tabs/SettingsTab.svelte';

  const client = api()!;
  const session = prefs.session!;
  const views = useLoad(() => 'views', () => client.views(), { persist: true });
  // The avatar needs the user's image tag (Chrome.kt UserAvatar).
  const me = useLoad(() => 'me', () => client.me(), { persist: true });
  const tabViews = $derived((views.value ?? []).filter((v) => browsable(v.CollectionType)));

  // Every destination in its default order; Settings > Interface > Tab bar lists the movable ones.
  const allTabs = $derived<TopTab[]>([
    { key: 'home', label: t('tab_home') },
    ...tabViews.map((v) => ({ key: `lib:${v.Id}`, label: v.Name })),
    { key: 'search', label: t('tab_search'), icon: 'Search' },
    { key: 'settings', label: t('tab_settings'), icon: 'Gear' },
  ]);
  let tab = $state('home');
  // #6: the user's order, hidden tabs left out (the open one stays).
  const tabs = $derived(tabBar(allTabs, tabBarPref(`${session.server.id}/${session.userId}`), tab));
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
    // Signing out forgets the saved profile and its PIN (TP-10); Switch User keeps both.
    if (forget) forgetPin(session);
    signOut(forget);
    clearCache();
    nav.reset({ name: 'login', server: session.server });
  }

  // Settings > "Control from other devices" changed: the server hears it at once.
  let postedControl = settings.remoteControl.value;
  $effect(() => {
    const on = settings.remoteControl.value;
    if (on === postedControl) return;
    postedControl = on;
    void postCapabilities(client).catch(() => {});
  });

  // Android ProfileMenu: OK on the avatar.
  let profileOpen = $state(false);
  const avatarUrl = $derived(me.value ? client.userImage(me.value, 160) : undefined);
  function openProfile(): void {
    profileOpen = true;
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
    // B09: each signed-in server's requests go to whichever of its addresses answers.
    for (const s of [session, ...(prefs.extras ?? [])]) void repick(s.server.id, s.server.address, s.server.kind === 'emby');
    const refresh = runHomeRefresh(client);
    const retries = runScrobbleRetries();
    const remote = runRemoteControl();
    // The account's token refused: back to sign-in (its password asked again), which also stops the socket's
    // reconnects; the profile stays.
    unauthorized.handler = (a) => {
      if (a.token !== session.token || a.serverId !== session.server.id) return;
      unauthorized.handler = null;
      leave(false);
    };
    return () => {
      unauthorized.handler = null;
      document.removeEventListener('tvfocus', track);
      stop();
      refresh();
      retries();
      remote();
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
        <SettingsTab api={client} views={views.value ?? []} tabs={movableTabs(allTabs)} onscrolled={(s) => (scrolled = s)} />
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
    userImage={avatarUrl}
    onselect={select}
    onavatar={openProfile}
  />
  {#if profileOpen}
    <ProfileMenu
      name={session.userName}
      server={session.server.name}
      image={avatarUrl}
      onclose={() => (profileOpen = false)}
      onswitchuser={() => leave(false)}
      onswitchserver={() => nav.reset({ name: 'servers' })}
      onhistory={() => nav.push({ name: 'history' })}
      onsettings={() => {
        select('settings');
        requestAnimationFrame(() => setFocus(selectedTab()));
      }}
      onsignout={() => leave(true)}
    />
  {/if}
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
