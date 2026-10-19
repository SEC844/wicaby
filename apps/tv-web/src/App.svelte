<script lang="ts">
  // The app shell (Android TV MainActivity): the screen stack, the remote keys and the dialog layer.
  import { onMount } from 'svelte';
  import AlertDialog from './components/AlertDialog.svelte';
  import Screen from './components/Screen.svelte';
  import { move, pressDown, pressUp } from './lib/focus';
  import { t } from './lib/i18n.svelte';
  import { handleBack, nav, stack } from './lib/nav.svelte';
  import { closeAlert, overlay, showAlert } from './lib/overlay.svelte';
  import { prefs } from './lib/session.svelte';
  import { ACCENTS, onAccent, settings } from './lib/settings.svelte';
  import { exitApp } from './platform';
  import { keyOf } from './platform/keys';
  import Folder from './screens/Folder.svelte';
  import Login from './screens/Login.svelte';
  import Main from './screens/Main.svelte';
  import Servers from './screens/Servers.svelte';

  // MainActivity's start route: the session, else the saved server's sign-in, else the server screen.
  if (prefs.session) nav.reset({ name: 'main' });
  else if (prefs.server) nav.reset({ name: 'login', server: prefs.server });
  else nav.reset({ name: 'servers' });

  // Theme and accent (html[data-theme], the accent tokens), following Settings at once.
  $effect(() => {
    const root = document.documentElement;
    if (settings.oled.value) root.setAttribute('data-theme', 'oled');
    else root.removeAttribute('data-theme');
    root.style.setProperty('--accent', ACCENTS[settings.accent.value] ?? ACCENTS[0]);
    root.style.setProperty('--on-accent', onAccent(settings.accent.value));
  });

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
    // A held arrow repeats faster than slow sets paint: one move per frame, so focus never runs ahead of the screen.
    let moved = false;
    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (!key) return;
      if ((key === 'left' || key === 'right') && caretKeeps(e, key)) return;
      // Backspace edits text; only Escape and the remote's Back key go back from a field.
      if (key === 'back' && e.keyCode === 8 && e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
        if (moved) return;
        moved = true;
        requestAnimationFrame(() => (moved = false));
        move(key);
      } else if (key === 'ok') pressDown(e.repeat);
      else if (key === 'back' && !e.repeat) {
        if (overlay.alert) closeAlert();
        else if (!handleBack()) confirmQuit();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (keyOf(e) === 'ok') pressUp();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
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
    {:else if entry.route.name === 'folder'}
      <Folder id={entry.route.id} title={entry.route.title} />
    {/if}
  </Screen>
{/each}
{#if overlay.alert}<AlertDialog alert={overlay.alert} />{/if}
