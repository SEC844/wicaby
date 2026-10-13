<script lang="ts">
  // Folder picker over the SERVER's file system (/Environment/*): drives, then
  // folders, plus SMB computers and shares on Emby. Nothing here touches this PC.
  import Icon from '../../components/Icon.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage } from '../../lib/stores.svelte';
  import type { FsEntry, LibraryAdmin } from './libraryAdmin';

  let {
    open,
    admin,
    serverName,
    onpick,
    onclose,
  }: { open: boolean; admin: LibraryAdmin; serverName: string; onpick: (path: string) => void; onclose: () => void } = $props();

  // '' = the root (drives and network computers).
  let path = $state('');
  let entries = $state<FsEntry[]>([]);
  let network = $state<FsEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let typed = $state('');
  let seq = 0;

  const isComputer = (p: string) => /^\\\\[^\\]+\\?$/.test(p);

  async function load(next: string): Promise<void> {
    const my = ++seq;
    loading = true;
    error = '';
    try {
      let list: FsEntry[];
      let net: FsEntry[] = [];
      if (!next) {
        [list, net] = await Promise.all([admin.drives(), admin.networkDevices().catch(() => [] as FsEntry[])]);
      } else if (isComputer(next) && admin.kind() === 'emby') list = await admin.networkShares(next.replace(/\\$/, ''));
      else list = await admin.directory(next);
      if (my !== seq) return;
      entries = (list ?? []).filter((e) => e.Type !== 'File');
      network = net ?? [];
      path = next;
      typed = next;
    } catch (err) {
      if (my === seq) error = errorMessage(err);
    } finally {
      if (my === seq) loading = false;
    }
  }

  // Parent without a round trip: "D:\Media" -> "D:\", "D:\" -> root,
  // "\\NAS\media" -> "\\NAS", "/srv/media" -> "/srv", "/" -> root.
  function parentOf(p: string): string {
    if (!p || p === '/' || /^[A-Za-z]:\\?$/.test(p) || isComputer(p)) return '';
    const sep = p.includes('\\') ? '\\' : '/';
    const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
    const i = trimmed.lastIndexOf(sep);
    if (i <= 0) return sep === '/' ? '/' : '';
    const up = trimmed.slice(0, i);
    if (/^[A-Za-z]:$/.test(up)) return `${up}\\`;
    return up === '\\' ? '' : up;
  }

  $effect(() => {
    if (open) void load('');
  });

  const crumbs = $derived.by(() => {
    if (!path) return [] as { label: string; path: string }[];
    const out: { label: string; path: string }[] = [];
    let p = path;
    while (p) {
      const up = parentOf(p);
      const label = p.slice(up.length).replace(/^[\\/]+|[\\/]+$/g, '') || p;
      out.unshift({ label, path: p });
      if (up === p) break;
      p = up;
    }
    return out;
  });

  function icon(e: FsEntry) {
    return e.Type === 'NetworkComputer' ? 'server' : e.Type === 'NetworkShare' ? 'network' : /^[A-Za-z]:\\?$|^\/$/.test(e.Path) ? 'hardDrive' : 'folder';
  }
</script>

<Sheet {open} {onclose} label={t('adminLibraries.browser.title')} width={600}>
  <div class="a-sheet browser">
    <h2>{t('adminLibraries.browser.title')}</h2>
    <p class="where"><Icon name="server" size={14} /> {t('adminLibraries.browser.onServer', { server: serverName })}</p>

    <nav class="crumbs" aria-label={t('adminLibraries.browser.location')}>
      <button type="button" class="crumb" class:on={!path} onclick={() => load('')}>{t('adminLibraries.browser.root')}</button>
      {#each crumbs as c (c.path)}
        <span class="sep" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
        <button type="button" class="crumb mono" class:on={c.path === path} onclick={() => load(c.path)}>{c.label}</button>
      {/each}
    </nav>

    <div class="list" aria-busy={loading}>
      {#if path}
        <button type="button" class="entry up" onclick={() => load(parentOf(path))}>
          <Icon name="arrowUp" size={16} />
          <span class="name">{t('adminLibraries.browser.up')}</span>
        </button>
      {/if}
      {#if error}
        <p class="a-empty">{t('adminLibraries.browser.error')} <span class="caption">{error}</span></p>
      {:else if loading && entries.length === 0}
        <p class="a-empty">{t('common.status.loading')}</p>
      {:else}
        {#each entries as e (e.Path)}
          <button type="button" class="entry" onclick={() => load(e.Path)}>
            <Icon name={icon(e)} size={16} />
            <span class="name">{e.Name || e.Path}</span>
            <span class="chev"><Icon name="chevronRight" size={14} /></span>
          </button>
        {:else}
          <p class="a-empty">{t('adminLibraries.browser.empty')}</p>
        {/each}
        {#if !path && network.length}
          <div class="net-h">{t('adminLibraries.browser.network')}</div>
          {#each network as e (e.Path)}
            <button type="button" class="entry" onclick={() => load(e.Path)}>
              <Icon name="server" size={16} />
              <span class="name">{e.Name || e.Path}</span>
              <span class="chev"><Icon name="chevronRight" size={14} /></span>
            </button>
          {/each}
        {/if}
      {/if}
    </div>

    <label>
      {t('adminLibraries.browser.typed')}
      <input
        class="a-input mono"
        spellcheck="false"
        placeholder={t('adminLibraries.browser.typedPlaceholder')}
        bind:value={typed}
        onkeydown={(e) => {
          if (e.key === 'Enter' && typed.trim()) void load(typed.trim());
        }}
      />
    </label>
    <p class="hint">{t('adminLibraries.browser.hint')}</p>

    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={onclose}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push primary" disabled={!typed.trim() || isComputer(typed.trim())} onclick={() => onpick(typed.trim())}>
        {t('adminLibraries.browser.choose')}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .where {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--label-2);
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
    min-height: 28px;
  }
  .crumb {
    height: 26px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-callout);
    color: var(--label-2);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb:hover,
  .crumb:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .crumb.on {
    color: var(--label);
    font-weight: 500;
  }
  .sep {
    display: grid;
    color: var(--label-3);
  }
  .list {
    height: 300px;
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .entry {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .entry:hover,
  .entry:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .entry .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--label);
  }
  .entry.up .name {
    color: var(--label-2);
  }
  .chev {
    display: grid;
    color: var(--label-3);
  }
  .net-h {
    margin: 10px 10px 4px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .hint {
    margin-top: -6px !important;
    font-size: var(--fs-footnote) !important;
    color: var(--label-3) !important;
  }
</style>
