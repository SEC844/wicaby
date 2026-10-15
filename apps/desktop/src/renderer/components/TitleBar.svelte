<script lang="ts">
  import { kindLabel } from '../../shared/server-caps';
  import { cubicOut } from 'svelte/easing';
  import { appUpdate } from '../lib/app-update.svelte';
  import { w } from '../lib/bridge';
  import { userImageUrl } from '../lib/images';
  import { back, navigate, router } from '../lib/router.svelte';
  import { errorMessage, multiServer, onlineSessions, session, toast } from '../lib/stores.svelte';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';

  let { minimal = false }: { minimal?: boolean } = $props();

  const user = $derived(session.value.user);
  const server = $derived(session.value.server);
  const offline = $derived(session.value.status === 'offline');
  const onSearch = $derived(router.route.name === 'search');
  const displayName = $derived(user?.name ?? server?.userName ?? t('shell.account.guest'));
  // Several servers: the menu manages them on the servers page instead of switching user or server.
  const multi = $derived(multiServer());

  let query = $state('');
  let menuOpen = $state(false);
  let avatarFailed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let menuEl = $state<HTMLDivElement>();
  let triggerEl = $state<HTMLButtonElement>();

  // Keep the box in sync with the search page's query string.
  $effect(() => {
    if (onSearch) query = router.route.query.get('q') ?? '';
  });

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = query.trim();
      const path = q ? `/search?q=${encodeURIComponent(q)}` : '/search';
      navigate(path, { replace: onSearch });
    }, 280);
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      query = '';
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Enter') {
      clearTimeout(timer);
      const q = query.trim();
      navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search', { replace: onSearch });
    }
  }

  function clearSearch() {
    query = '';
    clearTimeout(timer);
    if (onSearch) navigate('/search', { replace: true });
    document.getElementById('titlebar-search')?.focus();
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) queueMicrotask(() => menuEl?.querySelector<HTMLButtonElement>('button')?.focus());
  }

  function closeMenu() {
    menuOpen = false;
    triggerEl?.focus();
  }

  async function run(action: () => Promise<unknown> | void) {
    menuOpen = false;
    try {
      await action();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function onWindowPointer(e: PointerEvent) {
    if (!menuOpen) return;
    const target = e.target as Node;
    if (!menuEl?.contains(target) && !triggerEl?.contains(target)) menuOpen = false;
  }

  function onWindowKey(e: KeyboardEvent) {
    if (menuOpen && e.key === 'Escape') closeMenu();
    // Ctrl+F / Ctrl+K jump to search, like any Windows app.
    if (e.ctrlKey && (e.key === 'f' || e.key === 'k') && !minimal) {
      e.preventDefault();
      document.getElementById('titlebar-search')?.focus();
    }
  }

  // Popover grows out of its trigger, macOS menu style.
  function pop(_node: Element, { duration = 220 }: { duration?: number } = {}) {
    const tempo = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tempo')) || 1;
    return {
      duration: duration * tempo,
      easing: cubicOut,
      css: (p: number) => `opacity: ${p}; transform: translate3d(0, ${(1 - p) * -6}px, 0) scale(${0.94 + 0.06 * p});`,
    };
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKey} />

<header class="titlebar drag" class:minimal>
  {#if !minimal}
    <div class="lead">
      <button class="round no-drag" onclick={() => back()} aria-label={t('common.actions.back')} title={t('common.actions.back')}>
        <Icon name="chevronLeft" size={18} />
      </button>
    </div>

    <label class="search no-drag" class:active={onSearch} class:filled={query.length > 0}>
      <Icon name="search" size={16} />
      <input
        id="titlebar-search"
        type="search"
        placeholder={offline ? t('shell.search.placeholderOffline') : t('shell.search.placeholder')}
        autocomplete="off"
        spellcheck="false"
        bind:value={query}
        oninput={onInput}
        onkeydown={onSearchKey}
        disabled={offline}
      />
      {#if query}
        <button class="clear" type="button" onclick={clearSearch} aria-label={t('shell.search.clear')} tabindex="-1"><Icon name="close" size={10} /></button>
      {:else}
        <kbd>Ctrl K</kbd>
      {/if}
    </label>

    <div class="trail">
      {#if offline}
        <span class="offline no-drag" title={t('shell.titlebar.offlineHint')}>
          <Icon name="wifiOff" size={14} />
          {t('common.status.offline')}
        </span>
      {/if}

      <!-- An available update takes the GitHub link's place: one quiet control, never two. -->
      {#if appUpdate.value?.update}
        <button class="offline no-drag update" onclick={() => void w.updates.open('download')} title={t('shell.update.available', { version: appUpdate.value.update.version })}>
          <Icon name="download" size={14} />
          {t('shell.update.label')}
        </button>
      {:else}
        <button class="round no-drag" onclick={() => void w.updates.open('repo')} aria-label={t('shell.update.github')} title={t('shell.update.github')}>
          <!-- GitHub mark (Lucide ships no brand icons). -->
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
        </button>
      {/if}

      {#if user || server}
        <div class="user no-drag">
          <button class="avatar-btn" bind:this={triggerEl} onclick={toggleMenu} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('shell.account.aria', { name: displayName })} title={displayName}>
            <span class="avatar">
              {#if user && !avatarFailed}
                <img src={userImageUrl(user.id, user.imageTag, 32, server?.id)} alt="" decoding="async" onerror={() => (avatarFailed = true)} />
              {:else}
                <span class="initial">{displayName.slice(0, 1).toUpperCase()}</span>
              {/if}
            </span>
          </button>

          {#if menuOpen}
            <div class="menu material" role="menu" bind:this={menuEl} transition:pop>
              <div class="menu-head">
                <span class="avatar big">
                  {#if user && !avatarFailed}
                    <img src={userImageUrl(user.id, user.imageTag, 44, server?.id)} alt="" />
                  {:else}
                    <span class="initial">{displayName.slice(0, 1).toUpperCase()}</span>
                  {/if}
                </span>
                <span class="who">
                  <span class="headline">{displayName}</span>
                  <span class="caption">
                    {#if multi}{t('shell.account.servers', { count: onlineSessions().length })}{:else}{server?.name ?? t('shell.account.server')} · {kindLabel(server?.kind, t('files.kind'))}{/if}
                  </span>
                </span>
              </div>
              <div class="sep"></div>
              {#if !offline}
                <button role="menuitem" onclick={() => run(() => navigate('/history'))}>
                  <Icon name="clock" size={16} /> {t('shell.account.menu.history')}
                </button>
              {/if}
              <button role="menuitem" onclick={() => run(() => navigate('/settings'))}>
                <Icon name="settings" size={16} /> {t('shell.nav.settings')}
              </button>
              <button role="menuitem" onclick={() => run(() => navigate('/welcome?rerun=1'))}>
                <Icon name="sparkles" size={16} /> {t('shell.account.menu.setup')}
              </button>
              {#if multi}
                <button role="menuitem" onclick={() => run(() => navigate('/servers'))}>
                  <Icon name="server" size={16} /> {t('shell.account.menu.servers')}
                </button>
              {:else}
                {#if !offline}
                  <button role="menuitem" onclick={() => run(() => w.session.logout())}>
                    <Icon name="user" size={16} /> {t('shell.account.menu.switchUser')}
                  </button>
                {/if}
                <button role="menuitem" onclick={() => run(() => w.session.disconnect())}>
                  <Icon name="server" size={16} /> {t('shell.account.menu.switchServer')}
                </button>
              {/if}
              <div class="sep"></div>
              <button role="menuitem" onclick={() => run(() => w.app.quit())}>
                <Icon name="power" size={16} /> {t('shell.account.menu.quit')}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</header>

<style>
  .titlebar {
    position: relative;
    z-index: 50;
    height: var(--titlebar);
    flex: none;
    display: grid;
    grid-template-columns: 1fr minmax(0, auto) 1fr;
    align-items: center;
    gap: 12px;
    padding: 0 var(--caption-buttons) 0 12px;
  }
  .titlebar.minimal {
    display: block;
  }
  .lead,
  .trail {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .trail {
    justify-content: flex-end;
  }

  /* Even box around an even glyph: the chevron lands on whole pixels. */
  .round {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--label-2);
    transition:
      background-color calc(100ms * var(--tempo)) linear,
      color calc(100ms * var(--tempo)) linear;
  }
  .round:is(:hover, :focus-visible) {
    background: var(--fill-1);
    color: var(--label);
  }
  .round:active {
    background: var(--fill-2);
  }

  /* Apple TV app style: a centred pill, quiet until focused. */
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(460px, 42vw);
    height: 32px;
    padding: 0 6px 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-3);
    cursor: text;
    transition:
      background-color calc(100ms * var(--tempo)) linear,
      color calc(100ms * var(--tempo)) linear;
  }
  .search:hover {
    background: var(--fill-3);
  }
  .search:focus-within {
    background: var(--fill-3);
    color: var(--label-2);
    box-shadow: var(--focus-ring);
  }
  .search.active,
  .search.filled {
    color: var(--label-2);
  }
  .search:has(input:disabled) {
    opacity: 0.55;
    cursor: default;
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    font-size: var(--fs-callout);
    color: var(--label);
    user-select: text;
  }
  .search input::placeholder {
    color: var(--label-3);
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input:focus-visible {
    box-shadow: none;
  }
  kbd {
    font-family: var(--font-sans);
    font-size: 10.5px;
    font-weight: 560;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-3);
    transition: opacity var(--t-fast) var(--ease);
  }
  .search:focus-within kbd {
    opacity: 0;
  }
  .clear {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-right: 2px;
    border-radius: 50%;
    background: var(--fill-4);
    color: var(--bg);
  }
  .clear:hover {
    background: var(--label-3);
  }

  .offline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 11px 0 9px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-2);
    font-size: var(--fs-footnote);
    font-weight: 600;
    white-space: nowrap;
  }

  .user {
    position: relative;
  }
  .update {
    color: var(--label);
  }
  .update:is(:hover, :focus-visible) {
    background: var(--fill-3);
  }
  .avatar-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    transition: transform var(--t-med) var(--spring);
  }
  .avatar-btn:hover .avatar,
  .avatar-btn[aria-expanded='true'] .avatar {
    box-shadow: 0 0 0 2px var(--fill-4);
  }
  .avatar-btn:active {
    transform: scale(0.92);
    transition-duration: 80ms;
  }
  .avatar-btn:focus-visible {
    border-radius: 50%;
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    flex: none;
    background: linear-gradient(160deg, var(--graphite), #4a4a4f);
    transition: box-shadow var(--t-fast) var(--ease);
  }
  .avatar.big {
    width: 40px;
    height: 40px;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .initial {
    font-weight: 650;
    font-size: 13px;
    color: #fff;
  }
  .avatar.big .initial {
    font-size: 17px;
  }

  .menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 264px;
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    transform-origin: top right;
  }
  .menu-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 10px;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .who > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--r-xs);
    font-size: var(--fs-callout);
    color: var(--label);
    text-align: left;
  }
  .menu button :global(svg) {
    color: var(--label-2);
  }
  /* Neutral highlight, no accent fill: the chrome stays monochrome. */
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--fill-2);
  }
  .menu button:hover :global(svg),
  .menu button:focus-visible :global(svg) {
    color: var(--label);
  }
  .sep {
    height: 1px;
    margin: 5px 10px;
    background: var(--separator);
  }
</style>
