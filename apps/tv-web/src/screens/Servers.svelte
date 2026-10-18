<script lang="ts">
  // Android TV ServerScreen (ui/Setup.kt): type the server's address, or reopen the saved one.
  // No LAN discovery: a web page cannot send the UDP broadcast Emby and Jellyfin answer on.
  import AppMark from '../components/AppMark.svelte';
  import ListRow from '../components/ListRow.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { probe } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { nav } from '../lib/nav.svelte';
  import { prefs, setServer, type Server } from '../lib/session.svelte';

  let { add = false }: { add?: boolean } = $props();

  let address = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const saved = $derived(add ? null : prefs.server);

  async function connect(input: string): Promise<void> {
    if (!input.trim() || busy) return;
    busy = true;
    error = null;
    try {
      const found = await probe(input);
      if (!found) {
        error = t('server_unreachable');
        return;
      }
      const server: Server = { id: found.info.Id, name: found.info.ServerName ?? found.info.Id, address: found.address, kind: found.kind };
      // TP-06: an extra account; the primary server and session stay as they are.
      if (add) {
        if (server.id === prefs.server?.id) error = t('server_is_main');
        else nav.push({ name: 'login', server, add: true });
        return;
      }
      setServer(server);
      nav.reset({ name: 'login', server });
    } finally {
      busy = false;
    }
  }
</script>

<div class="screen">
  <div class="intro">
    <AppMark size={76} />
    <h1 class="t-large-title">{t(add ? 'add_server' : 'welcome')}</h1>
    <p class="t-body label-2">{t(add ? 'other_servers_hint' : 'welcome_sub')}</p>
  </div>
  <div class="form">
    <div class="t-eyebrow label-3 eyebrow">{t('manual_address').toUpperCase()}</div>
    <TextField bind:value={address} placeholder={t('address_hint')} autofocus={!saved} onsubmit={() => connect(address)} />
    <div class="actions">
      <Pill text={t('connect')} primary onclick={() => connect(address)} />
      {#if busy}<span class="spin"><Spinner size={22} /></span>{/if}
    </div>
    {#if error}<p class="t-callout error">{error}</p>{/if}
    {#if saved}
      <div class="t-eyebrow label-3 eyebrow saved">{t('saved_server').toUpperCase()}</div>
      <ListRow title={saved.name} subtitle={saved.address} icon="Server" trailing={saved.kind === 'emby' ? 'Emby' : 'Jellyfin'} autofocus onclick={() => connect(saved.address)} />
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    height: 100%;
    padding: 56rem 64rem;
  }
  .intro {
    flex: 0.9;
    padding-top: 40rem;
    margin-right: 56rem;
  }
  h1 {
    margin: 28rem 0 10rem;
  }
  p {
    margin: 0;
  }
  .form {
    flex: 1.1;
  }
  .eyebrow {
    margin: 0 0 10rem 4rem;
  }
  .saved {
    margin-top: 28rem;
  }
  .actions {
    display: flex;
    align-items: center;
    margin-top: 16rem;
  }
  .spin {
    margin-left: 12rem;
  }
  .error {
    color: var(--red);
    margin: 10rem 0 0 4rem;
  }
</style>
