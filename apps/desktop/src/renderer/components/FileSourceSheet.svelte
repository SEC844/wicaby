<script lang="ts">
  // "Add a file source" (file-sources-spec §6.1, §7.3): a folder from the OS picker, a WebDAV folder or an SMB
  // share (UNC, Windows). Test lists the root once; an untrusted certificate is shown with its fingerprint and
  // trusted for this source only on an explicit click. Passwords go to main and never come back. With `photos` it
  // adds a photo source (Settings > Photo sources), starting on `initial`: the same form, an indexed photo library.
  import type { FileDiscovered, FileProtocol, FileSourceInput, FileTestResult } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import FileCertCard from './FileCertCard.svelte';
  import Icon from './Icon.svelte';
  import Segmented from './Segmented.svelte';
  import Sheet from './Sheet.svelte';

  let {
    open,
    onclose,
    photos = false,
    initial = 'local',
    onback,
  }: {
    open: boolean;
    onclose: () => void;
    photos?: boolean;
    initial?: FileProtocol;
    // Opened from a step of another sheet (Sources › Add): a back chevron returns to it.
    onback?: () => void;
  } = $props();

  let protocol = $state<FileProtocol>('local');
  let folder = $state('');
  let url = $state('');
  let name = $state('');
  let user = $state('');
  let pass = $state('');
  let insecure = $state(false);
  let pin = $state('');
  let result = $state<FileTestResult | null>(null);
  let busy = $state<'test' | 'add' | null>(null);
  let found = $state<FileDiscovered[] | null>(null);
  let finding = $state(false);

  const CHOICES: FileProtocol[] = ['local', 'webdav', 'smb'];
  // What is missing, under the form: Add stays live and says why instead of greying out.
  let error = $state('');
  const plainHttp = $derived(protocol === 'webdav' && /^(http|dav|webdav):\/\//i.test(url.trim()));
  const ready = $derived(protocol === 'local' ? Boolean(folder) : Boolean(url.trim()) && !(protocol === 'smb' && linux));

  function input(): FileSourceInput {
    return {
      protocol,
      url: protocol === 'local' ? folder : url.trim(),
      name: name.trim() || undefined,
      ...(protocol === 'webdav' && user ? { user, pass } : {}),
      ...(pin ? { pin } : {}),
      ...(plainHttp ? { insecure } : {}),
      ...(photos ? { photos: true } : {}),
    };
  }

  // Any change after a test makes its answer (and a trusted fingerprint) stale.
  function changed(): void {
    result = null;
    pin = '';
    error = '';
  }

  function pick(p: FileProtocol): void {
    protocol = p;
    changed();
  }

  $effect(() => {
    if (open) pick(initial);
  });

  async function chooseFolder(): Promise<void> {
    const dir = await w.files.pickFolder().catch((err) => (toast('error', errorMessage(err)), null));
    if (!dir) return;
    folder = dir;
    changed();
  }

  async function test(): Promise<FileTestResult | null> {
    busy = 'test';
    try {
      result = await w.files.test(input());
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
    return result;
  }

  function trust(): void {
    if (!result?.cert) return;
    pin = result.cert.sha256;
    void test();
  }

  async function add(): Promise<void> {
    if (!ready) {
      error = t(protocol === 'local' ? 'files.add.noFolder' : protocol === 'smb' && linux ? 'files.add.smbLinux' : 'files.add.urlRequired');
      return;
    }
    // Add tests first when nothing was tested yet; a failed test shows its answer and stops here.
    if (result?.code !== 'ok' && (await test())?.code !== 'ok') return;
    busy = 'add';
    try {
      const info = await w.files.add(input());
      toast('success', t('files.add.added'));
      close();
      // A photo source stays in Settings, where its first scan shows its progress.
      if (!photos) navigate(`/files/${info.id}/p.`);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  // "Find on this network" (mDNS, §6.2): one query, 2.5 s of answers.
  async function find(): Promise<void> {
    finding = true;
    try {
      found = await w.files.discover();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      finding = false;
    }
  }

  // A reply only fills the form: nothing connects until Test.
  function use(s: FileDiscovered): void {
    protocol = s.protocol;
    url = s.url;
    if (s.user) user = s.user;
    if (!name.trim()) name = s.name;
    changed();
  }

  function close(): void {
    found = null;
    folder = url = name = user = pass = pin = '';
    insecure = false;
    result = null;
    error = '';
    onclose();
  }

  // Back to the sheet this one was opened from (Sources › Add).
  function back(): void {
    close();
    onback?.();
  }

  const message = $derived(
    !result ? '' : result.code === 'ok' ? t('files.add.ok', { count: result.count ?? 0 }) : t(`files.error.${result.code}`),
  );
</script>

<Sheet {open} onclose={close} label={t(photos ? 'photos.sources.addTitle' : 'files.add.title')} width={560} align="top" onback={onback && back}>
  <div class="body">
    <header class="sheet-head">
      {#if onback}
        <button type="button" class="icon-btn" onclick={back} aria-label={t('common.actions.back')} title={t('common.actions.back')}>
          <Icon name="chevronLeft" size={18} />
        </button>
      {/if}
      <h2 class="title-3">{t(photos ? 'photos.sources.addTitle' : 'files.add.title')}</h2>
    </header>
    <p class="blurb">{t(photos ? 'photos.sources.addBlurb' : 'files.add.blurb')}</p>

    <div class="choices">
      <Segmented value={protocol} options={CHOICES.map((id) => ({ value: id, label: t(`files.add.protocolShort.${id}`) }))} onchange={pick} label={t('files.add.title')} />
    </div>

    <div class="form">
      {#if protocol === 'local'}
        <span class="field-label">{t('files.add.folder')}</span>
        <div class="line">
          <span class="path" class:none={!folder}>{folder || t('files.add.noFolder')}</span>
          <button type="button" class="btn" data-autofocus onclick={chooseFolder}><Icon name="folderOpen" size={15} /> {t('files.add.pick')}</button>
        </div>
        {#if error}<p class="error" id="file-error" role="alert">{error}</p>{/if}
      {:else}
        <label class="field-label" for="file-url">{t('files.add.url')}</label>
        <input
          id="file-url"
          class="field"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder={t(protocol === 'smb' ? 'files.add.urlSmb' : 'files.add.urlWebdav')}
          bind:value={url}
          oninput={changed}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'file-error' : undefined}
          data-autofocus
        />
        {#if error}<p class="error" id="file-error" role="alert">{error}</p>{/if}
        <div class="find" data-files-find>
          <button type="button" class="btn ghost" disabled={finding} onclick={find}><Icon name="search" size={14} /> {t(finding ? 'files.mdns.searching' : 'files.mdns.find')}</button>
          {#if found}
            {#each found as s (s.url)}
              <button type="button" class="chip" title={s.url} onclick={() => use(s)}>{s.name}</button>
            {:else}
              <span class="hint">{t('files.mdns.none')}</span>
            {/each}
          {/if}
        </div>
        {#if found && protocol === 'smb'}<p class="hint">{t('files.mdns.windows')}</p>{/if}
        {#if protocol === 'webdav'}
          <label class="field-label" for="file-user">{t('files.add.user')}</label>
          <input id="file-user" class="field" type="text" spellcheck="false" autocomplete="off" bind:value={user} oninput={changed} />
          <label class="field-label" for="file-pass">{t('files.add.pass')}</label>
          <input id="file-pass" class="field" type="password" autocomplete="off" bind:value={pass} oninput={changed} />
          {#if plainHttp}
            <label class="check"><input type="checkbox" bind:checked={insecure} onchange={changed} /> {t('files.add.insecure')}</label>
          {/if}
        {:else}
          <p class="hint">{t(linux ? 'files.add.smbLinux' : 'files.add.smbHint')}</p>
        {/if}
      {/if}
      <label class="field-label" for="file-name">{t('files.add.name')}</label>
      <input id="file-name" class="field" type="text" autocomplete="off" placeholder={t('files.add.namePlaceholder')} bind:value={name} />
    </div>

    {#if result}
      <div class="result" class:ok={result.code === 'ok'} role="status">
        <Icon name={result.code === 'ok' ? 'check' : 'exclamation'} size={15} />
        <span>{message}</span>
      </div>
    {/if}

    {#if result?.cert && !pin}
      <FileCertCard cert={result.cert} changed={result.code === 'certChanged'} ontrust={trust} />
    {/if}

    <div class="actions">
      <button type="button" class="btn" disabled={!ready || busy !== null} onclick={test}>{busy === 'test' ? t('files.add.testing') : t('files.add.test')}</button>
      <button type="button" class="btn primary" disabled={busy !== null} onclick={add}>{t('files.add.save')}</button>
    </div>
  </div>
</Sheet>

<style>
  /* The Sources sheets' anatomy (routes/Servers.svelte): title level with the close button, labels above fields. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 13px 24px 24px;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding-right: 40px;
  }
  .sheet-head .title-3 {
    margin: 0;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-left: -8px;
    flex: none;
    border-radius: 50%;
    color: var(--label-2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .blurb {
    margin: -8px 0 0;
    color: var(--label-2);
    font-size: var(--fs-callout);
    line-height: 1.5;
  }
  /* One accent per view: the selected segment is neutral, the primary keeps the accent. */
  .choices {
    display: flex;
  }
  .choices :global(.seg .thumb) {
    background: var(--fill-3);
  }
  .choices :global(.seg button.on) {
    color: var(--label);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field-label {
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .field-label:not(:first-child) {
    margin-top: 8px;
  }
  .field[aria-invalid='true'] {
    border-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }
  .error {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
  }
  .path.none {
    color: var(--label-2);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .find {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .find .btn {
    height: 28px;
    margin-left: -12px;
    padding: 0 12px;
    color: var(--label-2);
    font-size: var(--fs-footnote);
  }
  .find .btn:is(:hover, :focus-visible) {
    color: var(--label);
  }
  .chip {
    max-width: 100%;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
    font-size: var(--fs-footnote);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:hover,
  .chip:focus-visible {
    background: var(--fill-3);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    line-height: 1.5;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .result.ok {
    color: var(--label);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .actions .btn {
    min-width: 96px;
  }
</style>
