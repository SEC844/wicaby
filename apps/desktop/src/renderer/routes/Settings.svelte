<script lang="ts" module>
  // Remembered across visits, like System Settings reopening the last pane.
  let lastPane = 'general';
  // Hardware acceleration only changes at the next launch: remember what this run started with.
  let hwAtLaunch: boolean | null = null;
</script>

<script lang="ts">
  // The shell: section navigation and search. Each pane's rows live in settings/<Name>Pane.svelte.
  import { onMount, untrack, type Component } from 'svelte';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import LogoLoader from '../components/LogoLoader.svelte';
  import { locale, t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { navigate, router } from '../lib/router.svelte';
  import { settings } from '../lib/stores.svelte';
  import AboutPane from './settings/AboutPane.svelte';
  import AdvancedPane from './settings/AdvancedPane.svelte';
  import AppearancePane from './settings/AppearancePane.svelte';
  import AudioPane from './settings/AudioPane.svelte';
  import DownloadsPane from './settings/DownloadsPane.svelte';
  import GeneralPane from './settings/GeneralPane.svelte';
  import LibraryPane from './settings/LibraryPane.svelte';
  import PlaybackPane from './settings/PlaybackPane.svelte';
  import PrivacyPane from './settings/PrivacyPane.svelte';
  import RemotePane from './settings/RemotePane.svelte';
  import ServerPane from './settings/ServerPane.svelte';
  import SubtitlesPane from './settings/SubtitlesPane.svelte';
  import { previewAccent, SettingsData } from './settings/shared.svelte';

  // Panes provided by other features; each shows up once its component exists.
  const optional = import.meta.glob<{ default: Component }>(['../components/TorrentSettings.svelte', '../components/WindowsSettings.svelte', '../components/TraktSettings.svelte', '../components/Logo.svelte'], {
    eager: true,
  });
  const pick = (name: string): Component | undefined => optional[`../components/${name}.svelte`]?.default;
  const TorrentSettings = pick('TorrentSettings');
  const WindowsSettings = pick('WindowsSettings');
  const TraktSettings = pick('TraktSettings');
  const Logo = pick('Logo');

  type Pane =
    | 'general'
    | 'appearance'
    | 'playback'
    | 'audio'
    | 'subtitles'
    | 'library'
    | 'downloads'
    | 'torrents'
    | 'server'
    | 'remote'
    | 'accounts'
    | 'windows'
    | 'privacy'
    | 'advanced'
    | 'about';

  // `group` splits the list into quiet clusters separated by space, not lines.
  // Labels and blurbs come from settings.panes.<id>.label / .blurb (see paneLabel).
  const ALL_PANES: { id: Pane; icon: IconName; group: number }[] = [
    { id: 'general', icon: 'settings', group: 0 },
    { id: 'appearance', icon: 'palette', group: 0 },
    { id: 'playback', icon: 'play', group: 1 },
    { id: 'audio', icon: 'volume', group: 1 },
    { id: 'subtitles', icon: 'subtitles', group: 1 },
    { id: 'library', icon: 'grid', group: 2 },
    { id: 'downloads', icon: 'download', group: 2 },
    { id: 'torrents', icon: 'network', group: 2 },
    { id: 'server', icon: 'server', group: 2 },
    { id: 'remote', icon: 'network', group: 2 },
    { id: 'accounts', icon: 'user', group: 2 },
    { id: 'windows', icon: 'bell', group: 3 },
    { id: 'privacy', icon: 'hardDrive', group: 3 },
    { id: 'advanced', icon: 'gauge', group: 3 },
    { id: 'about', icon: 'info', group: 4 },
  ];
  const PANES = ALL_PANES.filter((p) => (p.id !== 'torrents' || TorrentSettings) && (p.id !== 'windows' || WindowsSettings) && (p.id !== 'accounts' || TraktSettings));
  // The "Windows" pane (tray, startup, notifications) is "Desktop" on Linux.
  const paneLabel = (id: Pane) => (linux && id === 'windows' ? t('settings.panes.windows.labelLinux') : t(`settings.panes.${id}.label`));
  const paneBlurb = (id: Pane) => (linux && id === 'windows' ? t('settings.panes.windows.blurbLinux') : t(`settings.panes.${id}.blurb`));

  const s = $derived(settings.value);
  if (hwAtLaunch === null && settings.value) hwAtLaunch = settings.value.system.hardwareAcceleration;
  const hwStart = hwAtLaunch;
  // App info, audio devices and storage, shared with the panes that show them.
  const data = new SettingsData();
  let pane = $state<Pane>(PANES.some((p) => p.id === lastPane) ? (lastPane as Pane) : 'general');
  let query = $state('');
  let paneEl = $state<HTMLDivElement>();
  let noResults = $state(false);

  $effect(() => {
    if ((pane === 'audio' || query) && data.devices === null) void data.loadDevices();
    if ((pane === 'privacy' || query) && data.storage === null) void data.loadStorage();
  });

  function open(id: Pane): void {
    query = '';
    if (id === pane) return;
    pane = id;
    lastPane = id;
    document.getElementById('main-scroller')?.scrollTo({ top: 0 });
  }

  // /settings?pane=<id> opens that pane (the sidebar status popover links here), then drops the query so
  // the same link works again after the user moved to another pane.
  $effect(() => {
    const id = router.route.query.get('pane');
    if (!PANES.some((p) => p.id === id)) return;
    untrack(() => open(id as Pane));
    navigate('/settings', { replace: true });
  });

  // ---- Search: every pane is rendered, then rows whose label and description miss the query are hidden ----
  // Rows are matched on their rendered text, so the search follows the active language.
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  $effect(() => {
    const q = fold(query.trim());
    // Re-run after anything that re-renders rows.
    void locale.current;
    void settings.value;
    void data.devices;
    void data.storage;
    void data.info;
    const root = paneEl;
    if (!root || !q) return;
    let shown = 0;
    for (const sec of root.querySelectorAll<HTMLElement>('.result')) {
      const paneHit = fold(sec.dataset.label ?? '').includes(q);
      for (const row of sec.querySelectorAll<HTMLElement>('.row')) {
        const parts = [...row.querySelectorAll('.lbl, .desc')].map((e) => e.textContent ?? '');
        row.hidden = !paneHit && !fold(parts.length ? parts.join(' ') : (row.textContent ?? '')).includes(q);
      }
      for (const g of sec.querySelectorAll<HTMLElement>('.group')) {
        const visible = g.querySelector('.row:not([hidden])') !== null || (paneHit && !g.querySelector('.row'));
        g.hidden = !visible;
        const head = g.previousElementSibling as HTMLElement | null;
        if (head?.classList.contains('gh')) head.hidden = !visible;
      }
      sec.hidden = !sec.querySelector('.group:not([hidden])');
      if (!sec.hidden) shown++;
    }
    noResults = shown === 0;
  });

  onMount(() => {
    void data.refreshInfo();
    return () => previewAccent(null);
  });
</script>

<div class="page settings fade-in">
  <div class="title-row">
    <h1 class="page-title">{t('settings.page.title')}</h1>
    <label class="search">
      <Icon name="search" size={14} />
      <input
        type="search"
        placeholder={t('settings.page.search')}
        aria-label={t('settings.page.search')}
        bind:value={query}
        onkeydown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation();
            query = '';
          }
        }}
      />
    </label>
  </div>

  {#if !s}
    <div class="loading"><LogoLoader size={64} delay={200} /></div>
  {:else}
    <div class="layout">
      <nav class="cats" aria-label={t('settings.page.categories')}>
        {#each PANES as p, i (p.id)}
          <button
            type="button"
            class:active={!query && pane === p.id}
            class:gap={i > 0 && PANES[i - 1].group !== p.group}
            aria-current={!query && pane === p.id ? 'page' : undefined}
            title={paneLabel(p.id)}
            onclick={() => open(p.id)}
          >
            <span class="cat-icon"><Icon name={p.icon} size={16} /></span>
            <span class="cat-label">{paneLabel(p.id)}</span>
          </button>
        {/each}
      </nav>

      {#if query.trim()}
        <div class="pane searching" bind:this={paneEl}>
          {#each PANES as p (p.id)}
            <section class="result" data-label={paneLabel(p.id)}>
              <button type="button" class="result-head" onclick={() => open(p.id)}>
                {paneLabel(p.id)}<Icon name="chevronRight" size={14} />
              </button>
              {@render body(p.id)}
            </section>
          {/each}
          {#if noResults}
            <p class="empty">{t('settings.page.noResults', { query: query.trim() })}</p>
          {/if}
        </div>
      {:else}
        {#key pane}
          <div class="pane" bind:this={paneEl}>
            <header class="pane-head">
              <h2>{paneLabel(pane)}</h2>
              <p>{paneBlurb(pane)}</p>
            </header>
            {@render body(pane)}
          </div>
        {/key}
      {/if}
    </div>
  {/if}
</div>

{#snippet body(id: Pane)}
  {#if s}
    {#if id === 'general'}
      <GeneralPane {open} />
    {:else if id === 'appearance'}
      <AppearancePane />
    {:else if id === 'playback'}
      <PlaybackPane {data} />
    {:else if id === 'audio'}
      <AudioPane {data} />
    {:else if id === 'subtitles'}
      <SubtitlesPane />
    {:else if id === 'library'}
      <LibraryPane />
    {:else if id === 'downloads'}
      <DownloadsPane />
    {:else if id === 'torrents' && TorrentSettings}
      <TorrentSettings />
    {:else if id === 'server'}
      <ServerPane />
    {:else if id === 'remote'}
      <RemotePane />
    {:else if id === 'accounts' && TraktSettings}
      <TraktSettings />
    {:else if id === 'windows' && WindowsSettings}
      <WindowsSettings />
    {:else if id === 'privacy'}
      <PrivacyPane {data} />
    {:else if id === 'advanced'}
      <AdvancedPane {hwStart} />
    {:else if id === 'about'}
      <AboutPane {data} {Logo} />
    {/if}
  {/if}
{/snippet}

<style>
  .loading {
    display: grid;
    place-items: center;
    height: 420px;
  }
  .layout {
    display: grid;
    grid-template-columns: 236px minmax(0, 660px);
    gap: 48px;
    align-items: start;
  }

  /* ---- Category list: plain, monochrome, no accent ---- */
  .cats {
    position: sticky;
    top: 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .cats button {
    display: flex;
    align-items: center;
    gap: 11px;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body);
    font-weight: 450;
    color: var(--label-2);
    text-align: left;
  }
  .cats button.gap {
    margin-top: 14px;
  }
  /* Like the sidebar: hover fades in, selection switches instantly so two rows never light up at once. */
  .cats button:hover,
  .cats button:focus-visible {
    background: var(--fill-1);
    color: var(--label);
    transition:
      background-color calc(100ms * var(--tempo)) linear,
      color calc(100ms * var(--tempo)) linear;
  }
  .cats button.active {
    background: var(--fill-2);
    color: var(--label);
    font-weight: 500;
    transition: none;
  }
  .cat-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    color: var(--label-3);
    transition: color var(--t-fast) var(--ease);
  }
  .cats button:hover .cat-icon,
  .cats button:focus-visible .cat-icon {
    color: var(--label-2);
  }
  .cats button.active .cat-icon {
    color: var(--label);
  }
  .cat-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 980px) {
    .layout {
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 28px;
    }
    .cats button {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .cat-label {
      display: none;
    }
  }

  /* ---- Pane ---- */
  .pane {
    min-width: 0;
    display: flex;
    flex-direction: column;
    animation: pane-in calc(140ms * var(--tempo)) var(--ease-out) both;
  }
  @keyframes pane-in {
    from {
      opacity: 0;
      transform: translate3d(0, 4px, 0);
    }
  }
  .pane-head {
    margin: 2px 0 22px;
  }
  .pane-head h2 {
    margin: 0;
    font-size: var(--fs-title-3);
    font-weight: 600;
    letter-spacing: -0.014em;
    line-height: 1.25;
  }
  .pane-head p {
    margin: 4px 0 0;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }

  /* ---- Title and search ---- */
  .title-row {
    display: flex;
    align-items: center;
    gap: 24px;
    max-width: 944px;
    margin-bottom: 20px;
  }
  .title-row .page-title {
    margin: 0;
    flex: 1;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(280px, 40%);
    height: 32px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    color: var(--label-3);
    transition: background-color var(--t-fast) var(--ease);
  }
  .search:focus-within {
    background: var(--fill-2);
    color: var(--label-2);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font: inherit;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .search input::placeholder {
    color: var(--label-3);
  }
  .search input::-webkit-search-cancel-button {
    filter: grayscale(1);
  }
  /* Search results: every pane stacked, unmatched rows hidden by the filter. */
  .pane :global([hidden]) {
    display: none !important;
  }
  .result:not([hidden]) ~ .result:not([hidden]) {
    margin-top: 34px;
  }
  .result-head {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 10px 2px;
    font-size: var(--fs-headline);
    font-weight: 600;
    color: var(--label);
  }
  .result-head :global(svg) {
    color: var(--label-3);
  }
  .result-head:hover :global(svg),
  .result-head:focus-visible :global(svg) {
    color: var(--label);
  }
  .result :global(.gh) {
    margin-top: 18px;
  }
  .empty {
    margin: 8px 2px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  @media (max-width: 980px) {
    .search {
      width: 220px;
    }
  }
</style>
