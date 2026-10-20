<script lang="ts">
  // Android TV LoginScreen (ui/Setup.kt): "Who's watching?" with the server's public users and this TV's saved
  // accounts, then the password form (or name and password for another user). On Jellyfin with Quick Connect on, a code
  // to approve elsewhere signs in with no password typed on the remote.
  import type { UserDto } from '$shared/models';
  import { getContext, onMount } from 'svelte';
  import Avatar from '../components/Avatar.svelte';
  import PinSheet from '../components/PinSheet.svelte';
  import Pill from '../components/Pill.svelte';
  import QuickConnectSheet from '../components/QuickConnectSheet.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextButton from '../components/TextButton.svelte';
  import TextField from '../components/TextField.svelte';
  import { ApiError } from '../lib/api';
  import { focusFirst } from '../lib/focus';
  import { t } from '../lib/i18n.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { addExtra, apiFor, prefs, signIn, type Server, type Session } from '../lib/session.svelte';
  import { clearCache } from '../lib/load.svelte';
  import { checkPin, hasPin } from '../lib/profiles.svelte';

  let { server, add = false }: { server: Server; add?: boolean } = $props();

  // A login screen is pushed for one server and never re-targeted: the initial value is the value.
  // svelte-ignore state_referenced_locally
  const api = apiFor(server);
  let users = $state<UserDto[] | null>(null);
  let loadError = $state(false);
  let picked = $state<UserDto | null>(null);
  let manual = $state(false);
  let name = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const form = $derived(picked !== null || manual);

  // TP-10: this TV's accounts on this server (none while adding an extra server).
  const saved = $derived(add ? [] : prefs.profiles.filter((p) => p.server.id === server.id));

  interface Entry {
    user: UserDto;
    saved?: Session;
  }
  // The public users, then saved accounts the server hides from its public list.
  const entries = $derived.by<Entry[] | null>(() => {
    if (!users) return loadError && saved.length ? saved.map((s) => ({ user: { Id: s.userId, Name: s.userName }, saved: s })) : null;
    const list: Entry[] = users.map((u) => ({ user: u, saved: saved.find((s) => s.userId === u.Id) }));
    for (const s of saved) if (!list.some((e) => e.user.Id === s.userId)) list.push({ user: { Id: s.userId, Name: s.userName }, saved: s });
    return list;
  });
  const start = $derived(Math.max(0, entries?.findIndex((e) => e.user.Id === prefs.session?.userId) ?? 0));

  async function loadUsers(): Promise<void> {
    loadError = false;
    try {
      users = await api.publicUsers();
    } catch {
      loadError = true;
    }
    requestAnimationFrame(() => focusFirst(document.querySelector('[data-screen-top]') ?? document));
  }

  function done(session: Session): void {
    // TP-06: another server joins the primary one; back to Settings, whose rows reload with it.
    if (add) {
      addExtra(session);
      clearCache();
      nav.back();
      nav.back();
      return;
    }
    signIn(session);
    nav.reset({ name: 'main' });
  }

  // Jellyfin with Quick Connect on: the "Quick Connect" button.
  let quick = $state(false);
  let quickOpen = $state(false);
  void api.quickConnectEnabled().then((on) => (quick = on));

  async function login(user: string, pw: string): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const r = await api.signIn(user, pw);
      done({ server, userId: r.User.Id, userName: r.User.Name, token: r.AccessToken });
    } catch (e) {
      error = e instanceof ApiError && (e.status === 401 || e.status === 403) ? t('wrong_credentials') : e instanceof ApiError && e.status ? e.message : t('server_unreachable');
    } finally {
      busy = false;
    }
  }

  // A saved account: its token is checked against the server, and the password asked again if it was revoked.
  async function open(entry: Entry & { saved: Session }): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const check = apiFor(server, entry.saved);
      const me = await check.get<UserDto>(`/Users/${entry.saved.userId}`);
      if (me.Id !== entry.saved.userId) throw new ApiError('not this account', 401);
      done(entry.saved);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        pick(entry.user);
        error = t('profile_expired');
      } else error = t('server_unreachable');
    } finally {
      busy = false;
    }
  }

  function pick(user: UserDto | null): void {
    manual = user === null;
    picked = user;
    password = '';
    error = null;
    requestAnimationFrame(() => focusFirst(document.querySelector('[data-screen-top]') ?? document));
  }

  // TP-10: a saved account with a PIN on this TV asks for it first.
  let pinFor = $state<(Entry & { saved: Session }) | null>(null);

  function choose(entry: Entry): void {
    if (entry.saved && hasPin(entry.saved)) pinFor = entry as Entry & { saved: Session };
    else if (entry.saved) void open(entry as Entry & { saved: Session });
    else if (entry.user.HasPassword === false) void login(entry.user.Name, '');
    else pick(entry.user);
  }

  function image(u: UserDto): string | undefined {
    return api.userImage(u, 240);
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    void loadUsers();
    return onBack(screen, () => {
      if (!form) return false;
      picked = null;
      manual = false;
      error = null;
      requestAnimationFrame(() => focusFirst(document.querySelector('[data-screen-top]') ?? document));
      return true;
    });
  });
</script>

<div class="screen">
  {#if !form}
    <h1 class="t-large-title">{t('who_is_watching')}</h1>
    <p class="t-callout label-2">{server.name}</p>
    <div class="users">
      {#if entries === null && loadError}
        <p class="t-body label-2">{t('server_unreachable')}</p>
        <Pill text={t('retry')} autofocus onclick={loadUsers} />
      {:else if entries === null}
        <Spinner />
      {:else}
        {#each entries as e, i (e.user.Id)}
          <Avatar label={e.user.Name} image={image(e.user)} autofocus={i === start} onclick={() => choose(e)} />
        {/each}
        <Avatar label={t('other_user')} plus autofocus={entries.length === 0} onclick={() => pick(null)} />
      {/if}
    </div>
  {:else}
    <div class="who">
      <span class="badge t-title2">{(picked?.Name ?? '+').slice(0, 1).toUpperCase()}</span>
      <div>
        <div class="t-title2">{picked?.Name ?? t('other_user')}</div>
        <div class="t-callout label-2">{server.name}</div>
      </div>
    </div>
    <div class="fields">
      {#if manual}
        <TextField bind:value={name} placeholder={t('username')} autofocus />
        <div class="gap"></div>
      {/if}
      <TextField
        bind:value={password}
        password
        placeholder={picked ? t('password_for', picked.Name) : t('password')}
        autofocus={!manual}
        onsubmit={() => login(picked?.Name ?? name, password)}
      />
      <div class="actions">
        <Pill text={t('sign_in')} primary onclick={() => login(picked?.Name ?? name, password)} />
        {#if busy}<span class="spin"><Spinner size={22} /></span>{/if}
      </div>
    </div>
  {/if}
  {#if error}<p class="t-callout error">{error}</p>{/if}
  <div class="secondary">
    {#if !add}<TextButton text={t('switch_server')} icon="Server" onclick={() => nav.reset({ name: 'servers' })} />{/if}
    {#if quick}<TextButton text={t('quick_connect')} icon="Keyboard" onclick={() => (quickOpen = true)} />{/if}
  </div>
</div>
{#if pinFor}
  <PinSheet
    mode="enter"
    name={pinFor.saved.userName}
    check={(p) => checkPin(pinFor!.saved, p)}
    onok={() => {
      // Read before it is cleared: the sheet closes with it.
      const entry = pinFor!;
      pinFor = null;
      void open(entry);
    }}
    onclose={() => (pinFor = null)}
  />
{/if}
{#if quickOpen}
  <QuickConnectSheet
    {api}
    onclose={() => (quickOpen = false)}
    onsignedin={(r) => {
      quickOpen = false;
      done({ server, userId: r.User.Id, userName: r.User.Name, token: r.AccessToken });
    }}
  />
{/if}

<style>
  .screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    padding-top: 70rem;
  }
  h1,
  p {
    margin: 0;
  }
  h1 + p {
    margin-top: 6rem;
  }
  .users {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    margin-top: 40rem;
  }
  .users > p {
    margin-right: 16rem;
    align-self: center;
  }
  .who {
    display: flex;
    align-items: center;
  }
  .badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56rem;
    height: 56rem;
    margin-right: 16rem;
    border-radius: 50%;
    background: var(--elevated-2);
  }
  .fields {
    width: 460rem;
    margin-top: 28rem;
  }
  .gap {
    height: 12rem;
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
    margin-top: 16rem;
    text-align: center;
  }
  .secondary {
    display: flex;
    margin-top: 40rem;
  }
  .secondary > :global(* + *) {
    margin-left: 12rem;
  }
</style>
