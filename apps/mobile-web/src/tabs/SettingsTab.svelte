<script lang="ts">
  // Réglages, as iOS Settings lays them out, on the TV web app's settings (same keys and defaults): the account and
  // servers, playback (quality, resume, skipping, Dolby), subtitles, Home, appearance and language, about.
  import { setLanguage, t } from '$tv/i18n.svelte';
  import { clearCache } from '$tv/load.svelte';
  import { api, prefs, removeExtra, signOut } from '$tv/session.svelte';
  import { settings, type Setting } from '$tv/settings.svelte';
  import Avatar from '../components/Avatar.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Group from '../components/settings/Group.svelte';
  import Row from '../components/settings/Row.svelte';
  import { VERSION } from '../lib/identity';
  import { nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { applyTheme } from '../lib/theme';
  import { standalone } from '../platform';

  const a = api()!;
  const session = $derived(prefs.session);

  const THEMES = [
    ['system', 'theme_system'],
    ['graphite', 'theme_graphite'],
    ['oled', 'theme_oled'],
    ['slate', 'theme_slate'],
    ['cinema', 'theme_cinema'],
    ['contrast', 'theme_contrast'],
    ['light', 'theme_light'],
  ] as const;
  const ACCENTS = ['accent_blue', 'accent_indigo', 'accent_purple', 'accent_pink', 'accent_red', 'accent_orange', 'accent_green', 'accent_graphite'];
  const MBPS = [0, 120, 80, 60, 40, 20, 10, 8, 4, 2];
  const SECS = [5, 10, 15, 20, 30];
  const LANGS = [
    ['auto', 'language_system'],
    ['fr', 'language_fr'],
    ['en', 'language_en'],
  ] as const;

  $effect(() => applyTheme(settings.theme.value, settings.accent.value));
  $effect(() => setLanguage(settings.language.value));

  // A row showing the chosen option; a tap opens the sheet with every option.
  function choose(label: string, options: string[], selected: number, onpick: (i: number) => void): void {
    showAlert({ title: label, selected, actions: options.map((o, i) => ({ label: o, run: () => onpick(i) })) });
  }
  const indexed = (label: string, options: string[], s: Setting<number>) => ({
    label,
    value: options[Math.max(0, s.value)] ?? '—',
    onclick: () => choose(label, options, Math.max(0, s.value), (i) => (s.value = i)),
  });
  const toggle = (label: string, s: Setting<boolean>) => ({ label, checked: s.value, ontoggle: (on: boolean) => (s.value = on) });

  const mbpsLabels = $derived(MBPS.map((m) => (m === 0 ? t('settings_bitrate_auto') : t('mbps', m))));
  const skipOptions = $derived([t('skip_ask'), t('skip_auto'), t('skip_off')]);
  const passOptions = $derived([t('pass_auto'), t('pass_on'), t('pass_off')]);
  const sizes = $derived([t('size_small'), t('size_normal'), t('size_large'), t('size_xlarge')]);
  const styles = $derived([t('style_outline'), t('style_shadow'), t('style_box')]);
  const positions = $derived([t('sub_pos_bottom'), t('sub_pos_slightly_raised'), t('sub_pos_raised')]);

  // Switching user keeps the token for the profile picker. Signing out forgets the profile and revokes its token on
  // the server too, so a copy of this phone's storage opens nothing.
  function leave(forget: boolean): void {
    const server = prefs.session?.server;
    if (forget) void api()?.post('/Sessions/Logout').catch(() => {});
    signOut(forget);
    clearCache();
    nav.reset(server ? { name: 'login', server } : { name: 'servers' });
  }

  function confirm(title: string, label: string, run: () => void): void {
    showAlert({ title, actions: [{ label, destructive: true, run }, { label: t('cancel'), run: () => {} }] });
  }
</script>

<LargeTitlePage title={t('tab_settings')} tab="settings">
  {#if session}
    <Group title={t('web_accounts')}>
      <div class="account">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={a} size={56} />
        <span class="who">
          <span class="headline">{session.userName}</span>
          <span class="footnote label-2 ellipsis">{session.server.name} · {session.server.address}</span>
        </span>
      </div>
      <Row label={t('switch_user')} accent onclick={() => leave(false)} />
      <Row label={t('sign_out')} destructive onclick={() => confirm(t('sign_out'), t('sign_out'), () => leave(true))} />
    </Group>

    <Group title={t('other_servers')} hint={t('other_servers_hint')}>
      {#each prefs.extras ?? [] as extra (extra.server.id)}
        <Row label={extra.server.name} value={extra.userName} onclick={() => confirm(extra.server.name, t('remove_server'), () => (removeExtra(extra.server.id), clearCache()))} />
      {/each}
      <Row label={t('add_server')} accent onclick={() => nav.push({ name: 'servers', add: true })} />
    </Group>
  {/if}

  <Group title={t('group_quality')}>
    <Row label={t('settings_bitrate')} value={mbpsLabels[Math.max(0, MBPS.indexOf(settings.mbpsEthernet.value))]} onclick={() => choose(t('settings_bitrate'), mbpsLabels, Math.max(0, MBPS.indexOf(settings.mbpsEthernet.value)), (i) => (settings.mbpsEthernet.value = MBPS[i]))} />
  </Group>

  <Group title={t('web_dolby')} hint={t('web_dolby_hint')}>
    <Row {...indexed('Dolby Digital (AC3)', passOptions, settings.passthrough.ac3)} />
    <Row {...indexed('Dolby Digital Plus (EAC3)', passOptions, settings.passthrough.eac3)} />
  </Group>

  <Group title={t('group_resume')}>
    <Row {...indexed(t('resume_mode'), [t('resume_auto'), t('resume_ask'), t('resume_start')], settings.resume)} />
    <Row {...toggle(t('autoplay_next'), settings.autoplayNext)} />
    {#if settings.autoplayNext.value}
      <Row
        label={t('countdown')}
        value={t('seconds', settings.countdown.value)}
        onclick={() => choose(t('countdown'), SECS.map((s) => t('seconds', s)), Math.max(0, SECS.indexOf(settings.countdown.value)), (i) => (settings.countdown.value = SECS[i]))}
      />
    {/if}
  </Group>

  <Group title={t('group_skip')}>
    <Row {...indexed(t('skip_intro_mode'), skipOptions, settings.skipIntro)} />
    {#if !a.isEmby}
      <Row {...indexed(t('skip_recap'), skipOptions, settings.skipRecap)} />
      <Row {...indexed(t('skip_preview'), skipOptions, settings.skipPreview)} />
      <Row {...indexed(t('skip_commercial'), skipOptions, settings.skipCommercial)} />
    {/if}
  </Group>

  <Group title={t('subtitles')} hint={t('subtitle_hint')}>
    <Row {...indexed(t('subtitle_size'), sizes, settings.subtitleSize)} />
    <Row {...indexed(t('subtitle_style'), styles, settings.subtitleStyle)} />
    <Row {...indexed(t('subtitle_position'), positions, settings.subtitlePosition)} />
    <Row {...toggle(t('subtitle_override_ass'), settings.subtitleOverrideAss)} />
  </Group>

  <Group title={t('group_home')}>
    <Row {...toggle(t('row_hero'), settings.rowHero)} />
    {#if settings.rowHero.value}<Row {...toggle(t('hero_hide_watched'), settings.heroHideWatched)} />{/if}
    <Row {...toggle(t('settings_merge_continue'), settings.mergeContinue)} />
    <Row {...toggle(t('search_episodes'), settings.searchEpisodes)} />
  </Group>

  <Group title={t('settings_appearance')}>
    <Row
      label={t('settings_theme')}
      value={t(THEMES.find(([id]) => id === settings.theme.value)?.[1] ?? 'theme_graphite')}
      onclick={() => choose(t('settings_theme'), THEMES.map(([, k]) => t(k)), Math.max(0, THEMES.findIndex(([id]) => id === settings.theme.value)), (i) => (settings.theme.value = THEMES[i][0]))}
    />
    <Row {...indexed(t('settings_accent'), ACCENTS.map((k) => t(k)), settings.accent)} />
    <Row
      label={t('language')}
      value={t(LANGS.find(([id]) => id === settings.language.value)?.[1] ?? 'language_system')}
      onclick={() => choose(t('language'), LANGS.map(([, k]) => t(k)), Math.max(0, LANGS.findIndex(([id]) => id === settings.language.value)), (i) => (settings.language.value = LANGS[i][0]))}
    />
  </Group>

  {#if !standalone}
    <Group title={t('web_install_title')}><p class="footnote label-2 note">{t('web_install_body')}</p></Group>
  {/if}

  <Group title={t('about')}>
    <Row label={t('version')} value={VERSION} />
  </Group>
</LargeTitlePage>

<style>
  .account {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    padding: 14px 16px;
    line-height: 1.4;
  }
</style>
