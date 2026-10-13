<script lang="ts">
  // API keys: GET /Auth/Keys -> { Items: AuthenticationInfo[] } on both servers.
  // Create: POST /Auth/Keys?App= (Emby) / ?app= (Jellyfin); neither returns the key,
  // so the new one is the token that was not in the list before.
  // Revoke: POST /Auth/Keys/{key}/Delete (Emby) / DELETE /Auth/Keys/{key} (Jellyfin).
  // The list only shows a masked key; the full one is shown once, right after creation.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { toast } from '../lib/stores.svelte';
  import ConfirmSheet from './server/ConfirmSheet.svelte';
  import { adminApi, adminError, copyText, serverKind } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();
  const kind = $derived(serverKind(serverId, kindProp));
  const api = $derived(adminApi(serverId));

  interface ApiKey {
    AccessToken: string;
    AppName?: string;
    DateCreated?: string;
    DateLastActivity?: string;
    DateRevoked?: string;
    IsActive?: boolean;
  }

  let loading = $state(true);
  let error = $state('');
  let keys = $state<ApiKey[]>([]);
  let creating = $state(false);
  let appName = $state('');
  let busy = $state(false);
  let revealed = $state<{ app: string; token: string } | null>(null);
  let revoking = $state<ApiKey | null>(null);

  const nameValid = $derived(/^[^\s].{0,63}$/.test(appName.trim()) && appName.trim().length > 0);

  async function fetchKeys(): Promise<ApiKey[]> {
    const res = await api.get<{ Items?: ApiKey[] } | ApiKey[]>('/Auth/Keys');
    const list = Array.isArray(res) ? res : (res?.Items ?? []);
    return list.filter((k) => k.AccessToken && !k.DateRevoked).sort((a, b) => (b.DateCreated ?? '').localeCompare(a.DateCreated ?? ''));
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      keys = await fetchKeys();
    } catch (err) {
      error = adminError(err);
    } finally {
      loading = false;
    }
  }

  async function create(): Promise<void> {
    if (!nameValid || busy) return;
    busy = true;
    const app = appName.trim();
    try {
      const before = new Set((await fetchKeys()).map((k) => k.AccessToken));
      await api.post('/Auth/Keys', kind === 'jellyfin' ? { app } : { App: app });
      keys = await fetchKeys();
      const fresh = keys.find((k) => !before.has(k.AccessToken) && k.AppName === app) ?? keys.find((k) => !before.has(k.AccessToken));
      creating = false;
      appName = '';
      if (fresh) revealed = { app, token: fresh.AccessToken };
      else toast('success', t('adminServer.apikeys.created', { app }));
    } catch (err) {
      toast('error', adminError(err));
    } finally {
      busy = false;
    }
  }

  async function revoke(): Promise<void> {
    const k = revoking;
    if (!k) return;
    busy = true;
    try {
      const key = encodeURIComponent(k.AccessToken);
      if (kind === 'jellyfin') await api.del(`/Auth/Keys/${key}`);
      else await api.post(`/Auth/Keys/${key}/Delete`);
      keys = keys.filter((x) => x.AccessToken !== k.AccessToken);
      toast('success', t('adminServer.apikeys.revoked', { app: k.AppName ?? '' }));
      revoking = null;
    } catch (err) {
      toast('error', adminError(err));
    } finally {
      busy = false;
    }
  }

  const mask = (token: string) => (token.length > 10 ? `${token.slice(0, 4)}…${token.slice(-4)}` : '••••');

  onMount(() => void load());
</script>

<div class="head">
  <p class="intro">{t('adminServer.apikeys.intro')}</p>
  <button type="button" class="a-push" onclick={() => (creating = true)}><Icon name="plus" size={14} />{t('adminServer.apikeys.new')}</button>
</div>

{#if loading}
  <div class="skeleton sk"></div>
{:else if error}
  <div class="a-group">
    <div class="a-empty">
      {error}
      <div class="retry"><button type="button" class="a-push" onclick={load}>{t('common.actions.retry')}</button></div>
    </div>
  </div>
{:else if !keys.length}
  <div class="a-group"><div class="a-empty">{t('adminServer.apikeys.none')}</div></div>
{:else}
  <div class="a-group">
    {#each keys as k (k.AccessToken)}
      <div class="a-row">
        <span class="ic"><Icon name="key" size={17} /></span>
        <div class="a-txt">
          <span class="a-lbl">{k.AppName || t('adminServer.apikeys.unnamed')}</span>
          <span class="a-desc">
            {k.DateCreated ? t('adminServer.apikeys.createdOn', { date: fmt.date(k.DateCreated) }) : ''}{k.DateLastActivity
              ? ` · ${t('adminServer.apikeys.lastUsed', { when: fmt.relative(k.DateLastActivity) })}`
              : ''}
          </span>
        </div>
        <span class="token mono">{mask(k.AccessToken)}</span>
        <div class="a-actions">
          <button type="button" class="a-push ghost" onclick={() => copyText(k.AccessToken)}>{t('common.actions.copy')}</button>
          <button type="button" class="a-push ghost danger" onclick={() => (revoking = k)}>{t('adminServer.apikeys.revoke')}</button>
        </div>
      </div>
    {/each}
  </div>
  <p class="a-foot">{t('adminServer.apikeys.foot')}</p>
{/if}

<Sheet open={creating} onclose={() => (creating = false)} label={t('adminServer.apikeys.newTitle')} width={460}>
  <form class="a-sheet" onsubmit={(e) => (e.preventDefault(), void create())}>
    <h2>{t('adminServer.apikeys.newTitle')}</h2>
    <p>{t('adminServer.apikeys.newText')}</p>
    <label>
      {t('adminServer.apikeys.appName')}
      <input class="a-input" type="text" maxlength="64" placeholder={t('adminServer.apikeys.appPlaceholder')} bind:value={appName} data-autofocus />
    </label>
    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={() => (creating = false)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="a-push primary" disabled={!nameValid || busy}>{t('adminServer.apikeys.create')}</button>
    </div>
  </form>
</Sheet>

<Sheet open={!!revealed} onclose={() => (revealed = null)} label={t('adminServer.apikeys.revealTitle')} width={500}>
  {#if revealed}
    <div class="a-sheet">
      <h2>{t('adminServer.apikeys.revealTitle')}</h2>
      <p>{t('adminServer.apikeys.revealText', { app: revealed.app })}</p>
      <div class="reveal mono">{revealed.token}</div>
      <div class="a-sheet-actions">
        <button type="button" class="a-push ghost" onclick={() => (revealed = null)}>{t('common.actions.done')}</button>
        <button type="button" class="a-push primary" data-autofocus onclick={() => revealed && copyText(revealed.token)}>{t('common.actions.copy')}</button>
      </div>
    </div>
  {/if}
</Sheet>

<ConfirmSheet
  open={!!revoking}
  title={t('adminServer.apikeys.revokeTitle', { app: revoking?.AppName ?? '' })}
  message={t('adminServer.apikeys.revokeText')}
  confirmLabel={t('adminServer.apikeys.revoke')}
  danger
  {busy}
  onconfirm={revoke}
  onclose={() => (revoking = null)}
/>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .intro {
    flex: 1;
    margin: 0;
    font-size: var(--fs-callout);
    color: var(--label-2);
    line-height: 1.5;
  }
  .sk {
    height: 240px;
    border-radius: var(--r-sm);
  }
  .retry {
    margin-top: 12px;
  }
  .ic {
    flex: none;
    display: grid;
    color: var(--label-3);
  }
  .token {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .reveal {
    padding: 12px 14px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-callout);
    color: var(--label);
    word-break: break-all;
    user-select: all;
  }
</style>
