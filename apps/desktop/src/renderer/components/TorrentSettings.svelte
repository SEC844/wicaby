<script lang="ts">
  import { onMount } from 'svelte';
  import type { TorrentCertificate, TorrentLibraryLink, TorrentTestResult } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { itemKey } from '../lib/api';
  import { errorMessage, libraries, multiServer, onlineSessions, serverName, session, settings, toast, updateSettings } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Picker from './Picker.svelte';
  import Toggle from './Toggle.svelte';
  import { t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { vaultNoteKey } from '../lib/vault.svelte';
  import { initTorrents, torrents } from '../lib/torrents.svelte';

  // qBittorrent connection, category → library mapping and options. Used in
  // the Settings "Torrents" pane and in the sheet on the Torrents tab.
  const cfg = $derived(settings.value?.torrents);
  const st = $derived(torrents.value);
  const configured = $derived(Boolean(cfg?.url));

  let url = $state(settings.value?.torrents.url ?? '');
  let username = $state(settings.value?.torrents.username ?? '');
  let password = $state('');
  let busy = $state<'test' | 'save' | null>(null);
  let result = $state<TorrentTestResult | null>(null);

  onMount(initTorrents);

  // "192.168.1.10:8080" is what people copy from qBittorrent's options.
  function normalized(): string {
    const v = url.trim().replace(/\/+$/, '');
    return v && !/^[a-z]+:\/\//i.test(v) ? `http://${v}` : v;
  }

  const dirty = $derived(normalized() !== (cfg?.url ?? '') || username.trim() !== (cfg?.username ?? '') || password !== '');
  const cert = $derived<TorrentCertificate | undefined>(result && !result.ok ? result.certificate : st?.status === 'certificate' ? st.certificate : undefined);

  async function run(kind: 'test' | 'save'): Promise<void> {
    const target = normalized();
    if (!/^https?:\/\/[^\s/]+/i.test(target)) {
      result = { ok: false, error: t('settings.torrents.invalidAddress', { example: 'http://192.168.1.10:8080' }) };
      return;
    }
    busy = kind;
    try {
      const conn = { url: target, username: username.trim(), password: password || undefined };
      result = kind === 'test' ? await w.torrents.test(conn) : await w.torrents.configure(conn);
      if (kind === 'save') {
        url = target;
        password = '';
        if (result.ok) toast('success', t('settings.torrents.connectedToast'));
      }
    } catch (err) {
      result = { ok: false, error: errorMessage(err) };
    } finally {
      busy = null;
    }
  }

  async function trust(c: TorrentCertificate): Promise<void> {
    try {
      await w.torrents.trustCertificate(c.host, c.fingerprint);
      result = null;
      await run(configured && normalized() === cfg?.url ? 'save' : 'test');
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function forget(): Promise<void> {
    await w.torrents.forget();
    url = '';
    username = '';
    password = '';
    result = null;
  }

  // ---- Library mapping (per media server) ----
  // Options are the libraries of every signed-in server (value: itemKey); a link to a
  // server that is not signed in right now is kept as it is.
  const online = $derived(onlineSessions().map((s) => s.server.id));
  const libs = $derived(libraries.list.filter((l) => !['livetv', 'playlists', 'boxsets'].includes(l.CollectionType ?? '')));
  const libOptions = $derived([
    { value: '', label: t('settings.torrents.none') },
    ...libs.map((l) => ({ value: itemKey(l), label: multiServer() ? `${l.Name} · ${serverName(l.ServerId)}` : l.Name })),
  ]);
  const categories = $derived(st?.status === 'online' ? st.categories : []);

  function linkOf(category: string): string {
    const link = cfg?.libraryMap.find((l) => l.category === category && online.includes(l.serverId));
    return link ? itemKey({ Id: link.libraryId, ServerId: link.serverId }) : '';
  }

  function setLink(category: string, key: string): void {
    if (!cfg) return;
    const others = cfg.libraryMap.filter((l) => !(l.category === category && online.includes(l.serverId)));
    const lib = libs.find((l) => itemKey(l) === key);
    const next: TorrentLibraryLink[] = lib?.ServerId ? [...others, { category, serverId: lib.ServerId, libraryId: lib.Id, libraryName: lib.Name }] : others;
    void updateSettings({ torrents: { libraryMap: next } });
  }
</script>

{#if cfg}
  <h3 class="gh first">{t('settings.torrents.connection')}</h3>
  <div class="group">
    <label class="row field-row">
      <span class="lbl">{t('settings.torrents.address')}</span>
      <input class="field" type="url" placeholder="http://192.168.1.10:8080" spellcheck="false" autocomplete="off" bind:value={url} />
    </label>
    <label class="row field-row">
      <span class="lbl">{t('settings.torrents.username')}</span>
      <input class="field" type="text" placeholder="admin" spellcheck="false" autocomplete="off" bind:value={username} />
    </label>
    <label class="row field-row">
      <span class="lbl">{t('settings.torrents.password')}</span>
      <input class="field" type="password" placeholder={configured && normalized() === cfg.url && username.trim() === cfg.username ? t('settings.torrents.saved') : ''} autocomplete="off" bind:value={password} />
    </label>
    <div class="row">
      <div class="txt">
        {#if result?.ok}
          <div class="lbl">{t(result.via === 'mesh' ? 'settings.torrents.connectedMesh' : result.via ? 'settings.torrents.connectedDirect' : 'settings.torrents.connected')}</div>
          <div class="desc">qBittorrent {result.version} · API {result.apiVersion}</div>
        {:else if result}
          <div class="lbl">{t('settings.torrents.failed')}</div>
          <div class="desc">{result.error}</div>
          {#if result.path}<div class="desc">{t(`settings.torrents.path.${result.path}`)}</div>{/if}
        {:else if configured && st?.status === 'online'}
          <div class="lbl">{t('settings.torrents.connected')}</div>
          <div class="desc">qBittorrent {st.version} · API {st.apiVersion}</div>
        {:else if configured && st && st.status !== 'connecting'}
          <div class="lbl">{t('common.status.offline')}</div>
          <div class="desc">{st.error ?? t('settings.torrents.unreachable')}</div>
        {:else}
          <div class="desc">{t('settings.torrents.hint')}</div>
        {/if}
      </div>
      <button type="button" class="btn sm" disabled={busy !== null || !url.trim()} onclick={() => run('test')}>{busy === 'test' ? t('settings.torrents.testing') : t('settings.torrents.test')}</button>
      <button type="button" class="btn sm primary" disabled={busy !== null || !dirty || !url.trim()} onclick={() => run('save')}>{busy === 'save' ? t('settings.torrents.connecting') : t('common.actions.save')}</button>
    </div>
    {#if cert}
      <div class="row cert">
        <span class="ic"><Icon name="lock" size={16} /></span>
        <div class="txt">
          <div class="lbl">{t('settings.torrents.cert.title')}</div>
          <div class="desc">{t(linux ? 'settings.torrents.cert.bodyLinux' : 'settings.torrents.cert.body', { host: cert.host })}</div>
          <details class="caption">
            <summary>{t('settings.torrents.cert.details')}</summary>
            <div>{t('settings.torrents.cert.issuedTo', { subject: cert.subject })}</div>
            <div>{t('settings.torrents.cert.issuedBy', { issuer: cert.issuer })}</div>
            <div class="mono fp">{cert.fingerprint}</div>
          </details>
        </div>
        <button type="button" class="btn sm" onclick={() => trust(cert)}>{t('settings.torrents.cert.accept')}</button>
      </div>
    {/if}
    {#if configured}
      <div class="row compact">
        <div class="lbl soft">{t(vaultNoteKey('settings.torrents.passwordNote', 'settings.torrents.passwordNoteLinux'))}</div>
        <button type="button" class="btn sm ghost" onclick={forget}>{t('settings.torrents.forget')}</button>
      </div>
    {/if}
  </div>

  <h3 class="gh">{t('settings.torrents.libraries')}</h3>
  <div class="group">
    {#if !configured || st?.status !== 'online'}
      <div class="row"><div class="desc">{t('settings.torrents.needQbt')}</div></div>
    {:else if session.value.status !== 'signed-in'}
      <div class="row"><div class="desc">{t('settings.torrents.needServer')}</div></div>
    {:else if categories.length === 0}
      <div class="row"><div class="desc">{t('settings.torrents.noCategories')}</div></div>
    {:else}
      {#each categories as c (c.name)}
        <div class="row compact">
          <div class="txt">
            <div class="lbl">{c.name}</div>
            {#if c.savePath}<div class="desc path" title={c.savePath}>{c.savePath}</div>{/if}
          </div>
          <Picker label={t('settings.torrents.libraryFor', { category: c.name })} value={linkOf(c.name)} options={libOptions} onchange={(v) => setLink(c.name, v)} />
        </div>
      {/each}
    {/if}
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.torrents.scan.label')}</div>
        <div class="desc">{t('settings.torrents.scan.desc')}</div>
      </div>
      <Toggle label={t('settings.torrents.scan.label')} checked={cfg.scanOnComplete} onchange={(v) => updateSettings({ torrents: { scanOnComplete: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.torrents.options')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.torrents.notify.label')}</div>
        <div class="desc">{t(linux ? 'settings.torrents.notify.descLinux' : 'settings.torrents.notify.desc')}</div>
      </div>
      <Toggle label={t('settings.torrents.notify.label')} checked={cfg.notifyOnComplete} onchange={(v) => updateSettings({ torrents: { notifyOnComplete: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.torrents.magnet.label')}</div>
        <div class="desc">{t('settings.torrents.magnet.desc')}</div>
      </div>
      <Toggle label={t('settings.torrents.magnet.label')} checked={cfg.magnetHandler} onchange={(v) => updateSettings({ torrents: { magnetHandler: v } })} />
    </div>
  </div>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .gh.first {
    margin-top: 0;
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
  .lbl.soft {
    flex: 1;
    font-size: var(--fs-footnote);
    font-weight: 400;
    color: var(--label-3);
  }
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .path {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cert {
    align-items: flex-start;
  }
  .ic {
    flex: none;
    display: grid;
    margin-top: 2px;
    color: var(--label-2);
  }
  details {
    margin-top: 6px;
    line-height: 1.6;
  }
  summary {
    color: var(--label-2);
  }
  .fp {
    word-break: break-all;
    user-select: text;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: var(--fs-footnote);
  }
</style>
