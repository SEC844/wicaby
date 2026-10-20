<script lang="ts">
  // Android TV ScrobbleSection (ScrobbleSettings.kt, in Settings > Accounts), as the desktop's ScrobbleSettings.svelte:
  // ListenBrainz (a user token) and Last.fm (the user's own API account under Advanced, authorized on last.fm through
  // a QR code). Off until connected.
  import QrCode from '../../components/QrCode.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { confirm } from '../../components/settings/rows';
  import Sheet from '../../components/Sheet.svelte';
  import SheetButton from '../../components/SheetButton.svelte';
  import TextField from '../../components/TextField.svelte';
  import { t } from '../../lib/i18n.svelte';
  import {
    cancelLastfm,
    connectLastfm,
    connectListenBrainz,
    disconnectLastfm,
    disconnectListenBrainz,
    scrobble,
    type ScrobbleFailure,
  } from '../../lib/scrobble.svelte';

  const errorText = (e: ScrobbleFailure) => t(e.key, e.detail ?? '');

  // ListenBrainz
  let token = $state('');
  let lbBusy = $state(false);
  let lbInvalid = $state(false);
  async function submitLb(): Promise<void> {
    if (lbBusy || !token.trim()) return;
    lbBusy = true;
    lbInvalid = !(await connectListenBrainz(token));
    lbBusy = false;
    token = '';
  }

  // Last.fm
  let advanced = $state(false);
  // svelte-ignore state_referenced_locally
  let key = $state(scrobble.fmKey);
  let secret = $state('');
  let fmBusy = $state(false);
  let fmInvalid = $state(false);
  const keepSecret = $derived(!!scrobble.fmKey && scrobble.fmKey === key.trim());
  let waiting = $state(false);
  async function submitFm(): Promise<void> {
    if (fmBusy || !key.trim() || (!secret.trim() && !keepSecret)) return;
    fmBusy = true;
    fmInvalid = !(await connectLastfm(key, secret));
    fmBusy = false;
    secret = '';
    if (scrobble.authUrl) waiting = true;
  }
  // The QR sheet closes itself once Last.fm said yes.
  $effect(() => {
    if (waiting && scrobble.fmUser !== null) waiting = false;
  });
  function closeWaiting(): void {
    cancelLastfm();
    waiting = false;
  }
</script>

{#if scrobble.lbUser !== null}
  <SettingsGroup title={t('scrobble_title')} hint={t('scrobble_connected_desc')}>
    <SettingRow label={scrobble.lbUser ? t('scrobble_lb_connected_as', scrobble.lbUser) : t('scrobble_lb_connected')} />
    <SettingRow {...confirm(t('scrobble_disconnect'), t('scrobble_disconnect'), () => void disconnectListenBrainz())} />
  </SettingsGroup>
{:else}
  <SettingsGroup title={t('scrobble_title')} hint={t('scrobble_lb_hint')}>
    <TextField bind:value={token} placeholder={t('scrobble_lb_token')} password onsubmit={submitLb} />
    <SettingRow label={t(lbBusy ? 'connecting' : 'scrobble_connect')} chevron onclick={submitLb} />
    {#if lbInvalid}<p class="t-callout error">{t('scrobble_error_invalid_token')}</p>{/if}
  </SettingsGroup>
{/if}

{#if scrobble.fmUser !== null}
  <SettingsGroup title={t('scrobble_fm_title')} hint={t('scrobble_connected_desc')}>
    <SettingRow label={scrobble.fmUser ? t('scrobble_fm_connected_as', scrobble.fmUser) : t('scrobble_fm_connected')} />
    <SettingRow {...confirm(t('scrobble_disconnect'), t('scrobble_disconnect'), () => void disconnectLastfm())} />
  </SettingsGroup>
{:else if !advanced}
  <SettingsGroup title={t('scrobble_fm_title')} hint={t('scrobble_fm_hint')}>
    <SettingRow label={t('scrobble_advanced')} chevron onclick={() => (advanced = true)} />
  </SettingsGroup>
{:else}
  <SettingsGroup title={t('scrobble_fm_title')} hint={t('scrobble_fm_key_hint')}>
    <TextField bind:value={key} placeholder={t('scrobble_fm_key')} />
    <div class="gap"></div>
    <TextField bind:value={secret} placeholder={t(keepSecret ? 'trakt_saved' : 'scrobble_fm_secret')} password onsubmit={submitFm} />
    <SettingRow label={t(fmBusy ? 'connecting' : 'scrobble_connect')} chevron onclick={submitFm} />
    {#if fmInvalid}<p class="t-callout error">{t('scrobble_error_invalid_key')}</p>{/if}
  </SettingsGroup>
{/if}

{#if scrobble.queued > 0}<p class="t-callout label-2 note">{t('scrobble_queued', scrobble.queued)}</p>{/if}
{#if scrobble.error}<p class="t-callout error note">{errorText(scrobble.error)}</p>{/if}
<!-- Not Android's foot line: a TV has no keystore, the tokens stay in its storage. -->
<p class="t-footnote label-3 foot">{t('scrobble_server_note')}</p>

{#if waiting}
  <Sheet width={520} onclose={closeWaiting}>
    <p class="t-title2 center">{t('scrobble_fm_waiting')}</p>
    {#if scrobble.authUrl}
      <div class="qr"><QrCode text={scrobble.authUrl} size={200} /></div>
      <p class="t-callout label-2 center">{t('scrobble_fm_waiting_desc')}</p>
    {/if}
    {#if scrobble.error}<p class="t-callout error center">{errorText(scrobble.error)}</p>{/if}
    <div class="close"><SheetButton text={t(scrobble.authUrl ? 'cancel' : 'close')} autofocus onclick={closeWaiting} /></div>
  </Sheet>
{/if}

<style>
  p {
    margin: 0;
  }
  .gap {
    height: 4rem;
  }
  .error {
    margin-top: 6rem;
    padding-left: 18rem;
    color: var(--red);
  }
  .note {
    padding: 0 0 12rem 18rem;
  }
  .foot {
    margin-bottom: 26rem;
    padding: 0 18rem;
  }
  .center {
    padding-left: 0;
    text-align: center;
  }
  .qr {
    display: flex;
    justify-content: center;
    margin-top: 14rem;
  }
  .qr + p {
    margin-top: 14rem;
  }
  .close {
    margin-top: 18rem;
  }
</style>
