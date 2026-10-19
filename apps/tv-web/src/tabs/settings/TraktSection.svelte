<script lang="ts">
  // Android TV TraktSettings (ui/TraktSettings.kt, TP-09, as the desktop's TraktSettings.svelte): the user's own Trakt
  // application (client id and secret), authorized with a device code shown big with a QR code to the activation
  // page, then one switch per signed-in server. A server whose own Trakt plugin scrobbles shows it instead of a switch.
  import Pill from '../../components/Pill.svelte';
  import QrCode from '../../components/QrCode.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import TextField from '../../components/TextField.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { apis, serverName } from '../../lib/session.svelte';
  import { cancel, connect, disconnect, hasPlugin, setScrobble, trakt } from '../../lib/trakt.svelte';

  let clientId = $state(trakt.clientId);
  let secret = $state('');
  let busy = $state(false);

  const ERROR: Record<string, string> = {
    client: 'trakt_error_invalid_client',
    denied: 'trakt_error_denied',
    expired: 'trakt_error_expired',
  };
  const errorText = $derived(trakt.error ? (ERROR[trakt.error] ? t(ERROR[trakt.error]) : t('trakt_error_failed', trakt.error)) : null);

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    await connect(clientId, secret);
    busy = false;
  }

  const servers = $derived(apis());
  const plugins = $derived(Promise.all(servers.map((a) => hasPlugin(a))));
</script>

{#if trakt.pending}
  <div class="code">
    <QrCode text={trakt.pending.url} size={180} />
    <div class="code-text">
      <p class="t-title3">{t('trakt_code_title')}</p>
      <p class="user-code">{trakt.pending.userCode}</p>
      <p class="t-callout label-2">{t('trakt_code_body', trakt.pending.url)}</p>
      <div class="pill"><Pill text={t('cancel')} autofocus onclick={cancel} /></div>
    </div>
  </div>
{:else if trakt.user !== null}
  <SettingsGroup hint={t('trakt_connected_desc')}>
    <SettingRow label={trakt.user ? t('trakt_connected_as', trakt.user) : t('trakt_connected')} />
    <SettingRow label={t('trakt_disconnect')} onclick={() => void disconnect()} />
  </SettingsGroup>
  <SettingsGroup title={t('trakt_servers')} hint={t('trakt_servers_hint')}>
    {#if !servers.length}
      <SettingRow label={t('trakt_no_server')} />
    {:else}
      {#await plugins then found}
        {#each servers as a, i (a.serverId ?? a.address)}
          {@const id = a.serverId ?? a.address}
          {@const name = serverName(a.serverId) ?? a.address.replace(/^https?:\/\//, '')}
          {#if found[i] === true}
            <SettingRow label={name} value={t('trakt_server_plugin')} />
          {:else}
            <SettingRow
              label={name}
              value={t(trakt.offServers.includes(id) ? 'off' : 'on')}
              onclick={() => setScrobble(id, trakt.offServers.includes(id))}
            />
          {/if}
        {/each}
      {/await}
    {/if}
  </SettingsGroup>
{:else}
  <SettingsGroup hint={t('trakt_hint')}>
    <div class="fields">
      <p class="t-footnote label-2">{t('trakt_client_id')}</p>
      <TextField bind:value={clientId} placeholder={t('trakt_client_id')} />
      <p class="t-footnote label-2">{t('trakt_client_secret')}</p>
      <TextField bind:value={secret} placeholder={t('trakt_client_secret')} password onsubmit={start} />
      {#if errorText}<p class="t-callout error">{errorText}</p>{/if}
      <div class="pill"><Pill text={t('trakt_connect')} primary onclick={start} /></div>
    </div>
  </SettingsGroup>
{/if}

<style>
  p {
    margin: 0;
  }
  .fields {
    display: flex;
    flex-direction: column;
    padding: 4rem 0 8rem;
  }
  .fields > p {
    margin: 12rem 0 6rem 4rem;
  }
  .error {
    margin-top: 12rem !important;
    color: #ff6961;
  }
  .pill {
    display: flex;
    margin-top: 16rem;
  }
  .code {
    display: flex;
    align-items: center;
    padding: 8rem 0;
  }
  .code-text {
    margin-left: 32rem;
    min-width: 0;
  }
  .user-code {
    margin: 10rem 0 12rem;
    font-family: 'Geist Mono', monospace;
    font-size: 48rem;
    font-weight: 600;
    letter-spacing: 0.08em;
  }
</style>
