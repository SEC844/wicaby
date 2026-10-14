<script lang="ts">
  // Settings › Library and Home: the file sources (file-sources-spec §9.1), their name and credentials, and
  // "Show file sources on Home" (D10, off by default). Credentials are written, never read back.
  import type { FileSourceInfo, FileTestResult } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage, session, settings, toast, updateSettings } from '../lib/stores.svelte';
  import FileCertCard from './FileCertCard.svelte';
  import FileSourceSheet from './FileSourceSheet.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import Toggle from './Toggle.svelte';

  let sources = $state<FileSourceInfo[]>([]);
  let adding = $state(false);
  let editing = $state<FileSourceInfo | null>(null);
  let removing = $state<FileSourceInfo | null>(null);
  let name = $state('');
  let user = $state('');
  let pass = $state('');
  // The per-source http acknowledgement (spec D9): an imported http address never carries it.
  let insecure = $state(false);
  let busy = $state(false);
  let result = $state<FileTestResult | null>(null);

  async function load(): Promise<void> {
    // Photo sources are listed under Photo sources (ImmichSettings), once connected: an imported one is connected here.
    sources = (await w.files.list().catch(() => [])).filter((s) => !s.photos || s.status === 'pending');
  }

  // The list follows the sessions (a source added, renamed, removed or gone offline).
  $effect(() => {
    void session.value.sessions.filter((s) => s.server.kind === 'files').map((s) => `${s.server.id}:${s.server.name}:${s.status}`).join();
    void load();
  });

  // The scheme stays visible for plain http, so the user sees what the tick is about.
  const shown = (s: FileSourceInfo): string => (s.http ? `http://${s.display}` : s.display);
  const icon = (p: string): IconName => (p === 'webdav' ? 'globe' : p === 'smb' ? 'server' : 'folder');

  function edit(s: FileSourceInfo): void {
    editing = s;
    name = s.name;
    user = pass = '';
    insecure = false;
    result = null;
  }

  async function save(): Promise<void> {
    const s = editing;
    if (!s) return;
    busy = true;
    try {
      if (name.trim() && name.trim() !== s.name) await w.files.rename(s.id, name.trim());
      // A pending (imported) source is contacted here for the first time, by this press. A WebDAV source is
      // re-tested on every Save (empty user: the stored credentials), so a changed certificate reaches the card.
      if (s.status !== 'signed-in' || s.protocol === 'webdav') {
        result = await w.files.setCredentials(s.id, user, pass, undefined, insecure);
        if (result.code !== 'ok') return;
      }
      editing = null;
      await load();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  // The certificate the test just showed, pinned for this source on an explicit click, then the same test again.
  async function trust(): Promise<void> {
    const s = editing;
    if (!s || !result?.cert) return;
    try {
      await w.files.trustCert(s.id, result.cert.sha256);
      result = null;
      await save();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function remove(): Promise<void> {
    const s = removing;
    if (!s) return;
    removing = null;
    try {
      await w.files.remove(s.id);
      toast('success', t('files.manage.removed'));
      await load();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
</script>

<h3 class="gh">{t('files.sources')}</h3>
<div class="group" data-files-settings>
  <div class="row">
    <div class="txt">
      <div class="lbl">{t('files.home.label')}</div>
      <div class="desc">{t('files.home.desc')}</div>
    </div>
    <Toggle label={t('files.home.label')} checked={settings.value?.ui.filesOnHome === true} onchange={(v) => updateSettings({ ui: { filesOnHome: v } })} />
  </div>
  {#each sources as s (s.id)}
    <div class="row">
      <span class="ic"><Icon name={icon(s.protocol)} size={17} /></span>
      <div class="txt">
        <div class="lbl">{s.name}{#if s.status === 'offline'}<span class="off">{t('files.manage.offline')}</span>{:else if s.status === 'pending'}<span class="off">{t('files.manage.pending')}</span>{/if}</div>
        <div class="desc path" title={shown(s)}>{shown(s)}</div>
      </div>
      <button type="button" class="btn ghost" onclick={() => edit(s)}>{t(s.status === 'pending' ? 'files.manage.connect' : 'files.manage.rename')}</button>
      <button type="button" class="btn ghost danger" onclick={() => (removing = s)}>{t('files.manage.remove')}</button>
    </div>
  {:else}
    <div class="row"><div class="desc">{t('files.manage.none')}</div></div>
  {/each}
  <button type="button" class="row add" onclick={() => (adding = true)}>
    <span class="ic"><Icon name="plus" size={16} /></span>
    <span class="lbl">{t('files.add.open')}</span>
  </button>
</div>

<FileSourceSheet open={adding} onclose={() => ((adding = false), void load())} />

<Sheet open={editing !== null} onclose={() => (editing = null)} label={t('files.manage.rename')} width={460}>
  {#if editing}
    <div class="sheet-body">
      <h2 class="title">{editing.name}</h2>
      {#if editing.status === 'pending'}<p class="sub">{t('files.manage.connectDesc', { display: shown(editing) })}</p>{/if}
      <label class="fieldrow">
        <span class="flbl">{t('files.add.name')}</span>
        <input class="field" type="text" autocomplete="off" bind:value={name} data-autofocus />
      </label>
      {#if editing.protocol === 'webdav'}
        <p class="sub">{t('files.manage.credentials')}</p>
        <label class="fieldrow">
          <span class="flbl">{t('files.add.user')}</span>
          <input class="field" type="text" spellcheck="false" autocomplete="off" bind:value={user} />
        </label>
        <label class="fieldrow">
          <span class="flbl">{t('files.add.pass')}</span>
          <input class="field" type="password" autocomplete="off" bind:value={pass} />
        </label>
        {#if editing.http && editing.tls !== 'insecure-http'}
          <label class="check"><input type="checkbox" bind:checked={insecure} /> {t('files.add.insecure')}</label>
        {/if}
      {/if}
      {#if result && result.code !== 'ok'}<p class="err">{t(`files.error.${result.code}`)}</p>{/if}
      {#if result?.cert}<FileCertCard cert={result.cert} changed={result.code === 'certChanged'} ontrust={trust} />{/if}
      <div class="actions">
        <button type="button" class="btn ghost" onclick={() => (editing = null)}>{t('files.add.cancel')}</button>
        <button type="button" class="btn primary" disabled={busy} onclick={save}>{t(editing.status === 'pending' ? 'files.manage.connect' : 'files.manage.save')}</button>
      </div>
    </div>
  {/if}
</Sheet>

<Sheet open={removing !== null} onclose={() => (removing = null)} label={t('files.manage.remove')} width={420}>
  {#if removing}
    <div class="sheet-body">
      <p class="confirm">{t('files.manage.removeConfirm', { name: removing.name })}</p>
      <div class="actions">
        <button type="button" class="btn" data-autofocus onclick={() => (removing = null)}>{t('files.add.cancel')}</button>
        <button type="button" class="btn danger" onclick={remove}>{t('files.manage.remove')}</button>
      </div>
    </div>
  {/if}
</Sheet>

<style>
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
    width: 100%;
    min-height: 58px;
    padding: 12px 18px;
    text-align: left;
    color: var(--label);
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
  .row.add:hover,
  .row.add:focus-visible {
    background: var(--fill-1);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--fill-2);
    color: var(--label-2);
    flex: none;
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
  }
  .off {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    font-weight: 400;
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-body {
    padding: 24px;
  }
  .title {
    margin: 0 40px 14px 0;
    font-size: var(--fs-headline);
  }
  .sub {
    margin: 16px 0 8px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .fieldrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .flbl {
    width: 110px;
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
    margin-top: 10px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .err {
    margin: 12px 0 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .confirm {
    margin: 4px 40px 0 0;
    line-height: 1.5;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
