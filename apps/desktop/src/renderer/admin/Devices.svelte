<script lang="ts">
  // Devices: every client that signed in to the server. Rename (custom name),
  // details, and delete, which revokes the device's access token.
  import './users/admin.css';
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import { adminApi, type DeviceInfo } from './users/userAdmin';

  let { serverId }: { serverId: string; kind?: ServerKind } = $props();

  const api = $derived(adminApi(serverId));
  let devices = $state<DeviceInfo[] | null>(null);
  let error = $state('');
  let ownId = $state('');
  let userFilter = $state('');

  async function load(): Promise<void> {
    try {
      const list = await api.devices();
      devices = list.sort((a, b) => (b.DateLastActivity ?? '').localeCompare(a.DateLastActivity ?? ''));
      error = '';
    } catch (err) {
      error = errorMessage(err);
      devices ??= [];
    }
  }

  onMount(() => {
    void load();
    void w.app.info().then((i) => (ownId = i.deviceId), () => undefined);
  });

  // The device this app is running as: deleting it would sign Wicaby out.
  const isOwn = (d: DeviceInfo) => Boolean(ownId) && (d.ReportedDeviceId ?? d.Id) === ownId;
  const display = (d: DeviceInfo) => d.CustomName || d.Name || t('adminUsers.devices.unnamed');

  const userOptions = $derived.by(() => {
    const names = new Map<string, string>();
    for (const d of devices ?? []) if (d.LastUserId && d.LastUserName) names.set(d.LastUserId, d.LastUserName);
    return [{ value: '', label: t('adminUsers.devices.allUsers') }, ...[...names].sort((a, b) => fmt.compare(a[1], b[1])).map(([value, label]) => ({ value, label }))];
  });
  const shown = $derived((devices ?? []).filter((d) => !userFilter || d.LastUserId === userFilter));

  function sub(d: DeviceInfo): string {
    const parts = [[d.AppName, d.AppVersion].filter(Boolean).join(' '), d.LastUserName, d.DateLastActivity ? fmt.relative(d.DateLastActivity) : ''];
    return parts.filter(Boolean).join(' · ');
  }

  // ---- Detail sheet: rename, info, delete ----
  let current = $state<DeviceInfo | null>(null);
  let customName = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  function openDevice(d: DeviceInfo): void {
    current = d;
    customName = d.CustomName ?? '';
    confirmDelete = false;
    // Emby's DeviceInfo carries no CustomName: it is in the device options.
    if (api.kind === 'emby')
      void api.deviceOptions(d.Id).then(
        (o) => {
          if (current?.Id !== d.Id) return;
          current.CustomName = o?.CustomName || undefined;
          customName = o?.CustomName ?? '';
        },
        () => undefined,
      );
  }

  async function saveName(): Promise<void> {
    if (!current || busy) return;
    busy = true;
    try {
      await api.renameDevice(current.Id, customName.trim());
      toast('success', t('adminUsers.devices.renamed'));
      current = null;
      await load();
    } catch (err) {
      toast('error', t('adminUsers.devices.failed', { error: errorMessage(err) }));
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (!current || busy || isOwn(current)) return;
    busy = true;
    const name = display(current);
    try {
      await api.removeDevice(current.Id);
      toast('success', t('adminUsers.devices.deleted', { name }));
      current = null;
      await load();
    } catch (err) {
      toast('error', t('adminUsers.devices.failed', { error: errorMessage(err) }));
    } finally {
      busy = false;
    }
  }
</script>

<div class="au devices">
  <div class="top">
    <p class="count">{devices ? t('adminUsers.devices.count', { n: shown.length }) : ''}</p>
    {#if userOptions.length > 2}
      <Picker label={t('adminUsers.devices.filter')} value={userFilter} options={userOptions} onchange={(v) => (userFilter = v)} />
    {/if}
    <button type="button" class="a-push icon" aria-label={t('common.actions.refresh')} title={t('common.actions.refresh')} onclick={load}><Icon name="refresh" size={14} /></button>
  </div>

  {#if error}<p class="err">{error}</p>{/if}

  <div class="a-group">
    {#if !devices}
      {#each [0, 1, 2] as i (i)}<div class="skel skeleton"></div>{/each}
    {:else if shown.length === 0}
      <div class="a-empty">{t('adminUsers.devices.empty')}</div>
    {:else}
      {#each shown as d (d.Id)}
        <button type="button" class="a-row link-row" onclick={() => openDevice(d)}>
          <span class="glyph"><Icon name="device" size={16} /></span>
          <span class="a-txt">
            <span class="a-lbl">
              <span class="name">{display(d)}</span>
              {#if isOwn(d)}<span class="tag">{t('adminUsers.devices.thisDevice')}</span>{/if}
            </span>
            <span class="a-desc">{sub(d)}</span>
          </span>
          <span class="chev"><Icon name="chevronRight" size={16} /></span>
        </button>
      {/each}
    {/if}
  </div>
  <p class="a-foot">{t('adminUsers.devices.foot')}</p>
</div>

<Sheet open={current !== null} onclose={() => (current = null)} label={current ? display(current) : ''} width={480}>
  {#if current}
    {@const d = current}
    <form
      class="au a-sheet"
      onsubmit={(e) => {
        e.preventDefault();
        void saveName();
      }}
    >
      <h2>{display(d)}</h2>
      <dl>
        {#if d.CustomName && d.CustomName !== d.Name}<dt>{t('adminUsers.devices.reported')}</dt><dd>{d.Name}</dd>{/if}
        <dt>{t('adminUsers.devices.app')}</dt><dd>{[d.AppName, d.AppVersion].filter(Boolean).join(' ') || '—'}</dd>
        <dt>{t('adminUsers.devices.user')}</dt><dd>{d.LastUserName || '—'}</dd>
        <dt>{t('adminUsers.devices.lastActivity')}</dt><dd>{d.DateLastActivity ? `${fmt.date(d.DateLastActivity)} ${fmt.time(d.DateLastActivity)}` : '—'}</dd>
        {#if d.IpAddress}<dt>{t('adminUsers.devices.ip')}</dt><dd class="mono">{d.IpAddress}</dd>{/if}
        {#if d.Capabilities}
          <dt>{t('adminUsers.devices.remote')}</dt><dd>{d.Capabilities.SupportsMediaControl ? t('common.actions.yes') : t('common.actions.no')}</dd>
        {/if}
        <dt>{t('adminUsers.devices.id')}</dt><dd class="mono id">{d.ReportedDeviceId ?? d.Id}</dd>
      </dl>
      <label>
        {t('adminUsers.devices.customName')}
        <input class="a-input" bind:value={customName} placeholder={d.Name} maxlength="128" spellcheck="false" data-autofocus />
        <span class="hint">{t('adminUsers.devices.customNameHint')}</span>
      </label>
      {#if confirmDelete}
        <p class="warn-line">{t('adminUsers.devices.deleteLead', { name: display(d) })}</p>
      {/if}
      <div class="a-sheet-actions">
        {#if confirmDelete}
          <button type="button" class="a-push" onclick={() => (confirmDelete = false)}>{t('common.actions.cancel')}</button>
          <span class="spacer"></span>
          <button type="button" class="a-push danger" disabled={busy} onclick={remove}>{t('adminUsers.devices.deleteConfirm')}</button>
        {:else}
          <button
            type="button"
            class="a-push danger"
            disabled={isOwn(d)}
            title={isOwn(d) ? t('adminUsers.devices.ownHint') : undefined}
            onclick={() => (confirmDelete = true)}>{t('adminUsers.devices.delete')}</button
          >
          <span class="spacer"></span>
          <button type="button" class="a-push" onclick={() => (current = null)}>{t('common.actions.cancel')}</button>
          <button type="submit" class="a-push primary" disabled={busy || customName.trim() === (d.CustomName ?? '')}>{t('common.actions.save')}</button>
        {/if}
      </div>
    </form>
  {/if}
</Sheet>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .count {
    flex: 1;
    margin: 0 0 0 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
</style>
