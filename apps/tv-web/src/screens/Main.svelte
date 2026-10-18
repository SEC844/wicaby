<script lang="ts">
  // Android TV MainScreen (ui/Main.kt): the tab bar and the selected tab. Being built: for now it confirms the
  // session and offers the account actions.
  import Pill from '../components/Pill.svelte';
  import { t } from '../lib/i18n.svelte';
  import { nav } from '../lib/nav.svelte';
  import { prefs, signOut } from '../lib/session.svelte';
</script>

<div class="screen">
  <h1 class="t-large-title">{t('tab_home')}</h1>
  <p class="t-body label-2">{prefs.session?.userName} · {prefs.session?.server.name}</p>
  <div class="actions">
    <Pill text={t('switch_user')} autofocus onclick={() => { signOut(false); nav.reset({ name: 'login', server: prefs.server! }); }} />
    <span class="gap"></span>
    <Pill text={t('sign_out')} onclick={() => { signOut(true); nav.reset({ name: 'login', server: prefs.server! }); }} />
  </div>
</div>

<style>
  .screen {
    padding: 100rem 64rem;
  }
  h1,
  p {
    margin: 0 0 10rem;
  }
  .actions {
    display: flex;
    margin-top: 24rem;
  }
  .gap {
    width: 12rem;
  }
</style>
