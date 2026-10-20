<script lang="ts">
  // Android TV AccountsSection (Settings.kt): who is signed in, Switch User / Switch Server / Sign Out, then the
  // other servers signed in at once (TP-06): OK on one offers to remove it, "Add a server" signs another in; then
  // Trakt (TP-09).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { confirm } from '../../components/settings/rows';
  import TraktSection from './TraktSection.svelte';
  import type { Api } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { clearCache, useLoad } from '../../lib/load.svelte';
  import { nav } from '../../lib/nav.svelte';
  import { closeAlert, showAlert } from '../../lib/overlay.svelte';
  import { prefs, removeExtra, signOut } from '../../lib/session.svelte';

  let { api }: { api: Api } = $props();
  const session = prefs.session!;
  const me = useLoad(() => 'me', () => api.me(), { persist: true });
  const image = $derived(me.value ? api.userImage(me.value, 160) : undefined);

  // Navigate first, then forget: signing out drops the client this screen uses. Sign out revokes the token on the
  // server and forgets the saved profile (TP-10); Switch User keeps both.
  const extras = $derived((prefs.extras ?? []).filter((e) => e.server.id !== session.server.id));

  // Not revoked on the server: the token may serve elsewhere (Android removeAccount). The rows reload.
  function removeServer(id: string, name: string, address: string): void {
    showAlert({
      title: name,
      message: address,
      actions: [
        { label: t('remove_server'), destructive: true, run: () => (removeExtra(id), clearCache()) },
        { label: t('cancel'), run: closeAlert },
      ],
      focusIndex: 1,
    });
  }

  function leave(to: 'login' | 'servers', revoke: boolean): void {
    const server = session.server;
    if (revoke) void api.request('POST', '/Sessions/Logout').catch(() => {});
    clearCache();
    if (to === 'servers') nav.reset({ name: 'servers' });
    else nav.reset({ name: 'login', server });
    signOut(revoke);
  }
</script>

<div class="who">
  <span class="avatar">{#if image}<img src={image} alt="" />{:else}<span class="t-title2">{session.userName.slice(0, 1).toUpperCase()}</span>{/if}</span>
  <div>
    <div class="t-title2">{session.userName}</div>
    <div class="t-footnote label-3">{session.server.name} · {session.server.address}</div>
  </div>
</div>

<SettingsGroup title={t('group_user')}>
  <SettingRow label={t('switch_user')} chevron onclick={() => nav.push({ name: 'login', server: session.server })} />
  <SettingRow label={t('switch_server')} chevron onclick={() => leave('servers', false)} />
  <SettingRow {...confirm(t('sign_out'), t('sign_out'), () => leave('login', true))} />
</SettingsGroup>

<SettingsGroup title={t('other_servers')} hint={t('other_servers_hint')}>
  {#each extras as e (e.server.id)}
    <SettingRow label={e.server.name} value={e.userName} onclick={() => removeServer(e.server.id, e.server.name, e.server.address)} />
  {/each}
  <SettingRow label={t('add_server')} chevron onclick={() => nav.push({ name: 'servers', add: true })} />
</SettingsGroup>

<TraktSection />

<style>
  .who {
    display: flex;
    align-items: center;
    padding: 0 0 22rem 18rem;
  }
  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64rem;
    height: 64rem;
    margin-right: 18rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--raised);
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
