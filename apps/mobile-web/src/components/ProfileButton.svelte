<script lang="ts">
  // The account, top right of the tab pages (as the Apple TV app): the user's picture or initial in a glass ring.
  // A tap opens its menu: Settings, switch user, add a server, sign out.
  import { t } from '$tv/i18n.svelte';
  import { api, prefs } from '$tv/session.svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import ServerIcon from '@lucide/svelte/icons/server';
  import Settings from '@lucide/svelte/icons/settings';
  import Users from '@lucide/svelte/icons/users';
  import { scale, fade } from 'svelte/transition';
  import { leave } from '../lib/account';
  import { nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import Avatar from './Avatar.svelte';

  // floating: pinned top right over the page (Home's hero) rather than in a title row. The menu and its scrim are
  // placed against the page, so the button must not sit in a positioned box of its own.
  let { onMedia = false, floating = false }: { onMedia?: boolean; floating?: boolean } = $props();
  const session = $derived(prefs.session);
  let open = $state(false);

  function run(action: () => void): void {
    open = false;
    action();
  }

  function signOut(): void {
    showAlert({
      title: t('sign_out'),
      message: session ? `${session.userName} · ${session.server.name}` : undefined,
      actions: [
        { label: t('sign_out'), destructive: true, run: () => leave(true) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }
</script>

{#if session}
  <button class="me" class:floating class:glass-media={onMedia} class:glass={!onMedia} aria-label={t('settings_account')} aria-expanded={open} onclick={() => (open = !open)}>
    <Avatar user={{ Id: session.userId, Name: session.userName }} api={api()!} size={34} />
  </button>
  {#if open}
    <div class="scrim" role="presentation" onclick={() => (open = false)} transition:fade={{ duration: 120 }}></div>
    <div class="menu glass" role="menu" transition:scale={{ start: 0.85, duration: 220, opacity: 0 }}>
      <div class="who">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={api()!} size={44} />
        <span class="text">
          <span class="headline ellipsis">{session.userName}</span>
          <span class="footnote label-2 ellipsis">{session.server.name}</span>
        </span>
      </div>
      <button class="item" role="menuitem" onclick={() => run(() => nav.selectTab('settings'))}><span>{t('tab_settings')}</span><Settings size={19} aria-hidden="true" /></button>
      <button class="item" role="menuitem" onclick={() => run(() => leave(false))}><span>{t('switch_user')}</span><Users size={19} aria-hidden="true" /></button>
      <button class="item" role="menuitem" onclick={() => run(() => nav.push({ name: 'servers', add: true }))}><span>{t('add_server')}</span><ServerIcon size={19} aria-hidden="true" /></button>
      <button class="item destructive" role="menuitem" onclick={() => run(signOut)}><span>{t('sign_out')}</span><LogOut size={19} aria-hidden="true" /></button>
    </div>
  {/if}
{/if}

<style>
  .me {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
  }
  .floating {
    position: absolute;
    top: calc(var(--safe-top) + 2px);
    right: max(14px, var(--safe-right));
    z-index: 5;
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: absolute;
    top: calc(var(--safe-top) + 52px);
    right: max(14px, var(--safe-right));
    width: 270px;
    border-radius: var(--r-lg);
    overflow: hidden;
    z-index: 41;
    transform-origin: top right;
    background: var(--material-thick);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 6px solid var(--fill-1);
  }
  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item {
    width: 100%;
    min-height: 46px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    font-size: 17px;
    color: var(--label);
    text-align: left;
  }
  .item + .item {
    border-top: 0.5px solid var(--separator);
  }
  .item:active {
    background: var(--fill-2);
  }
  .destructive {
    color: var(--red);
  }
</style>
