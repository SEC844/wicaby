<script lang="ts">
  // Settings > Library > "Sources de photos" (photos spec PH-12): connect an Immich server with an API key. The key
  // goes to main once (vault) and never comes back; Test checks the version (2.0 or later) and which permissions
  // the key lacks, each one hiding its feature. Above it, the photo sources on files: a folder on this computer, an
  // SMB share or a WebDAV folder, added with the file sources' own sheet, each with its scan status, Rescan and
  // Remove.
  import type { FileProtocol, FileSourceInfo, ImmichTestResult } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { immich, watchImmichSources } from '../lib/photos/immich.svelte';
  import { forgetViews } from '../lib/photos/source.svelte';
  import { errorMessage, session, toast } from '../lib/stores.svelte';
  import FileSourceSheet from './FileSourceSheet.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  watchImmichSources();

  let folders = $state<FileSourceInfo[]>([]);
  let adding = $state<FileProtocol | null>(null);
  const ADD: { id: FileProtocol; key: string; icon: IconName }[] = [
    { id: 'local', key: 'photos.sources.addFolder', icon: 'folder' },
    { id: 'smb', key: 'photos.sources.addSmb', icon: 'server' },
    { id: 'webdav', key: 'photos.sources.addWebdav', icon: 'globe' },
  ];

  async function loadFolders(): Promise<void> {
    const next = (await w.files.list().catch(() => [])).filter((s) => s.photos && s.status !== 'pending');
    // A scan just finished: the library's views load again on their next visit.
    for (const s of next) if (s.photos?.state === 'ready' && folders.find((o) => o.id === s.id)?.photos?.state === 'scanning') forgetViews(s.id);
    folders = next;
  }
  $effect(() => {
    void session.value.sessions.filter((s) => s.server.files?.photos).map((s) => `${s.server.id}:${s.server.name}:${s.status}`).join();
    void loadFolders();
  });
  // While one scans, its count is read again every second.
  $effect(() => {
    if (!folders.some((s) => s.photos?.state === 'scanning')) return;
    const timer = setInterval(() => void loadFolders(), 1000);
    return () => clearInterval(timer);
  });

  const scanText = (s: FileSourceInfo) =>
    s.photos?.state === 'scanning'
      ? t('photos.sources.indexing', { count: s.photos.count })
      : s.photos?.state === 'error'
        ? t('photos.sources.scanFailed')
        : t('photos.sources.indexed', { count: s.photos?.count ?? 0, date: s.photos?.scannedAt ? fmt.date(s.photos.scannedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '' });

  async function rescan(id: string): Promise<void> {
    await w.files.refresh(id).catch((err) => toast('error', errorMessage(err)));
    await loadFolders();
  }

  async function removeFolder(id: string): Promise<void> {
    try {
      await w.files.remove(id);
      forgetViews(id);
      await loadFolders();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
  let url = $state('');
  let key = $state('');
  let busy = $state(false);
  let result = $state<ImmichTestResult | null>(null);

  async function run(add: boolean): Promise<void> {
    busy = true;
    try {
      const r = add ? await w.photos.immich.add(url, key) : await w.photos.immich.test(url, key);
      result = r;
      if (add && r.ok) {
        key = '';
        url = '';
        toast('success', t('photos.sources.added'));
      }
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  const message = (r: ImmichTestResult) =>
    r.ok
      ? t('photos.sources.ok', { version: r.version ?? '' })
      : r.error === 'version'
        ? t('photos.sources.versionTooOld', { version: r.version ?? '' })
        : t(`photos.sources.error.${r.error ?? 'server'}`);
</script>

<h3 class="gh">{t('photos.sources.title')}</h3>
<div class="group" data-photo-sources>
  {#each folders as s (s.id)}
    <div class="row">
      <span class="ic"><Icon name={s.protocol === 'webdav' ? 'globe' : s.protocol === 'smb' ? 'server' : 'folder'} size={17} /></span>
      <div class="txt">
        <div class="lbl">{s.name}{#if s.status === 'offline'}<span class="off">{t('files.manage.offline')}</span>{/if}</div>
        <div class="desc path" title={s.display}>{s.display}</div>
        <div class="desc" data-scan={s.photos?.state}>{scanText(s)}</div>
      </div>
      <button type="button" class="btn sm" disabled={s.photos?.state === 'scanning'} onclick={() => rescan(s.id)}>{t('photos.sources.rescan')}</button>
      <button type="button" class="btn sm" onclick={() => removeFolder(s.id)}>{t('photos.sources.remove')}</button>
    </div>
  {/each}
  <div class="row adds">
    {#each ADD as a (a.id)}
      <button type="button" class="btn sm" data-add={a.id} onclick={() => (adding = a.id)}><Icon name={a.icon} size={14} /> {t(a.key)}</button>
    {/each}
  </div>
</div>
<FileSourceSheet open={adding !== null} photos initial={adding ?? 'local'} onclose={() => ((adding = null), void loadFolders())} />

<h3 class="gh">Immich</h3>
<div class="group">
  {#each immich.sources as s (s.id)}
    <div class="row">
      <div class="txt">
        <div class="lbl">{s.name}</div>
        <div class="desc">{s.url}</div>
      </div>
      <button type="button" class="btn sm" onclick={() => void w.photos.immich.remove(s.id).catch((err) => toast('error', errorMessage(err)))}>{t('photos.sources.remove')}</button>
    </div>
  {/each}
  <label class="row field-row">
    <span class="lbl">{t('photos.sources.url')}</span>
    <input class="field" type="url" spellcheck="false" autocomplete="off" placeholder="http://photos.local:2283" bind:value={url} />
  </label>
  <label class="row field-row">
    <span class="lbl">{t('photos.sources.key')}</span>
    <input class="field" type="password" autocomplete="off" bind:value={key} />
  </label>
  <div class="row">
    <div class="txt"><div class="desc">{t('photos.sources.keyHint')}</div></div>
    <button type="button" class="btn sm" disabled={busy || !url.trim() || !key.trim()} onclick={() => run(false)}>{t('photos.sources.test')}</button>
    <button type="button" class="btn sm primary" disabled={busy || !url.trim() || !key.trim()} onclick={() => run(true)}>{t('photos.sources.add')}</button>
  </div>
  {#if result}
    <div class="row compact" role="status">
      <div class="txt">
        <div class="desc" class:bad={!result.ok}>{message(result)}</div>
        {#if result.missing.length > 0}<div class="desc">{t('photos.sources.scopesMissing', { scopes: result.missing.join(', ') })}</div>{/if}
      </div>
    </div>
  {/if}
</div>
<p class="foot">{t('photos.sources.foot')}</p>

<style>
  /* Same look as the rows of routes/Settings.svelte. */
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    padding: 12px 18px;
  }
  .row.compact {
    min-height: 46px;
    padding-block: 8px;
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .field-row {
    min-height: 52px;
    padding-block: 8px;
  }
  .field-row .lbl {
    flex: none;
    width: 120px;
  }
  .field-row .field {
    flex: 1;
    height: 34px;
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .desc.bad {
    color: var(--label-2);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    gap: 6px;
    font-size: var(--fs-footnote);
  }
  .adds {
    flex-wrap: wrap;
    gap: 8px;
  }
  .ic {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--fill-1);
    color: var(--label-2);
  }
  .path {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .off {
    margin-left: 8px;
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--label-3);
  }
</style>
