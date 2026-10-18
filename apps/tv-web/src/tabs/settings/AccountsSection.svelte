<script lang="ts">
  // Android TV AccountsSection (Settings.kt): who is signed in, Switch User / Switch Server / Sign Out. The server
  // addresses, profile PIN and other servers groups arrive with multi-server support (M3).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import type { Api } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { clearCache } from '../../lib/load.svelte';
  import { nav } from '../../lib/nav.svelte';
  import { prefs, signOut } from '../../lib/session.svelte';

  let { api }: { api: Api } = $props();
  const session = prefs.session!;
  const image = $derived(api.userImage({ Id: session.userId }, 160));

  // Navigate first, then forget: signing out drops the client this screen uses. Sign out revokes the token on the
  // server and forgets the saved profile (TP-10); Switch User keeps both.
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

<SettingsGroup>
  <SettingRow label={t('switch_user')} chevron onclick={() => nav.push({ name: 'login', server: session.server })} />
  <SettingRow label={t('switch_server')} chevron onclick={() => leave('servers', false)} />
  <SettingRow label={t('sign_out')} onclick={() => leave('login', true)} />
</SettingsGroup>

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
