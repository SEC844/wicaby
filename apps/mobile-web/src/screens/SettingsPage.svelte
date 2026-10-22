<script lang="ts">
  // One settings category (Android Settings.kt pages), on the TV web app's settings (same keys and defaults). Short
  // choices are chips, every option in view; the look is the theme cards and the accent swatches; switches for the
  // on/off ones.
  import { setLanguage, t } from '$tv/i18n.svelte';
  import { clearCache } from '$tv/load.svelte';
  import { api, prefs, removeExtra } from '$tv/session.svelte';
  import { settings, type Setting } from '$tv/settings.svelte';
  import Avatar from '../components/Avatar.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import AccentPicker from '../components/settings/AccentPicker.svelte';
  import Chips from '../components/settings/Chips.svelte';
  import Group from '../components/settings/Group.svelte';
  import HomeRows from '../components/settings/HomeRows.svelte';
  import Row from '../components/settings/Row.svelte';
  import ThemePicker from '../components/settings/ThemePicker.svelte';
  import { useLoad } from '$tv/load.svelte';
  import type { BaseItem } from '$shared/models';
  import { leave } from '../lib/account';
  import { look, setLook, TEXT_SCALES, systemScale } from '../lib/look.svelte';
  import { VERSION } from '../lib/identity';
  import { nav, type SettingsPageId } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { isAdmin } from '../lib/user.svelte';
  import { standalone } from '../platform';

  let { page }: { page: SettingsPageId } = $props();

  const a = api()!;
  const session = $derived(prefs.session);
  let admin = $state(false);
  void isAdmin(a).then((on) => (admin = on));

  const TITLE: Record<SettingsPageId, string> = {
    general: 'settings_general',
    appearance: 'settings_appearance',
    home: 'settings_home',
    playback: 'settings_playback',
    subtitles: 'subtitles',
    accounts: 'settings_accounts',
    about: 'about',
  };
  const LANGS = ['auto', 'fr', 'en'] as const;
  const MBPS = [0, 120, 80, 60, 40, 20, 10, 8, 4, 2];
  const SECS = [5, 10, 15, 20, 30];
  const HERO_SECS = [0, 5, 8, 12];
  const SEEK_SECS = [10, 15, 30];
  const HIDE_SECS = [3.5, 6, 10];
  const START_TABS = [
    { id: 'home', label: 'tab_home' },
    { id: 'libraries', label: 'nav_libraries' },
    { id: 'downloads', label: 'nav_downloads' },
    { id: 'search', label: 'tab_search' },
  ] as const;

  $effect(() => setLanguage(settings.language.value));

  // A setting stored as the index of its option.
  const chips = (s: Setting<number>) => ({ selected: Math.max(0, s.value), onpick: (i: number) => (s.value = i) });
  const toggle = (label: string, s: Setting<boolean>, sub?: string) => ({ label, sub, checked: s.value, ontoggle: (on: boolean) => (s.value = on) });

  const skipOptions = $derived([t('skip_ask'), t('skip_auto'), t('skip_off')]);
  const passOptions = $derived([t('pass_auto'), t('pass_on'), t('pass_off')]);

  function confirm(title: string, label: string, run: () => void): void {
    showAlert({ title, actions: [{ label, destructive: true, run }, { label: t('cancel'), run: () => {} }] });
  }

  // Text size: the system's, then the fixed sizes; the system's own scale shown in its chip.
  const textOptions = $derived([t('web_text_system', `${Math.round(systemScale() * 100)} %`), t('web_text_xs'), t('web_text_s'), t('web_text_m'), t('web_text_l'), t('web_text_xl')]);
  const textIndex = $derived(look.textSize === 'system' ? 0 : Math.max(0, TEXT_SCALES.indexOf(look.textSize)) + 1);
  // A settings page is pushed for one category and never re-targeted.
  // svelte-ignore state_referenced_locally
  const views = page === 'home' ? useLoad<BaseItem[]>(() => 'views', () => a.views(), { persist: true }) : null;

  const css = getComputedStyle(document.documentElement);
  const inset = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return px;
  })();
  const display = `${window.innerHeight}/${screen.height} · ${css.getPropertyValue('--app-height').trim() || 'auto'} · ${t('web_display_top', Math.round(inset))} · ${standalone ? 'app' : 'web'}`;
</script>

<LargeTitlePage title={t(TITLE[page])} back>
  {#if page === 'general'}
    <Group title={t('settings_language')}>
      <Chips options={[t('language_system'), t('language_fr'), t('language_en')]} selected={Math.max(0, LANGS.indexOf(settings.language.value as (typeof LANGS)[number]))} onpick={(i) => (settings.language.value = LANGS[i])} />
    </Group>
  {:else if page === 'appearance'}
    <Group title={t('settings_theme')}>
      <ThemePicker theme={settings.theme.value} accent={settings.accent.value} onpick={(id) => (settings.theme.value = id)} />
    </Group>
    <Group title={t('settings_accent')}>
      <AccentPicker accent={settings.accent.value} onpick={(i) => (settings.accent.value = i)} />
    </Group>
    <Group title={t('web_text')} hint={t('web_text_hint')}>
      <Chips label={t('web_text_size')} options={textOptions} selected={textIndex} onpick={(i) => setLook('textSize', i === 0 ? 'system' : TEXT_SCALES[i - 1])} />
      <p class="preview">{t('web_text_preview')}</p>
    </Group>
    <Group title={t('web_posters')}>
      <Chips label={t('web_poster_size')} options={[t('web_size_small'), t('web_size_medium'), t('web_size_large')]} selected={look.posterSize} onpick={(i) => setLook('posterSize', i)} />
      <Row label={t('web_poster_titles')} checked={look.posterTitles} ontoggle={(on) => setLook('posterTitles', on)} />
      <Row label={t('web_card_badges')} sub={t('web_card_badges_sub')} checked={look.cardBadges} ontoggle={(on) => setLook('cardBadges', on)} />
      <Row label={t('web_library_art')} sub={t('web_library_art_sub')} checked={look.libraryArt} ontoggle={(on) => setLook('libraryArt', on)} />
    </Group>
    <Group title={t('web_interface')}>
      <Chips label={t('web_start_tab')} options={START_TABS.map((s) => t(s.label))} selected={Math.max(0, START_TABS.findIndex((s) => s.id === look.startTab))} onpick={(i) => setLook('startTab', START_TABS[i].id)} />
      <Row label={t('web_tab_labels')} checked={look.tabLabels} ontoggle={(on) => setLook('tabLabels', on)} />
      <Row label={t('web_reduce_motion')} sub={t('web_reduce_motion_sub')} checked={look.reduceMotion} ontoggle={(on) => setLook('reduceMotion', on)} />
    </Group>
  {:else if page === 'home'}
    <Group title={t('group_home')}>
      <Row {...toggle(t('row_hero'), settings.rowHero)} />
      {#if settings.rowHero.value}<Row {...toggle(t('hero_hide_watched'), settings.heroHideWatched)} />{/if}
      <Row {...toggle(t('settings_merge_continue'), settings.mergeContinue)} />
      <Row label={t('web_continue_large')} sub={t('web_continue_large_sub')} checked={look.continueLarge} ontoggle={(on) => setLook('continueLarge', on)} />
      {#if settings.rowHero.value}
        <Chips label={t('web_hero_rotation')} options={HERO_SECS.map((s) => (s ? t('seconds', s) : t('web_off')))} selected={Math.max(0, HERO_SECS.indexOf(look.heroSeconds))} onpick={(i) => setLook('heroSeconds', HERO_SECS[i])} />
      {/if}
    </Group>
    <Group title={t('web_home_rows')} hint={t('web_home_rows_hint')}>
      <HomeRows views={() => views?.value ?? []} />
    </Group>
    <Group title={t('tab_search')}>
      <Row {...toggle(t('search_episodes'), settings.searchEpisodes)} />
    </Group>
  {:else if page === 'playback'}
    <Group title={t('group_quality')}>
      <Chips
        label={t('settings_bitrate')}
        options={MBPS.map((m) => (m === 0 ? t('settings_bitrate_auto') : t('mbps', m)))}
        selected={Math.max(0, MBPS.indexOf(settings.mbpsEthernet.value))}
        onpick={(i) => (settings.mbpsEthernet.value = MBPS[i])}
      />
    </Group>
    <Group title={t('web_dolby')} hint={t('web_dolby_hint')}>
      <Chips label="Dolby Digital (AC3)" options={passOptions} {...chips(settings.passthrough.ac3)} />
      <Chips label="Dolby Digital Plus (EAC3)" options={passOptions} {...chips(settings.passthrough.eac3)} />
    </Group>
    <Group title={t('web_player_controls')}>
      <Chips label={t('web_seek_step')} options={SEEK_SECS.map((s) => t('seconds', s))} selected={Math.max(0, SEEK_SECS.indexOf(look.seekSeconds))} onpick={(i) => setLook('seekSeconds', SEEK_SECS[i])} />
      <Chips label={t('web_controls_hide')} options={HIDE_SECS.map((s) => t('web_seconds_dec', s.toLocaleString()))} selected={Math.max(0, HIDE_SECS.indexOf(look.controlsSeconds))} onpick={(i) => setLook('controlsSeconds', HIDE_SECS[i])} />
    </Group>
    <Group title={t('group_resume')}>
      <Chips label={t('resume_mode')} options={[t('resume_auto'), t('resume_ask'), t('resume_start')]} {...chips(settings.resume)} />
      <Row {...toggle(t('autoplay_next'), settings.autoplayNext)} />
      {#if settings.autoplayNext.value}
        <Chips
          label={t('countdown')}
          options={SECS.map((s) => t('seconds', s))}
          selected={Math.max(0, SECS.indexOf(settings.countdown.value))}
          onpick={(i) => (settings.countdown.value = SECS[i])}
        />
      {/if}
    </Group>
    <Group title={t('group_skip')}>
      <Chips label={t('skip_intro_mode')} options={skipOptions} {...chips(settings.skipIntro)} />
      {#if !a.isEmby}
        <Chips label={t('skip_recap')} options={skipOptions} {...chips(settings.skipRecap)} />
        <Chips label={t('skip_preview')} options={skipOptions} {...chips(settings.skipPreview)} />
        <Chips label={t('skip_commercial')} options={skipOptions} {...chips(settings.skipCommercial)} />
      {/if}
    </Group>
  {:else if page === 'subtitles'}
    <Group title={t('subtitles')} hint={t('subtitle_hint')}>
      <Chips label={t('subtitle_size')} options={[t('size_small'), t('size_normal'), t('size_large'), t('size_xlarge')]} {...chips(settings.subtitleSize)} />
      <Chips label={t('subtitle_style')} options={[t('style_outline'), t('style_shadow'), t('style_box')]} {...chips(settings.subtitleStyle)} />
      <Chips label={t('subtitle_position')} options={[t('sub_pos_bottom'), t('sub_pos_slightly_raised'), t('sub_pos_raised')]} {...chips(settings.subtitlePosition)} />
      <Row {...toggle(t('subtitle_override_ass'), settings.subtitleOverrideAss)} />
    </Group>
  {:else if page === 'accounts' && session}
    <Group title={t('web_accounts')}>
      <div class="account">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={a} size={56} />
        <span class="who">
          <span class="headline">{session.userName}</span>
          <span class="footnote label-2 ellipsis">{session.server.name} · {session.server.address}</span>
          {#if admin}<span class="chip badge">{t('web_admin_badge')}</span>{/if}
        </span>
      </div>
      <Row label={t('switch_user')} accent onclick={() => leave(false)} />
      <Row label={t('sign_out')} destructive onclick={() => confirm(t('sign_out'), t('sign_out'), () => leave(true))} />
    </Group>
    <Group title={t('other_servers')} hint={t('other_servers_hint')}>
      {#each prefs.extras ?? [] as extra (extra.server.id)}
        <Row label={extra.server.name} sub={extra.userName} onclick={() => confirm(extra.server.name, t('remove_server'), () => (removeExtra(extra.server.id), clearCache()))} />
      {/each}
      <Row label={t('add_server')} accent onclick={() => nav.push({ name: 'servers', add: true })} />
    </Group>
  {:else if page === 'about'}
    {#if !standalone}
      <Group title={t('web_install_title')}><p class="footnote label-2 note">{t('web_install_body')}</p></Group>
    {/if}
    <Group title={t('about')}>
      <Row label={t('version')} value={VERSION} />
      <!-- The heights lib/viewport.ts works with, for a report from the phone. -->
      <Row label={t('web_display')} value={display} />
    </Group>
  {/if}
  <div class="end"></div>
</LargeTitlePage>

<style>
  .preview {
    margin: 0;
    padding: 12px 16px 14px;
    font-size: var(--fs-body);
    line-height: 1.35;
    color: var(--label-2);
  }
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
    align-items: flex-start;
  }
  .ellipsis {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    margin-top: 6px;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);
  }
  .note {
    padding: 14px 16px;
    line-height: 1.4;
  }
  .end {
    height: 32px;
  }
</style>
