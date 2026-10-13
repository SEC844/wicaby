<script lang="ts">
  import { kindLabel } from '../../shared/server-caps';
  import { onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { PublicUser } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { userImageUrl } from '../lib/images';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, onlineSessions, session, sessionFor, toast } from '../lib/stores.svelte';

  // Sign-in is per server: the one in the route (/login/<id>), else the one waiting for it.
  // onsignedin: the first-run setup hosts this page (routes/welcome/SignIn.svelte) without its header and
  // "change server" button, and moves on itself instead of this page going home.
  let { serverId, onsignedin }: { serverId?: string; onsignedin?: () => void } = $props();
  const waiting = () => serverId ?? session.value.sessions.find((s) => s.status === 'server-selected')?.server.id;
  const sid = waiting();
  const server = $derived(sessionFor(sid)?.server);
  // Other servers are still signed in: leaving this page keeps them.
  const others = $derived(onlineSessions().some((s) => s.server.id !== sid));

  let users = $state<PublicUser[]>([]);
  let loadingUsers = $state(true);
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let selected = $state<string | null>(null);
  let failedImages = $state<Record<string, boolean>>({});
  // The password sheet: a picked profile, or `null` for "another user".
  let sheet = $state<{ user: PublicUser | null } | null>(null);
  let passwordEl = $state<HTMLInputElement>();
  let userEl = $state<HTMLInputElement>();
  let sheetEl = $state<HTMLDivElement>();
  let profilesEl = $state<HTMLDivElement>();
  let returnFocus: HTMLElement | null = null;

  const tempo = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tempo')) || 1;

  onMount(async () => {
    try {
      users = await w.session.publicUsers(sid);
    } catch {
      users = [];
    } finally {
      loadingUsers = false;
    }
    // Read the store, not the derived: the page may already be gone after the await.
    const lastName = sessionFor(sid)?.server.userName;
    if (lastName) username = lastName;
    await tick();
    // Land on the last profile used, so Enter is all it takes.
    const last = users.find((u) => u.name === lastName);
    const tile = last && profilesEl?.querySelector<HTMLElement>(`[data-user="${CSS.escape(last.id)}"]`);
    if (tile) tile.focus();
    else if (users.length === 0) (username ? passwordEl : userEl)?.focus();
  });

  async function login() {
    if (!username.trim() || busy) return;
    busy = true;
    error = null;
    try {
      const state = await w.session.login(username.trim(), password, sid);
      password = '';
      if (state.status === 'signed-in') {
        if (onsignedin) onsignedin();
        else navigate('/home', { replace: true });
      }
    } catch (err) {
      error = errorMessage(err);
      await tick();
      sheetEl?.animate(
        [{ transform: 'none' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }],
        { duration: 420 * tempo(), easing: 'ease-out' },
      );
      passwordEl?.select();
    } finally {
      busy = false;
    }
  }

  async function openSheet(user: PublicUser | null) {
    returnFocus = document.activeElement as HTMLElement | null;
    sheet = { user };
    if (!user) username = '';
    await tick();
    (user ? passwordEl : userEl)?.focus();
  }

  function closeSheet() {
    if (busy) return;
    sheet = null;
    error = null;
    password = '';
    selected = null;
    returnFocus?.focus();
  }

  async function pick(user: PublicUser) {
    selected = user.id;
    username = user.name;
    password = '';
    error = null;
    if (user.hasPassword) {
      await openSheet(user);
      return;
    }
    await login();
    // A passwordless sign-in that fails still needs somewhere to show why.
    if (error) await openSheet(user);
  }

  async function changeServer() {
    try {
      await w.session.disconnect(others ? sid : undefined);
      navigate('/servers', { replace: true });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function sheetIn(_node: Element) {
    const spring = (p: number) => 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-p * 7);
    return {
      duration: 560 * tempo(),
      css: (p: number) => {
        const s = spring(p);
        return `opacity: ${Math.min(1, p * 2.5)}; transform: translate3d(0, ${(1 - s) * 40}px, 0) scale(${0.94 + 0.06 * s});`;
      },
    };
  }
</script>

<svelte:window onkeydown={(e) => sheet && e.key === 'Escape' && closeSheet()} />

{#snippet avatar(user: PublicUser, size: number)}
  <span class="avatar" style:--size="{size}px">
    {#if user.imageTag && !failedImages[user.id]}
      <img src={userImageUrl(user.id, user.imageTag, size, sid)} alt="" decoding="async" onerror={() => (failedImages[user.id] = true)} />
    {:else}
      <span class="initial">{user.name.slice(0, 1).toUpperCase()}</span>
    {/if}
  </span>
{/snippet}

{#snippet credentials(askUser: boolean)}
  <form
    class="fields"
    onsubmit={(e) => {
      e.preventDefault();
      void login();
    }}
  >
    {#if askUser}
      <input class="field" placeholder={t('onboarding.fields.username')} bind:this={userEl} bind:value={username} autocomplete="username" spellcheck="false" />
    {/if}
    <input class="field" type="password" placeholder={t('onboarding.fields.password')} bind:this={passwordEl} bind:value={password} autocomplete="current-password" />
    {#if error}
      <p class="error" role="alert" transition:fly={{ y: -4, duration: 180 * tempo() }}><Icon name="exclamation" size={15} /> {error}</p>
    {/if}
    <div class="actions">
      {#if sheet}<button class="btn ghost" type="button" onclick={closeSheet}>{t('common.actions.cancel')}</button>{/if}
      <button class="btn primary" type="submit" disabled={!username.trim() || busy}>
        {#if busy}<span class="spinner"></span>{/if}
        {t('common.actions.signIn')}
      </button>
    </div>
  </form>
{/snippet}

<div class="login" class:embedded={!!onsignedin} inert={sheet !== null}>
  <div class="stage" in:fly={{ y: 20, duration: 560 * tempo(), easing: cubicOut }}>
    {#if !onsignedin}<header>
      <span class="server">
        <span class="dot"></span>
        {server?.name ?? t('onboarding.login.server')}
        <span class="ver">{kindLabel(server?.kind)}{server?.version ? ` ${server.version}` : ''}</span>
      </span>
      <h1>{t('onboarding.login.title')}</h1>
    </header>{/if}

    {#if loadingUsers}
      <div class="profiles" aria-busy="true">
        {#each Array(3) as _, i (i)}
          <div class="profile ghost"><span class="avatar skeleton" style:--size="120px"></span><span class="line skeleton"></span></div>
        {/each}
      </div>
    {:else if users.length > 0}
      <div class="profiles" bind:this={profilesEl}>
        {#each users as user, i (user.id)}
          <button class="profile" class:active={selected === user.id} style:--i={Math.min(i, 12)} data-user={user.id} onclick={() => pick(user)} disabled={busy}>
            <span class="lift">
              {@render avatar(user, 120)}
              {#if busy && selected === user.id && !sheet}
                <span class="busy"><span class="spinner"></span></span>
              {:else if user.hasPassword}
                <span class="badge" title={t('onboarding.login.passwordProtected')}><Icon name="lock" size={11} stroke={2.2} /></span>
              {/if}
            </span>
            <span class="uname">{user.name}</span>
          </button>
        {/each}
        <button class="profile" style:--i={Math.min(users.length, 12)} onclick={() => openSheet(null)} disabled={busy}>
          <span class="lift"><span class="avatar other" style:--size="120px"><Icon name="plus" size={34} stroke={1.6} /></span></span>
          <span class="uname">{t('onboarding.login.otherUser')}</span>
        </button>
      </div>
    {:else}
      <div class="card">
        <p class="card-lead">{t('onboarding.login.manualLead')}</p>
        {@render credentials(true)}
      </div>
    {/if}

    {#if !onsignedin}<button class="btn ghost switch" onclick={changeServer}><Icon name="server" size={15} /> {others ? t('onboarding.login.backToServers') : t('onboarding.login.switchServer')}</button>{/if}
  </div>
</div>

{#if sheet}
  <div class="scrim" transition:fade={{ duration: 240 * tempo() }} onclick={closeSheet} role="presentation"></div>
  <div class="sheet-wrap">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" bind:this={sheetEl} in:sheetIn out:fly={{ y: 24, duration: 200 * tempo(), opacity: 0 }}>
      {#if sheet.user}
        {@render avatar(sheet.user, 76)}
        <h2 id="sheet-title">{sheet.user.name}</h2>
        <p class="sheet-sub">{t('onboarding.login.passwordLead')}</p>
      {:else}
        <span class="avatar other" style:--size="76px"><Icon name="user" size={30} /></span>
        <h2 id="sheet-title">{t('onboarding.login.otherUser')}</h2>
        <p class="sheet-sub">{t('onboarding.login.otherLead')}</p>
      {/if}
      {@render credentials(!sheet.user)}
    </div>
  </div>
{/if}

<style>
  .login {
    view-transition-name: page;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .login.embedded {
    view-transition-name: none;
    overflow: visible;
  }
  .embedded .stage {
    min-height: 0;
    gap: 24px;
    padding: 0;
  }
  .stage {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 44px;
    padding: calc(var(--titlebar) + 24px) 32px 48px;
  }

  header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    text-align: center;
  }
  .server {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 14px 0 12px;
    border-radius: 999px;
    background: var(--material-thin);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    font-size: var(--fs-callout);
    font-weight: 560;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
  }
  .ver {
    font-weight: 400;
    color: var(--label-3);
  }
  h1 {
    margin: 0;
    font-size: var(--fs-hero);
    font-weight: 720;
    letter-spacing: -0.035em;
    line-height: 1.02;
  }

  /* Apple TV style profile picker. */
  .profiles {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 28px 36px;
    max-width: 920px;
  }
  .profile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    width: 140px;
    padding: 10px 0 4px;
    border-radius: var(--r-lg);
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i, 0) * 50ms * var(--tempo));
  }
  .profile:focus-visible {
    box-shadow: none;
  }
  .profile:disabled {
    cursor: progress;
  }
  .lift {
    position: relative;
    isolation: isolate;
    border-radius: 50%;
    transition: transform var(--t-med) var(--spring);
  }
  /* Shadow and specular sit on pseudo-elements so only opacity animates. */
  .lift::before,
  .lift::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-med) var(--ease);
  }
  .lift::before {
    z-index: -1;
    box-shadow: var(--shadow-3);
  }
  .lift::after {
    background: linear-gradient(160deg, rgb(255 255 255 / 0.28), transparent 45%);
    box-shadow:
      inset 0 0 0 3px var(--label),
      inset 0 0 0 4px rgb(0 0 0 / 0.2);
  }
  .profile:hover .lift,
  .profile:focus-visible .lift,
  .profile.active .lift {
    transform: translate3d(0, -6px, 0) scale(1.08);
  }
  .profile:hover .lift::before,
  .profile:focus-visible .lift::before,
  .profile.active .lift::before {
    opacity: 1;
  }
  .profile:focus-visible .lift::after,
  .profile.active .lift::after {
    opacity: 1;
  }
  .profile:active .lift {
    transform: translate3d(0, -2px, 0) scale(1.02);
    transition-duration: 120ms;
  }
  .avatar {
    position: relative;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    flex: none;
    /* Neutral graphite monogram, like the title bar avatar. */
    background: linear-gradient(160deg, var(--graphite), #4a4a4f);
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    animation: fade var(--t-med) var(--ease) both;
  }
  .initial {
    font-size: calc(var(--size) * 0.44);
    font-weight: 650;
    letter-spacing: -0.02em;
    color: #fff;
  }
  .avatar.other {
    background: var(--fill-2);
    color: var(--label-2);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .profile:hover .avatar.other,
  .profile:focus-visible .avatar.other {
    background: var(--fill-3);
    color: var(--label);
  }
  .badge,
  .busy {
    position: absolute;
    display: grid;
    place-items: center;
  }
  .badge {
    right: 6px;
    bottom: 6px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    color: var(--label);
    box-shadow: 0 0 0 0.5px var(--hairline);
  }
  .busy {
    inset: 0;
    border-radius: 50%;
    background: var(--scrim);
  }
  .uname {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-headline);
    font-weight: 560;
    color: var(--label-2);
    transition:
      color var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .profile:hover .uname,
  .profile:focus-visible .uname,
  .profile.active .uname {
    color: var(--label);
    transform: translate3d(0, 4px, 0);
  }
  .profile.ghost {
    animation: none;
  }
  .avatar.skeleton {
    background: var(--fill-1);
  }
  .line {
    width: 72px;
    height: 12px;
    border-radius: 6px;
  }

  .card {
    width: min(400px, 100%);
    padding: 28px;
    border-radius: var(--r-xl);
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-3);
  }
  .card-lead {
    margin: 0 0 16px;
    text-align: center;
    color: var(--label-2);
  }
  .switch {
    color: var(--label-2);
  }
  .switch:hover {
    color: var(--label);
  }

  /* Password sheet */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: var(--scrim);
  }
  .sheet-wrap {
    position: fixed;
    inset: 0;
    z-index: 81;
    display: grid;
    place-items: center;
    padding: 24px;
    pointer-events: none;
  }
  .sheet {
    pointer-events: auto;
    width: min(380px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 28px 24px;
    border-radius: var(--r-xl);
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      inset 0 1px 0 rgb(255 255 255 / 0.06),
      var(--shadow-3);
  }
  .sheet h2 {
    margin: 16px 0 4px;
    font-size: var(--fs-title-2);
    font-weight: 650;
    letter-spacing: -0.018em;
  }
  .sheet-sub {
    margin: 0 0 20px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .fields {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fields .field {
    height: 42px;
    font-size: var(--fs-headline);
  }
  .error {
    margin: 2px 0 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-callout);
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .actions .btn {
    flex: 1;
    height: 40px;
  }
  .spinner {
    width: 16px;
    height: 16px;
    flex: none;
    border-radius: 50%;
    background: conic-gradient(from 90deg, transparent 10%, currentColor);
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
    animation: spin calc(0.8s * var(--tempo)) linear infinite;
  }
  .busy .spinner {
    width: 28px;
    height: 28px;
    color: #fff;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
