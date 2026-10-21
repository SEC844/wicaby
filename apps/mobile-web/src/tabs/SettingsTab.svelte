<script lang="ts">
  // Réglages (M0): the account, the look and the version. The full settings tree (playback, subtitles, Home,
  // accounts) is M1, on the shared TV web settings.
  import { t } from '$tv/i18n.svelte';
  import { clearCache } from '$tv/load.svelte';
  import { settings } from '$tv/settings.svelte';
  import { api, prefs, signOut } from '$tv/session.svelte';
  import Avatar from '../components/Avatar.svelte';
  import { nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { applyTheme } from '../lib/theme';
  import { standalone } from '../platform';
  import { VERSION } from '../lib/identity';

  const THEMES = [
    ['system', 'theme_system'],
    ['graphite', 'theme_graphite'],
    ['oled', 'theme_oled'],
    ['slate', 'theme_slate'],
    ['cinema', 'theme_cinema'],
    ['contrast', 'theme_contrast'],
    ['light', 'theme_light'],
  ] as const;

  const session = $derived(prefs.session);

  function pickTheme(): void {
    showAlert({
      title: t('settings_theme'),
      actions: THEMES.map(([id, key]) => ({ label: t(key), run: () => (settings.theme.value = id) })),
      selected: Math.max(0, THEMES.findIndex(([id]) => id === settings.theme.value)),
    });
  }
  $effect(() => applyTheme(settings.theme.value, settings.accent.value));

  // Switching user keeps the token for the profile picker. Signing out forgets the profile and revokes its token on
  // the server too, so a copy of this phone's storage opens nothing.
  function leave(forget: boolean): void {
    const server = prefs.session?.server;
    if (forget) void api()?.post('/Sessions/Logout').catch(() => {});
    signOut(forget);
    clearCache();
    nav.reset(server ? { name: 'login', server } : { name: 'servers' });
  }

  function confirmSignOut(): void {
    showAlert({
      title: t('sign_out'),
      actions: [
        { label: t('sign_out'), destructive: true, run: () => leave(true) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }
</script>

<div class="page">
  <h1 class="large-title head">{t('tab_settings')}</h1>

  {#if session}
    <h2 class="footnote label-2 eyebrow">{t('settings_account')}</h2>
    <div class="group">
      <div class="cell account">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={api()!} size={52} />
        <span class="text">
          <span class="headline">{session.userName}</span>
          <span class="footnote label-2">{session.server.name} · {session.server.address}</span>
        </span>
      </div>
      <button class="cell action" onclick={() => leave(false)}>{t('switch_user')}</button>
      <button class="cell action destructive" onclick={confirmSignOut}>{t('sign_out')}</button>
    </div>
  {/if}

  <h2 class="footnote label-2 eyebrow">{t('settings_appearance')}</h2>
  <div class="group">
    <button class="cell" onclick={pickTheme}>
      <span class="grow">{t('settings_theme')}</span>
      <span class="label-2">{t(THEMES.find(([id]) => id === settings.theme.value)?.[1] ?? 'theme_graphite')}</span>
    </button>
  </div>

  {#if !standalone}
    <h2 class="footnote label-2 eyebrow">{t('web_install_title')}</h2>
    <div class="group"><p class="cell footnote label-2">{t('web_install_body')}</p></div>
  {/if}

  <h2 class="footnote label-2 eyebrow">{t('about')}</h2>
  <div class="group">
    <div class="cell"><span class="grow">{t('version')}</span><span class="label-2 mono">{VERSION}</span></div>
  </div>
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding: calc(var(--safe-top) + 12px) max(var(--gutter), var(--safe-right)) calc(var(--tabbar) + 32px) max(var(--gutter), var(--safe-left));
  }
  .head {
    margin-bottom: 8px;
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 28px 0 8px 16px;
  }
  .group {
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .cell {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    text-align: left;
  }
  .cell + .cell {
    border-top: 0.5px solid var(--separator);
  }
  button.cell:active {
    background: var(--fill-2);
  }
  .grow,
  .text {
    flex: 1;
    min-width: 0;
  }
  .text {
    display: flex;
    flex-direction: column;
  }
  .text span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    color: var(--accent);
  }
  .destructive {
    color: var(--red);
  }
</style>
