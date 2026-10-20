<script lang="ts">
  // Android TV SettingsTab (Settings.kt): the section list on the left (focusing a section shows it), its rows on
  // the right. Left from a row goes back to the current section, not the nearest one. The categories and their order
  // are the ones every Wicaby app shares; the TV web app leaves out Sources (no file sources on a TV browser) and
  // Remote Access (no VPN on these TVs). The list scrolls to keep the focused section in view.
  import { focusable, setFocus } from '../lib/focus';
  import type { Api } from '../lib/api';
  import { k, t } from '../lib/i18n.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import AboutSection from './settings/AboutSection.svelte';
  import AccountsSection from './settings/AccountsSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import AudioSection from './settings/AudioSection.svelte';
  import GeneralSection from './settings/GeneralSection.svelte';
  import HomeSection from './settings/HomeSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import SubtitlesSection from './settings/SubtitlesSection.svelte';

  let {
    api,
    views,
    tabs,
    onscrolled,
  }: { api: Api; views: import('$shared/models').BaseItem[]; tabs: import('../lib/tabs').TopTab[]; onscrolled: (s: boolean) => void } = $props();

  const SECTIONS = ['general', 'appearance', 'home', 'playback', 'audio', 'subtitles', 'accounts', 'about'] as const;
  type Section = (typeof SECTIONS)[number];
  const LABELS: Record<Section, string> = {
    general: k('section_general'),
    appearance: k('section_appearance'),
    home: k('section_home'),
    playback: k('section_playback'),
    audio: k('section_audio'),
    subtitles: k('section_subtitles'),
    accounts: k('section_accounts'),
    about: k('section_about'),
  };
  let section = $state<Section>('general');
  let menuY = $state(0);
  let menu: HTMLDivElement;
  let menuList: HTMLDivElement;
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let y = $state(0);

  function show(s: Section): void {
    if (s === section) return;
    section = s;
    y = 0;
    onscrolled(false);
  }

  // The rows scroll only as far as needed (EdgeSpec, 64 dp from the edges).
  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    if (menu.contains(el)) {
      const max = Math.max(0, menuList.offsetHeight - menu.clientHeight);
      menuY = clamp(menuY + edgeDelta(el.offsetTop - menuY, el.offsetHeight, menu.clientHeight, dp(48)), 0, max);
      return;
    }
    if (!content.contains(el)) return;
    const max = Math.max(0, content.offsetHeight - viewport.clientHeight);
    const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top;
    y = clamp(y + edgeDelta(top - y, el.offsetHeight, viewport.clientHeight, dp(64)), 0, max);
    onscrolled(y > 40);
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const el = e.target as HTMLElement;
    if (e.detail === 'left' && content.contains(el)) {
      e.preventDefault();
      setFocus(menu.querySelector<HTMLElement>(`[data-section="${section}"]`));
    }
  }
</script>

<div class="settings" ontvfocus={onfocus} ontvmove={onmove}>
  <div class="menu" bind:this={menu} data-focus-group>
    <div class="menu-list" bind:this={menuList} style="transform:translate3d(0,{-menuY}px,0)">
      <h1 class="t-large-title">{t('tab_settings')}</h1>
      {#each SECTIONS as s (s)}
        <button class="section t-headline" class:selected={s === section} data-section={s} use:focusable ontvfocus={() => show(s)}>
          <span>{t(LABELS[s])}</span>
        </button>
      {/each}
    </div>
  </div>
  <div class="viewport" bind:this={viewport}>
    <div class="content" bind:this={content} style="transform:translate3d(0,{-y}px,0)">
      {#key section}
        <div class="fade">
          {#if section === 'general'}
            <GeneralSection />
          {:else if section === 'appearance'}
            <AppearanceSection />
          {:else if section === 'home'}
            <HomeSection {views} {tabs} />
          {:else if section === 'playback'}
            <PlaybackSection {api} />
          {:else if section === 'audio'}
            <AudioSection {api} />
          {:else if section === 'subtitles'}
            <SubtitlesSection {api} />
          {:else if section === 'accounts'}
            <AccountsSection {api} />
          {:else}
            <AboutSection />
          {/if}
        </div>
      {/key}
    </div>
  </div>
</div>

<style>
  .settings {
    position: absolute;
    top: 100rem;
    left: 64rem;
    right: 64rem;
    bottom: 0;
    display: flex;
  }
  .menu {
    width: 240rem;
    margin-right: 48rem;
    flex-shrink: 0;
    overflow: hidden;
    /* Room for the focused section's lift. */
    padding: 0 6rem;
  }
  .menu-list {
    padding-bottom: 48rem;
    transition: transform var(--t-med) var(--ease);
  }
  h1 {
    margin: 0 0 18rem 16rem;
  }
  .section {
    display: flex;
    width: 100%;
    margin-top: 4rem;
    padding: 12rem 16rem;
    border-radius: var(--r-md);
    color: var(--label-2);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .section.selected {
    background: var(--fill-2);
    color: var(--label);
  }
  .section:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.04);
  }
  .viewport {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    /* Room for the focused rows' lift. */
    padding: 0 8rem;
  }
  .content {
    padding: 66rem 0 64rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .fade {
    animation: in 220ms 60ms var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
</style>
