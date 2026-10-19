<script lang="ts">
  import { onMount } from 'svelte';
  import type { TraktServer, TraktState } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { vaultNoteKey } from '../lib/vault.svelte';
  import { errorMessage, settings, toast, updateSettings } from '../lib/stores.svelte';
  import Toggle from './Toggle.svelte';

  // Settings → Accounts → Trakt: the user's own Trakt application (client id and secret,
  // see docs/desktop.md, "Trakt scrobbling"), authorized with a device code, then one switch per signed-in server.
  let st = $state<TraktState | null>(null);
  let clientId = $state('');
  let secret = $state('');
  let busy = $state(false);

  onMount(() => {
    void w.trakt.state().then((s) => {
      st = s;
      clientId = s.clientId;
    });
    return w.trakt.onState((s) => {
      st = s;
    });
  });

  async function run(fn: () => Promise<TraktState>): Promise<void> {
    busy = true;
    try {
      st = await fn();
      secret = '';
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  const off = $derived(settings.value?.trakt.offServers ?? []);
  function setScrobble(id: string, on: boolean): void {
    void updateSettings({ trakt: { offServers: on ? off.filter((x) => x !== id) : [...off, id] } });
  }
  const serverDesc = (s: TraktServer) => (s.plugin === true ? t('settings.trakt.server.plugin') : s.plugin === null ? t('settings.trakt.server.unknown') : t('settings.trakt.server.none'));
</script>

{#if st}
  <h3 class="gh first">{t('settings.trakt.title')}</h3>
  <div class="group">
    {#if st.user !== null}
      <div class="row">
        <div class="txt">
          <div class="lbl">{st.user ? t('settings.trakt.connectedAs', { user: st.user }) : t('settings.trakt.connected')}</div>
          <div class="desc">{t('settings.trakt.connectedDesc')}</div>
        </div>
        <button type="button" class="btn sm" disabled={busy} onclick={() => run(() => w.trakt.disconnect())}>{t('settings.trakt.disconnect')}</button>
      </div>
    {:else if st.pending}
      {@const p = st.pending}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.trakt.code')}</div>
          <div class="code mono">{p.userCode}</div>
          <div class="desc">{t('settings.trakt.codeDesc', { url: p.url })}</div>
        </div>
        <button type="button" class="btn sm" onclick={() => run(() => w.trakt.cancel())}>{t('common.actions.cancel')}</button>
        <button type="button" class="btn sm primary" onclick={() => w.app.openExternal(p.url)}>{t('settings.trakt.open')}</button>
      </div>
    {:else}
      <label class="row field-row">
        <span class="lbl">{t('settings.trakt.clientId')}</span>
        <input class="field" type="text" spellcheck="false" autocomplete="off" bind:value={clientId} />
      </label>
      <label class="row field-row">
        <span class="lbl">{t('settings.trakt.clientSecret')}</span>
        <input class="field" type="password" autocomplete="off" placeholder={st.clientId && st.clientId === clientId.trim() ? t('settings.trakt.saved') : ''} bind:value={secret} />
      </label>
      <div class="row">
        <div class="txt"><div class="desc">{t('settings.trakt.hint')}</div></div>
        <button type="button" class="btn sm primary" disabled={busy || !clientId.trim() || (!secret.trim() && st.clientId !== clientId.trim())} onclick={() => run(() => w.trakt.connect(clientId, secret))}>
          {t('settings.trakt.connect')}
        </button>
      </div>
    {/if}
    {#if st.error}
      <div class="row compact"><div class="desc bad">{st.error}</div></div>
    {/if}
  </div>

  {#if st.user !== null}
    <h3 class="gh">{t('settings.trakt.servers')}</h3>
    <div class="group">
      {#each st.servers as s (s.serverId)}
        <div class="row">
          <div class="txt">
            <div class="lbl">{s.name}</div>
            <div class="desc">{serverDesc(s)}</div>
          </div>
          {#if s.plugin !== true}
            <Toggle label={t('settings.trakt.server.toggle', { server: s.name })} checked={!off.includes(s.serverId)} onchange={(v) => setScrobble(s.serverId, v)} />
          {/if}
        </div>
      {:else}
        <div class="row"><div class="desc">{t('settings.trakt.noServer')}</div></div>
      {/each}
    </div>
  {/if}
  <p class="foot">{t(vaultNoteKey('settings.trakt.foot', 'settings.trakt.footLinux'))}</p>
{/if}

<style>
  /* Same look as the rows of routes/Settings.svelte. */
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
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .desc.bad {
    color: var(--label-2);
  }
  .code {
    margin: 6px 0 2px;
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--label);
    user-select: text;
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
    font-size: var(--fs-footnote);
  }
</style>
