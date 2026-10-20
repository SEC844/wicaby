<script lang="ts">
  // Android TV AddressesGroup and AddressesSheet (Settings.kt, B09): the server's local and remote addresses and the
  // one in use; OK on either opens the sheet that edits both (blank: what the server announces).
  import Sheet from '../../components/Sheet.svelte';
  import SheetButton from '../../components/SheetButton.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import TextField from '../../components/TextField.svelte';
  import { addressInUse, editAddresses, knownAddresses } from '../../lib/addresses.svelte';
  import { t } from '../../lib/i18n.svelte';
  import type { Server } from '../../lib/session.svelte';

  let { server }: { server: Server } = $props();

  const emby = $derived(server.kind === 'emby');
  const known = $derived(knownAddresses(server.id));
  let editing = $state(false);
  let local = $state('');
  let remote = $state('');
  let invalid = $state(false);

  function open(): void {
    local = known.local ?? '';
    remote = known.remote ?? '';
    invalid = false;
    editing = true;
  }

  function saveAddresses(): void {
    if (editAddresses(server.id, server.address, emby, local, remote)) editing = false;
    else invalid = true;
  }
</script>

<SettingsGroup title={t('server_addresses')} hint={t('server_addresses_hint')}>
  <SettingRow label={t('server_address_local')} value={known.local ?? t('server_address_none')} chevron onclick={open} />
  <SettingRow label={t('server_address_remote')} value={known.remote ?? t('server_address_none')} chevron onclick={open} />
  <SettingRow label={t('server_address_in_use')} value={addressInUse(server.id, server.address)} />
</SettingsGroup>

{#if editing}
  <Sheet width={560} onclose={() => (editing = false)}>
    <p class="t-title3 title">{t('server_addresses')}</p>
    <p class="t-footnote label-3 label">{t('server_address_local')}</p>
    <TextField bind:value={local} placeholder="http://192.168.1.10:8096" autofocus />
    <p class="t-footnote label-3 label">{t('server_address_remote')}</p>
    <TextField bind:value={remote} placeholder="https://media.example.org" onsubmit={saveAddresses} />
    {#if invalid}<p class="t-footnote error">{t('server_address_invalid')}</p>{/if}
    <div class="save"><SheetButton text={t('server_address_save')} onclick={saveAddresses} /></div>
  </Sheet>
{/if}

<style>
  p {
    margin: 0;
  }
  .title {
    margin-bottom: 18rem;
  }
  .label {
    margin: 8rem 0 6rem 4rem;
  }
  .error {
    margin: 6rem 0 0 4rem;
    color: var(--red);
  }
  .save {
    margin-top: 16rem;
  }
</style>
