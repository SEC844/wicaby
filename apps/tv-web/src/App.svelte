<script lang="ts">
  // The app shell (Android TV MainActivity): the screen stack, the remote keys and the dialog layer.
  import { onMount } from 'svelte';
  import AlertDialog from './components/AlertDialog.svelte';
  import Screen from './components/Screen.svelte';
  import { move, select } from './lib/focus';
  import { t } from './lib/i18n.svelte';
  import { handleBack, nav, stack } from './lib/nav.svelte';
  import { closeAlert, overlay, showAlert } from './lib/overlay.svelte';
  import { prefs } from './lib/session.svelte';
  import { exitApp } from './platform';
  import { keyOf } from './platform/keys';
  import Login from './screens/Login.svelte';
  import Main from './screens/Main.svelte';
  import Servers from './screens/Servers.svelte';

  // MainActivity's start route: the session, else the saved server's sign-in, else the server screen.
  if (prefs.session) nav.reset({ name: 'main' });
  else if (prefs.server) nav.reset({ name: 'login', server: prefs.server });
  else nav.reset({ name: 'servers' });

  function confirmQuit(): void {
    showAlert({
      title: t('quit_title'),
      actions: [
        { label: t('quit'), destructive: true, run: exitApp },
        { label: t('cancel'), run: () => {} },
      ],
      focusIndex: 1,
    });
  }

  // In a text field, Left/Right move the caret until it reaches an end; then they move the focus like elsewhere.
  function caretKeeps(e: KeyboardEvent, dir: 'left' | 'right'): boolean {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return false;
    const at = el.selectionStart ?? 0;
    return dir === 'left' ? at > 0 : at < el.value.length;
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (!key) return;
      if ((key === 'left' || key === 'right') && caretKeeps(e, key)) return;
      // Backspace edits text; only Escape and the remote's Back key go back from a field.
      if (key === 'back' && e.keyCode === 8 && e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') move(key);
      else if (key === 'ok') select();
      else if (key === 'back') {
        if (overlay.alert) closeAlert();
        else if (!handleBack()) confirmQuit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#each stack as entry, i (entry.key)}
  <Screen key={entry.key} top={i === stack.length - 1}>
    {#if entry.route.name === 'servers'}
      <Servers add={entry.route.add} />
    {:else if entry.route.name === 'login'}
      <Login server={entry.route.server} add={entry.route.add} />
    {:else if entry.route.name === 'main'}
      <Main />
    {/if}
  </Screen>
{/each}
{#if overlay.alert}<AlertDialog alert={overlay.alert} />{/if}
