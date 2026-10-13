<script lang="ts">
  // Users: the server's accounts, a drill-down editor per user, and creation.
  import './users/admin.css';
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Avatar from './users/Avatar.svelte';
  import UserEditor from './users/UserEditor.svelte';
  import { adminApi, type UserDto } from './users/userAdmin';

  let { serverId }: { serverId: string; kind?: ServerKind } = $props();

  // The shell remounts the section on a server switch, so the client is fixed for its life.
  const api = $derived(adminApi(serverId));
  let users = $state<UserDto[] | null>(null);
  let error = $state('');
  let openId = $state<string | null>(null);
  const opened = $derived(users?.find((u) => u.Id === openId) ?? null);

  async function load(): Promise<void> {
    try {
      users = await api.users();
      error = '';
    } catch (err) {
      error = errorMessage(err);
      users ??= [];
    }
  }

  onMount(() => void load());

  function seen(u: UserDto): string {
    const parts: string[] = [];
    if (u.LastActivityDate) parts.push(t('adminUsers.list.active', { when: fmt.relative(u.LastActivityDate) }));
    if (u.LastLoginDate) parts.push(t('adminUsers.list.login', { when: fmt.date(u.LastLoginDate, { day: 'numeric', month: 'short', year: 'numeric' }) }));
    return parts.length ? parts.join(' · ') : t('adminUsers.list.never');
  }

  // ---- Creation ----
  let creating = $state(false);
  let newName = $state('');
  let newPw = $state('');
  let copyFrom = $state('');
  let busy = $state(false);
  const nameTaken = $derived(Boolean(users?.some((u) => u.Name.toLowerCase() === newName.trim().toLowerCase())));
  const copyOptions = $derived([{ value: '', label: t('adminUsers.create.copyNone') }, ...(users ?? []).map((u) => ({ value: u.Id, label: u.Name }))]);

  function startCreate(): void {
    newName = '';
    newPw = '';
    copyFrom = '';
    creating = true;
  }

  async function create(): Promise<void> {
    const name = newName.trim();
    if (!name || nameTaken || busy) return;
    busy = true;
    try {
      const source = users?.find((u) => u.Id === copyFrom) ?? null;
      const user = await api.create(name, newPw, source);
      creating = false;
      toast('success', t('adminUsers.create.done', { name }));
      await load();
      openId = user.Id;
    } catch (err) {
      toast('error', t('adminUsers.create.failed', { error: errorMessage(err) }));
    } finally {
      busy = false;
    }
  }
</script>

<div class="au users">
  {#if opened && users}
    {#key opened.Id}
      <UserEditor
        {api}
        {serverId}
        user={opened}
        {users}
        onback={() => (openId = null)}
        onchanged={load}
        ondeleted={() => {
          openId = null;
          void load();
        }}
      />
    {/key}
  {:else}
    <div class="top">
      <p class="count">{users ? t('adminUsers.list.count', { n: users.length }) : ''}</p>
      <button type="button" class="a-push primary" onclick={startCreate} disabled={!users}>
        <Icon name="plus" size={14} />{t('adminUsers.list.add')}
      </button>
    </div>

    {#if error}<p class="err">{error}</p>{/if}

    <div class="a-group">
      {#if !users}
        {#each [0, 1, 2] as i (i)}<div class="skel skeleton"></div>{/each}
      {:else if users.length === 0}
        <div class="a-empty">{t('adminUsers.list.empty')}</div>
      {:else}
        {#each users as u (u.Id)}
          <button type="button" class="a-row link-row" class:dim={u.Policy?.IsDisabled} onclick={() => (openId = u.Id)}>
            <Avatar userId={u.Id} name={u.Name} tag={u.PrimaryImageTag} {serverId} />
            <span class="a-txt">
              <span class="a-lbl">
                <span class="name">{u.Name}</span>
                {#if u.Id === api.me()}<span class="tag">{t('adminUsers.badge.you')}</span>{/if}
                {#if u.Policy?.IsAdministrator}<span class="tag">{t('adminUsers.badge.admin')}</span>{/if}
                {#if u.Policy?.IsDisabled}<span class="tag">{t('adminUsers.badge.disabled')}</span>{/if}
                {#if u.Policy?.IsHidden}<span class="tag">{t('adminUsers.badge.hidden')}</span>{/if}
                {#if u.Policy?.LockedOutDate}<span class="tag">{t('adminUsers.badge.locked')}</span>{/if}
              </span>
              <span class="a-desc">{seen(u)}</span>
            </span>
            <span class="chev"><Icon name="chevronRight" size={16} /></span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<Sheet open={creating} onclose={() => (creating = false)} label={t('adminUsers.create.title')} width={460}>
  <form
    class="au a-sheet"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <h2>{t('adminUsers.create.title')}</h2>
    <label>
      {t('adminUsers.create.name')}
      <input class="a-input" bind:value={newName} maxlength="128" autocomplete="off" spellcheck="false" data-autofocus />
      {#if nameTaken}<span class="hint bad">{t('adminUsers.create.taken')}</span>{/if}
    </label>
    <label>
      {t('adminUsers.create.password')}
      <input class="a-input" type="password" bind:value={newPw} autocomplete="new-password" />
      <span class="hint">{t('adminUsers.create.passwordHint')}</span>
    </label>
    <label class="inline">
      <span>
        {t('adminUsers.create.copy')}
        <span class="hint" style="display:block">{t('adminUsers.create.copyHint')}</span>
      </span>
      <Picker label={t('adminUsers.create.copy')} value={copyFrom} options={copyOptions} onchange={(v) => (copyFrom = v)} />
    </label>
    <div class="a-sheet-actions">
      <button type="button" class="a-push" onclick={() => (creating = false)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="a-push primary" disabled={!newName.trim() || nameTaken || busy}>{t('adminUsers.create.submit')}</button>
    </div>
  </form>
</Sheet>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .count {
    flex: 1;
    margin: 0 0 0 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
</style>
