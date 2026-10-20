<script lang="ts">
  import { onMount } from 'svelte';
  import type { ScrobbleState } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { vaultNoteKey } from '../lib/vault.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';

  // Settings → Music → Scrobbling: ListenBrainz (a user token) and Last.fm (the user's own API account, web auth).
  // Off until a service is connected (see docs/desktop.md, "Music scrobbling").
  let st = $state<ScrobbleState | null>(null);
  let lbToken = $state('');
  let apiKey = $state('');
  let secret = $state('');
  let advanced = $state(false);
  let busy = $state(false);

  onMount(() => {
    void w.scrobble.state().then((s) => {
      st = s;
      apiKey = s.lastfm.apiKey;
    });
    return w.scrobble.onState((s) => {
      st = s;
    });
  });

  async function run(fn: () => Promise<ScrobbleState>, openAuth = false): Promise<void> {
    busy = true;
    try {
      st = await fn();
      lbToken = '';
      secret = '';
      // The Last.fm page where the user allows Wicaby opens at once.
      if (openAuth && st.lastfm.authUrl) void w.app.openExternal(st.lastfm.authUrl);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }
</script>

{#if st}
  <h3 class="gh">{t('settings.scrobble.title')}</h3>
  <div class="group">
    {#if st.listenbrainz.user !== null}
      <div class="row">
        <div class="txt">
          <div class="lbl">{st.listenbrainz.user ? t('settings.scrobble.lbConnectedAs', { user: st.listenbrainz.user }) : t('settings.scrobble.lbConnected')}</div>
          <div class="desc">{t('settings.scrobble.connectedDesc')}</div>
        </div>
        <button type="button" class="btn sm" disabled={busy} onclick={() => run(() => w.scrobble.disconnectListenBrainz())}>{t('settings.scrobble.disconnect')}</button>
      </div>
    {:else}
      <label class="row field-row">
        <span class="lbl">{t('settings.scrobble.lbToken')}</span>
        <input class="field" type="password" spellcheck="false" autocomplete="off" bind:value={lbToken} />
      </label>
      <div class="row">
        <div class="txt"><div class="desc">{t('settings.scrobble.lbHint')}</div></div>
        <button type="button" class="btn sm primary" disabled={busy || !lbToken.trim()} onclick={() => run(() => w.scrobble.connectListenBrainz(lbToken))}>{t('settings.scrobble.connect')}</button>
      </div>
    {/if}

    {#if st.lastfm.user !== null}
      <div class="row">
        <div class="txt">
          <div class="lbl">{st.lastfm.user ? t('settings.scrobble.fmConnectedAs', { user: st.lastfm.user }) : t('settings.scrobble.fmConnected')}</div>
          <div class="desc">{t('settings.scrobble.connectedDesc')}</div>
        </div>
        <button type="button" class="btn sm" disabled={busy} onclick={() => run(() => w.scrobble.disconnectLastfm())}>{t('settings.scrobble.disconnect')}</button>
      </div>
    {:else if st.lastfm.authUrl}
      {@const url = st.lastfm.authUrl}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.scrobble.fmWaiting')}</div>
          <div class="desc">{t('settings.scrobble.fmWaitingDesc')}</div>
        </div>
        <button type="button" class="btn sm" onclick={() => run(() => w.scrobble.cancelLastfm())}>{t('common.actions.cancel')}</button>
        <button type="button" class="btn sm primary" onclick={() => w.app.openExternal(url)}>{t('settings.scrobble.fmOpen')}</button>
      </div>
    {:else}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.scrobble.fmTitle')}</div>
          <div class="desc">{t('settings.scrobble.fmHint')}</div>
        </div>
        <button type="button" class="btn sm" aria-expanded={advanced} onclick={() => (advanced = !advanced)}>{t('settings.scrobble.advanced')}</button>
      </div>
      {#if advanced}
        <label class="row field-row">
          <span class="lbl">{t('settings.scrobble.fmKey')}</span>
          <input class="field" type="text" spellcheck="false" autocomplete="off" bind:value={apiKey} />
        </label>
        <label class="row field-row">
          <span class="lbl">{t('settings.scrobble.fmSecret')}</span>
          <input class="field" type="password" autocomplete="off" placeholder={st.lastfm.apiKey && st.lastfm.apiKey === apiKey.trim() ? t('settings.trakt.saved') : ''} bind:value={secret} />
        </label>
        <div class="row">
          <div class="txt"><div class="desc">{t('settings.scrobble.fmKeyHint')}</div></div>
          <button
            type="button"
            class="btn sm primary"
            disabled={busy || !apiKey.trim() || (!secret.trim() && st.lastfm.apiKey !== apiKey.trim())}
            onclick={() => run(() => w.scrobble.connectLastfm(apiKey, secret), true)}>{t('settings.scrobble.connect')}</button
          >
        </div>
      {/if}
    {/if}
    {#if st.queued}
      <div class="row compact"><div class="desc">{t('settings.scrobble.queued', { count: st.queued })}</div></div>
    {/if}
    {#if st.error}
      <div class="row compact"><div class="desc bad">{st.error}</div></div>
    {/if}
  </div>
  <p class="foot">{t('settings.scrobble.serverNote')} {t(vaultNoteKey('settings.scrobble.foot', 'settings.scrobble.footLinux'))}</p>
{/if}

<style>
  /* Same look as TraktSettings.svelte. */
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
    width: 140px;
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
