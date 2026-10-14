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
  import Icon, { type IconName } from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let { open, onclose, photos = false, initial = 'local' }: { open: boolean; onclose: () => void; photos?: boolean; initial?: FileProtocol } = $props();

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

  const CHOICES: { id: FileProtocol; icon: IconName }[] = [
    { id: 'local', icon: 'folder' },
    { id: 'webdav', icon: 'globe' },
    { id: 'smb', icon: 'server' },
  ];
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

  async function test(): Promise<void> {
    busy = 'test';
    try {
      result = await w.files.test(input());
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  function trust(): void {
    if (!result?.cert) return;
    pin = result.cert.sha256;
    void test();
  }

  async function add(): Promise<void> {
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
    onclose();
  }

  const message = $derived(
    !result ? '' : result.code === 'ok' ? t('files.add.ok', { count: result.count ?? 0 }) : t(`files.error.${result.code}`),
  );
</script>

<Sheet {open} onclose={close} label={t(photos ? 'photos.sources.addTitle' : 'files.add.title')} width={560}>
  <div class="body">
    <h2 class="title">{t(photos ? 'photos.sources.addTitle' : 'files.add.title')}</h2>
    <p class="blurb">{t(photos ? 'photos.sources.addBlurb' : 'files.add.blurb')}</p>

    <div class="choices" role="radiogroup" aria-label={t('files.add.title')}>
      {#each CHOICES as c (c.id)}
        <button type="button" role="radio" class="choice" class:on={protocol === c.id} aria-checked={protocol === c.id} onclick={() => pick(c.id)}>
          <Icon name={c.icon} size={20} />
          <span>{t(`files.add.protocol.${c.id}`)}</span>
        </button>
      {/each}
    </div>

    <div class="form">
      {#if protocol === 'local'}
        <div class="line">
          <span class="path" class:none={!folder}>{folder || t('files.add.noFolder')}</span>
          <button type="button" class="btn" data-autofocus onclick={chooseFolder}><Icon name="folderOpen" size={15} /> {t('files.add.pick')}</button>
        </div>
      {:else}
        <label class="fieldrow">
          <span class="lbl">{t('files.add.url')}</span>
          <input class="field" type="text" spellcheck="false" autocomplete="off" placeholder={t(protocol === 'smb' ? 'files.add.urlSmb' : 'files.add.urlWebdav')} bind:value={url} oninput={changed} />
        </label>
        <div class="find" data-files-find>
          <button type="button" class="btn ghost" disabled={finding} onclick={find}><Icon name="search" size={14} /> {t(finding ? 'files.mdns.searching' : 'files.mdns.find')}</button>
          {#if found}
            {#each found as s (s.url)}
              <button type="button" class="chip" title={s.url} onclick={() => use(s)}><Icon name={s.protocol === 'smb' ? 'server' : 'globe'} size={13} /> {s.name}</button>
            {:else}
              <span class="hint">{t('files.mdns.none')}</span>
            {/each}
          {/if}
        </div>
        {#if found && protocol === 'smb'}<p class="hint">{t('files.mdns.windows')}</p>{/if}
        {#if protocol === 'webdav'}
          <label class="fieldrow">
            <span class="lbl">{t('files.add.user')}</span>
            <input class="field" type="text" spellcheck="false" autocomplete="off" bind:value={user} oninput={changed} />
          </label>
          <label class="fieldrow">
            <span class="lbl">{t('files.add.pass')}</span>
            <input class="field" type="password" autocomplete="off" bind:value={pass} oninput={changed} />
          </label>
          {#if plainHttp}
            <label class="check"><input type="checkbox" bind:checked={insecure} onchange={changed} /> {t('files.add.insecure')}</label>
          {/if}
        {:else}
          <p class="hint">{t(linux ? 'files.add.smbLinux' : 'files.add.smbHint')}</p>
        {/if}
      {/if}
      <label class="fieldrow">
        <span class="lbl">{t('files.add.name')}</span>
        <input class="field" type="text" autocomplete="off" placeholder={t('files.add.namePlaceholder')} bind:value={name} />
      </label>
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
      <button type="button" class="btn ghost" onclick={close}>{t('files.add.cancel')}</button>
      <div class="spacer"></div>
      <button type="button" class="btn" disabled={!ready || busy !== null} onclick={test}>{busy === 'test' ? t('files.add.testing') : t('files.add.test')}</button>
      <button type="button" class="btn primary" disabled={!ready || busy !== null || result?.code !== 'ok'} onclick={add}>{t('files.add.save')}</button>
    </div>
  </div>
</Sheet>

<style>
  .body {
    padding: 26px 26px 22px;
  }
  .title {
    margin: 0 40px 4px 0;
    font-size: var(--fs-headline);
    font-weight: 650;
  }
  .blurb {
    margin: 0 0 18px;
    color: var(--label-2);
    font-size: var(--fs-callout);
    line-height: 1.45;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .choice {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 14px 8px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    color: var(--label-2);
    font-size: var(--fs-footnote);
    font-weight: 560;
    text-align: center;
    box-shadow: inset 0 0 0 1px var(--separator);
    transition: background-color var(--t-fast) var(--ease);
  }
  .choice:hover {
    background: var(--fill-2);
  }
  .choice.on {
    color: var(--label);
    background: var(--fill-3);
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .form {
    display: grid;
    gap: 10px;
    margin-top: 18px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
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
    color: var(--label-3);
  }
  .fieldrow {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .fieldrow .lbl {
    width: 120px;
    flex: none;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .fieldrow .field {
    flex: 1;
    height: 34px;
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
    gap: 6px;
    margin-top: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 4px 10px;
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
    background: var(--fill-1);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    color: var(--label-2);
    font-size: var(--fs-callout);
  }
  .result.ok {
    color: var(--label);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 22px;
  }
  .spacer {
    flex: 1;
  }
</style>
