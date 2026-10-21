<script lang="ts">
  // The app shell (Android MainActivity + MainShell): the page layer, the tab bar while signed in, the dialog layer,
  // the toasts and the update banner.
  import { skipPicker } from '$tv/profiles.svelte';
  import { prefs } from '$tv/session.svelte';
  import AlertSheet from './components/AlertSheet.svelte';
  import Pages from './components/Pages.svelte';
  import TabBar from './components/TabBar.svelte';
  import Toast from './components/Toast.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import { isFullScreen, nav, stack } from './lib/nav.svelte';
  import { overlay } from './lib/overlay.svelte';
  import Login from './screens/Login.svelte';
  import Main from './screens/Main.svelte';
  import Pending from './screens/Pending.svelte';
  import Servers from './screens/Servers.svelte';

  // MainActivity's start route: the session, else the saved server's sign-in, else the server page.
  // TP-10: "Who's watching?" first, unless this phone has one account without a PIN and the picker is skipped.
  if (prefs.session) nav.reset(skipPicker(prefs.session) ? { name: 'main' } : { name: 'login', server: prefs.session.server });
  else if (prefs.server) nav.reset({ name: 'login', server: prefs.server });
  else nav.reset({ name: 'servers' });

  const top = $derived(stack[stack.length - 1]);
  const tabs = $derived(stack[0]?.route.name === 'main' && !(top && isFullScreen(top.route)));
</script>

<Pages>
  {#snippet page(e)}
    {#if e.route.name === 'servers'}
      <Servers add={e.route.add} />
    {:else if e.route.name === 'login'}
      <Login server={e.route.server} add={e.route.add} />
    {:else if e.route.name === 'main'}
      <Main />
    {:else}
      <Pending route={e.route} />
    {/if}
  {/snippet}
</Pages>
{#if tabs}<TabBar />{/if}
{#if overlay.alert}<AlertSheet alert={overlay.alert} />{/if}
<Toast />
<UpdateBanner />
