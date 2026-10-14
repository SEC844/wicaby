<script lang="ts">
  import { caps, kindLabel } from '../../shared/server-caps';
  import type { BaseItem } from '../../shared/models';
  import { itemKey, itemPath } from '../lib/api';
  import { navigate, router } from '../lib/router.svelte';
  import { downloads, fileSessions, libraries, liveTv, onlineSessions, photoSessions, session, settings, updateSettings } from '../lib/stores.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import { t } from '../lib/i18n.svelte';
  import Logo from './Logo.svelte';
  import { immich, watchImmichSources } from '../lib/photos/immich.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';

  const collapsed = $derived(settings.value?.ui.sidebarCollapsed ?? false);
  const offline = $derived(session.value.status === 'offline');
  const route = $derived(router.route);
  const activeDownloads = $derived(downloads.list.filter((d) => d.status === 'downloading' || d.status === 'queued').length);
  const server = $derived(session.value.server);
  // Live TV gets its own entry below the libraries instead of a library row.
  const libs = $derived(libraries.list.filter((l) => l.CollectionType !== 'livetv'));
  // Several servers: their libraries under a small heading each. One server: a single "Bibliothèques" group.
  const online = $derived(onlineSessions());
  const groups = $derived(
    online.length > 1
      ? online.map((s) => ({ id: s.server.id, title: s.server.name, kind: kindLabel(s.server.kind), libs: libs.filter((l) => l.ServerId === s.server.id) }))
      : [{ id: '', title: t('shell.sidebar.libraries'), kind: '', libs }],
  );
  // Administration appears only when the user administers at least one signed-in server.
  const isAdmin = $derived(online.some((s) => s.user?.isAdmin && caps(s.server.kind).admin));
  const down = $derived(session.value.sessions.filter((s) => s.status === 'offline' && s.server.kind !== 'files').length);
  // File sources: one entry each under "Files" (file-sources-spec §9.1); hidden when there is none.
  const sources = $derived(fileSessions());
  const sourceIcon = (p?: string): IconName => (p === 'webdav' ? 'globe' : p === 'smb' ? 'server' : 'folder');
  // Photo sources: a folder, SMB or WebDAV photo library, then each Immich source (photos spec PH-12), each its own
  // library under "Photos", hidden when there is none.
  const photoSources = $derived(photoSessions());
  const immichShown = $derived(offline ? [] : immich.sources);
  watchImmichSources();

  const NAV: { path: string; name: string; labelKey: string; icon: IconName; online: boolean }[] = [
    { path: '/home', name: 'home', labelKey: 'shell.nav.home', icon: 'home', online: true },
    { path: '/search', name: 'search', labelKey: 'shell.nav.search', icon: 'search', online: true },
    { path: '/favorites', name: 'favorites', labelKey: 'shell.nav.favorites', icon: 'heart', online: true },
    { path: '/downloads', name: 'downloads', labelKey: 'shell.nav.downloads', icon: 'download', online: false },
  ];

  function libraryIcon(type?: string): IconName {
    switch (type) {
      case 'movies':
        return 'film'; // i18n-ignore (icon name)
      case 'tvshows':
        return 'tv';
      case 'music':
        return 'music';
      case 'books':
        return 'book';
      case 'boxsets':
        return 'collection';
      case 'livetv':
        return 'live';
      case 'photos':
      case 'homevideos':
        return 'images';
      default:
        return 'folder';
    }
  }

  const isActive = (name: string, lib?: BaseItem) =>
    route.name === name && (!lib || (route.params.id === lib.Id && (!route.params.server || route.params.server === lib.ServerId)));

  function toggle() {
    void updateSettings({ ui: { sidebarCollapsed: !collapsed } });
  }
</script>

<nav class="sidebar" class:collapsed aria-label={t('shell.nav.aria')}>
  <div class="top drag">
    <button class="toggle no-drag" onclick={toggle} aria-label={collapsed ? t('shell.sidebar.show') : t('shell.sidebar.hide')} title={collapsed ? t('shell.sidebar.show') : t('shell.sidebar.hide')}>
      <Icon name="sidebar" size={18} />
    </button>
    <span class="word fades"><Logo size={18} mono />Wicaby</span>
  </div>

  <div class="scroll">
    <div class="list">

      <ul class="group">
        {#each NAV as item (item.path)}
          {@const disabled = offline && item.online}
          <li>
            <button class="link" class:active={isActive(item.name)} {disabled} onclick={() => navigate(item.path)} title={collapsed ? t(item.labelKey) : undefined}>
              <span class="glyph">
                <Icon name={item.icon} size={18} />
                {#if item.name === 'downloads' && activeDownloads > 0}<span class="dot-badge" class:show={collapsed}></span>{/if}
              </span>
              <span class="label fades">{t(item.labelKey)}</span>
              {#if item.name === 'downloads' && activeDownloads > 0}
                <span class="badge tabular fades">{activeDownloads}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>

      {#if (libs.length > 0 || liveTv.available) && !offline}
        {#each groups as g, gi (g.id)}
        <div class="section fades" title={g.kind ? `${g.title} · ${g.kind}` : undefined}>
          {g.title}{#if g.kind}<span class="kind">{g.kind}</span>{/if}
        </div>
        <ul class="group">
          {#each g.libs as lib, i (itemKey(lib))}
            <li style:--i={Math.min(i, 12)}>
              <button class="link" class:active={isActive('library', lib)} onclick={() => navigate(itemPath(lib, 'library'))} title={collapsed ? lib.Name : undefined}>
                <span class="glyph"><Icon name={libraryIcon(lib.CollectionType)} size={18} /></span>
                <span class="label fades">{lib.Name}</span>
              </button>
            </li>
          {/each}
          {#if liveTv.available && gi === groups.length - 1}
            <li>
              <button class="link" class:active={isActive('livetv')} onclick={() => navigate('/livetv')} title={collapsed ? t('shell.nav.liveTv') : undefined}>
                <span class="glyph"><Icon name="live" size={18} /></span>
                <span class="label fades">{t('shell.nav.liveTv')}</span>
              </button>
            </li>
          {/if}
        </ul>
        {/each}
      {/if}

      {#if sources.length > 0}
        <div class="section fades">{t('files.section')}</div>
        <ul class="group" data-files>
          {#each sources as s, i (s.server.id)}
            <li style:--i={Math.min(i, 12)}>
              <button
                class="link"
                class:active={route.name === 'files' && route.params.server === s.server.id}
                onclick={() => navigate(`/files/${s.server.id}/p.`)}
                title={collapsed ? s.server.name : s.status === 'offline' ? t('files.manage.offline') : undefined}
              >
                <span class="glyph">
                  <Icon name={sourceIcon(s.server.files?.protocol)} size={18} />
                  {#if s.status === 'offline'}<span class="dot-badge off show" aria-hidden="true"></span>{/if}
                </span>
                <span class="label fades" class:dim={s.status === 'offline'}>{s.server.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if photoSources.length > 0 || immichShown.length > 0}
        <div class="section fades">{t('photos.sources.section')}</div>
        <ul class="group" data-immich>
          {#each photoSources as s, i (s.server.id)}
            <li style:--i={Math.min(i, 12)}>
              <button
                class="link"
                data-photo-source
                class:active={route.name === 'library' && route.params.server === s.server.id}
                onclick={() => navigate(`/library/${s.server.id}/p.`)}
                title={collapsed ? s.server.name : s.status === 'offline' ? t('files.manage.offline') : undefined}
              >
                <span class="glyph">
                  <Icon name="images" size={18} />
                  {#if s.status === 'offline'}<span class="dot-badge off show" aria-hidden="true"></span>{/if}
                </span>
                <span class="label fades" class:dim={s.status === 'offline'}>{s.server.name}</span>
              </button>
            </li>
          {/each}
          {#each immichShown as s, i (s.id)}
            <li style:--i={Math.min(i, 12)}>
              <button class="link" class:active={route.name === 'immich' && route.params.id === s.id} onclick={() => navigate(`/immich/${s.id}`)} title={collapsed ? s.name : undefined}>
                <span class="glyph"><Icon name="images" size={18} /></span>
                <span class="label fades">{s.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <ul class="group end">
        {#if isAdmin && !offline}
          <li>
            <button class="link" class:active={isActive('admin')} onclick={() => navigate('/admin')} title={collapsed ? t('admin.title') : undefined}>
              <span class="glyph"><Icon name="admin" size={18} /></span>
              <span class="label fades">{t('admin.title')}</span>
            </button>
          </li>
        {/if}
        <li>
          <button class="link" class:active={isActive('settings')} onclick={() => navigate('/settings')} title={collapsed ? t('shell.nav.settings') : undefined}>
            <span class="glyph"><Icon name="settings" size={18} /></span>
            <span class="label fades">{t('shell.nav.settings')}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>

  {#if online.length > 1}
    <ConnectionStatus>
      <span class="server-text fades">
        <span class="server-name">{t('shell.sidebar.servers', { count: online.length })}</span>
        <span class="server-sub">{down > 0 ? t('shell.sidebar.someOffline', { count: down }) : t('shell.sidebar.allConnected')}</span>
      </span>
    </ConnectionStatus>
  {:else if server}
    <ConnectionStatus>
      <span class="server-text fades">
        <span class="server-name">{server.name}</span>
        <span class="server-sub">{t('shell.sidebar.serverState', { kind: kindLabel(server.kind, t('files.kind')), state: offline ? 'offline' : 'online' })}</span>
      </span>
    </ConnectionStatus>
  {/if}
</nav>

<style>
  /* The sidebar keeps its full width at all times; when collapsed, the content
     pane slides over it and only the icon column stays visible. */
  .sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--sidebar);
    display: flex;
    flex-direction: column;
  }
  .fades {
    transition: opacity var(--t-med) var(--ease);
  }
  .collapsed .fades {
    opacity: 0;
    transition-duration: var(--t-fast);
  }

  .top {
    height: var(--titlebar);
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 0 0 16px;
  }
  .toggle {
    display: grid;
    place-items: center;
    width: 40px;
    height: 32px;
    border-radius: var(--r-sm);
    color: var(--label-2);
  }
  .toggle:is(:hover, :focus-visible) {
    background: var(--fill-1);
    color: var(--label);
  }
  .toggle:active {
    background: var(--fill-2);
  }
  .word {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: var(--fs-headline);
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--label);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .collapsed .scroll {
    scrollbar-width: none;
  }
  .list {
    position: relative;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    padding: 6px 12px 10px;
  }
  .group {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group.end {
    margin-top: auto;
    padding-top: 16px;
  }
  .section {
    padding: 18px 12px 6px;
    font-size: var(--fs-caption);
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kind {
    margin-left: 6px;
    font-weight: 400;
  }

  .link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 36px;
    padding: 0 10px 0 4px;
    border-radius: var(--r-sm);
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }
  /* Hover and selection switch instantly: the user dislikes any fade on these rows. */
  .link:is(:hover, :focus-visible) {
    background: var(--fill-1);
    color: var(--label);
  }
  /* Source-list selection, macOS style: a flat, static fill. The icon follows
     the label colour (monochrome), nothing moves or glows. */
  .link.active {
    color: var(--label);
    background: var(--fill-2);
  }
  .collapsed .link {
    width: 48px;
  }
  .link:disabled {
    opacity: 0.35;
    pointer-events: none;
  }
  .glyph {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    flex: none;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--fill-3);
    color: var(--label);
    font-size: var(--fs-caption);
    font-weight: 650;
    display: grid;
    place-items: center;
  }
  .dot-badge {
    position: absolute;
    top: -1px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--label);
    box-shadow: 0 0 0 2px var(--bg-elevated);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .dot-badge.show {
    opacity: 1;
  }
  .dot-badge.off {
    background: var(--label-3);
  }
  .dim {
    color: var(--label-3);
  }

  .server-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .server-name {
    font-size: var(--fs-footnote);
    font-weight: 560;
    color: var(--label-2);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .server-sub {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
</style>
