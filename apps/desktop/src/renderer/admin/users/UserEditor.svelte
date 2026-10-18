<script lang="ts">
  // One user: profile (name, password, avatar, Emby Connect) and the access
  // policy, grouped in cards. The policy is edited as a draft and posted whole,
  // so fields this editor does not know survive. A switch only shows when the
  // server sent that field, which absorbs the Emby / Jellyfin / version spread.
  import { onMount } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { fmt, has, t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Avatar from './Avatar.svelte';
  import { activeAdmins, type AccessSchedule, type AdminApi, type DeviceInfo, type Library, type NamedId, type ParentalRating, type UserDto, type UserPolicy } from './userAdmin';

  let {
    api,
    serverId,
    user,
    users,
    onback,
    onchanged,
    ondeleted,
  }: {
    api: AdminApi;
    serverId: string;
    user: UserDto;
    users: UserDto[];
    onback: () => void;
    onchanged: () => Promise<void> | void;
    ondeleted: () => void;
  } = $props();

  const emby = $derived(api.kind === 'emby');
  const isMe = $derived(user.Id === api.me());
  // Demoting, disabling or deleting the last working admin would lock everyone out of the server.
  const lastAdmin = $derived(Boolean(user.Policy?.IsAdministrator) && activeAdmins(users).filter((u) => u.Id !== user.Id).length === 0);
  const guarded = $derived(isMe || lastAdmin);

  // ---- Reference data for the pickers ----
  let libraries = $state<Library[]>([]);
  let channels = $state<NamedId[]>([]);
  let ratings = $state<ParentalRating[]>([]);
  let devices = $state<DeviceInfo[]>([]);

  onMount(() => {
    // Each list is optional: a failing one only hides its checklist.
    void api.libraries().then((v) => (libraries = v ?? []), () => undefined);
    void api.channels().then((v) => (channels = v), () => undefined);
    void api.ratings().then((v) => (ratings = v ?? []), () => undefined);
    void api.devices().then((v) => (devices = v), () => undefined);
  });

  // ---- Policy draft ----
  const snapshot = (p: UserPolicy) => JSON.stringify(p ?? {});
  // The editor is keyed by user id: the draft starts from the policy as first read.
  const initialPolicy = () => ($state.snapshot(user.Policy) ?? {}) as UserPolicy;
  let draft = $state<UserPolicy>(initialPolicy());
  let base = $state(snapshot(initialPolicy()));
  const dirty = $derived(snapshot(draft) !== base);
  let saving = $state(false);

  const hasField = (key: string) => key in draft;
  const flag = (key: string) => draft[key] === true;
  function setFlag(key: string, v: boolean): void {
    draft[key] = v;
  }

  async function savePolicy(): Promise<void> {
    if (!dirty || saving) return;
    if (guarded && (!draft.IsAdministrator || draft.IsDisabled) && user.Policy.IsAdministrator) {
      toast('error', t('adminUsers.policy.guarded'));
      return;
    }
    saving = true;
    try {
      const body = $state.snapshot(draft) as UserPolicy;
      await api.savePolicy(user.Id, body);
      base = snapshot(body);
      toast('success', t('adminUsers.policy.saved'));
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.policy.failed', { error: errorMessage(err) }));
    } finally {
      saving = false;
    }
  }

  // Emby keeps the lockout in LockedOutDate; clearing it and the failure counter unlocks
  // (Jellyfin disables the account instead, undone with the IsDisabled switch).
  function unlock(): void {
    draft.LockedOutDate = 0;
    if (hasField('InvalidLoginAttemptCount')) draft.InvalidLoginAttemptCount = 0;
  }

  function revert(): void {
    draft = JSON.parse(base) as UserPolicy;
  }

  // ---- Id lists (folders, channels, devices) ----
  function inList(key: string, id: string): boolean {
    return ((draft[key] as string[] | undefined) ?? []).includes(id);
  }
  function toggleIn(key: string, id: string, on: boolean): void {
    const cur = ((draft[key] as string[] | undefined) ?? []).filter((x) => x !== id);
    draft[key] = on ? [...cur, id] : cur;
  }

  // ---- Remote bitrate ----
  const MBPS = [0, 0.5, 1, 2, 3, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120];
  const bitrateOptions = $derived.by(() => {
    const cur = Number(draft.RemoteClientBitrateLimit ?? 0);
    const vals = MBPS.map((m) => Math.round(m * 1_000_000));
    if (cur && !vals.includes(cur)) vals.push(cur);
    return vals.sort((a, b) => a - b).map((v) => ({ value: v, label: v ? fmt.bitrate(v / 1_000_000, v % 1_000_000 ? 1 : 0) : t('adminUsers.policy.RemoteClientBitrateLimit.none') }));
  });

  // ---- Parental rating: one entry per value, country names joined ----
  const ratingOptions = $derived.by(() => {
    const byValue = new Map<number, string[]>();
    for (const r of ratings) {
      if (r.Value == null) continue;
      const names = byValue.get(r.Value) ?? [];
      if (names.length < 3) names.push(r.Name);
      byValue.set(r.Value, names);
    }
    const opts = [...byValue.entries()].sort((a, b) => a[0] - b[0]).map(([value, names]) => ({ value, label: names.join(' / ') }));
    const cur = draft.MaxParentalRating;
    if (cur != null && !byValue.has(cur)) opts.push({ value: cur, label: String(cur) });
    return [{ value: -1, label: t('adminUsers.policy.MaxParentalRating.none') }, ...opts];
  });

  // ---- Access schedules (Policy.AccessSchedules): when the user may sign in. ----
  const DAYS = ['Everyday', 'Weekday', 'Weekend', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOptions = $derived(DAYS.map((d) => ({ value: d, label: t(`adminUsers.schedule.days.${d}`) })));
  // Half-hour steps, as in both servers' web editors; 24 is the end of the day.
  const hourLabel = (h: number) => (h >= 24 ? t('adminUsers.schedule.endOfDay') : fmt.time(new Date(2000, 0, 1, Math.floor(h), Math.round((h % 1) * 60))));
  const hourOptions = (from: number, to: number) => Array.from({ length: (to - from) * 2 + 1 }, (_, i) => from + i / 2).map((h) => ({ value: h, label: hourLabel(h) }));
  const startOptions = $derived(hourOptions(0, 23.5));
  const endOptions = $derived(hourOptions(0.5, 24));
  const schedules = $derived(draft.AccessSchedules ?? []);
  function setSchedule(i: number, patch: Partial<AccessSchedule>): void {
    const next = { ...schedules[i], ...patch };
    // Keep start before end: moving one edge past the other pushes it along.
    if (next.EndHour <= next.StartHour) {
      if (patch.StartHour !== undefined) next.EndHour = next.StartHour + 0.5;
      else next.StartHour = next.EndHour - 0.5;
    }
    draft.AccessSchedules = schedules.map((x, j) => (j === i ? next : x));
  }
  const addSchedule = () => (draft.AccessSchedules = [...schedules, { DayOfWeek: 'Everyday', StartHour: 8, EndHour: 20 }]);
  const removeSchedule = (i: number) => (draft.AccessSchedules = schedules.filter((_, j) => j !== i));

  // ---- Tags ----
  let tagDraft = $state<Record<string, string>>({});
  function addTag(key: string): void {
    const v = (tagDraft[key] ?? '').trim();
    if (!v) return;
    const cur = (draft[key] as string[] | undefined) ?? [];
    if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) draft[key] = [...cur, v];
    tagDraft[key] = '';
  }
  function removeTag(key: string, tag: string): void {
    draft[key] = ((draft[key] as string[] | undefined) ?? []).filter((x) => x !== tag);
  }

  // ---- Numbers ----
  const sessionKey = $derived(hasField('SimultaneousStreamLimit') ? 'SimultaneousStreamLimit' : hasField('MaxActiveSessions') ? 'MaxActiveSessions' : null);
  function setNumber(key: string, raw: string, min: number): void {
    const n = Math.max(min, Math.round(Number(raw) || 0));
    draft[key] = n;
  }

  const SYNC_PLAY = ['CreateAndJoinGroups', 'JoinGroups', 'None'];

  // ---- Profile: name ----
  const initialName = () => user.Name;
  let name = $state(initialName());
  let renaming = $state(false);
  const nameTaken = $derived(users.some((u) => u.Id !== user.Id && u.Name.toLowerCase() === name.trim().toLowerCase()));
  async function rename(): Promise<void> {
    const next = name.trim();
    if (!next || next === user.Name || nameTaken || renaming) return;
    renaming = true;
    try {
      await api.rename($state.snapshot(user) as UserDto, next);
      toast('success', t('adminUsers.profile.renamed', { name: next }));
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.profile.renameFailed', { error: errorMessage(err) }));
    } finally {
      renaming = false;
    }
  }

  // ---- Profile: password ----
  let pwOpen = $state(false);
  let pwCurrent = $state('');
  let pwNew = $state('');
  let pwConfirm = $state('');
  let pwBusy = $state(false);
  const hasPassword = $derived(Boolean(user.HasConfiguredPassword ?? user.HasPassword));
  const pwMismatch = $derived(pwConfirm.length > 0 && pwNew !== pwConfirm);
  function openPassword(): void {
    pwCurrent = pwNew = pwConfirm = '';
    pwOpen = true;
  }
  async function savePassword(): Promise<void> {
    if (!pwNew || pwNew !== pwConfirm || pwBusy) return;
    pwBusy = true;
    try {
      await api.setPassword(user.Id, pwNew, isMe ? pwCurrent : '');
      pwOpen = false;
      toast('success', t('adminUsers.password.saved'));
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.password.failed', { error: errorMessage(err) }));
    } finally {
      pwBusy = false;
    }
  }
  let resetOpen = $state(false);
  async function resetPassword(): Promise<void> {
    resetOpen = false;
    try {
      await api.resetPassword(user.Id);
      toast('success', t('adminUsers.password.cleared'));
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.password.failed', { error: errorMessage(err) }));
    }
  }

  // ---- Profile: avatar ----
  async function removeAvatar(): Promise<void> {
    try {
      await api.removeAvatar(user.Id);
      toast('success', t('adminUsers.profile.avatarRemoved'));
      await onchanged();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  // ---- Profile: Emby Connect ----
  let connectName = $state('');
  let connectBusy = $state(false);
  async function linkConnect(): Promise<void> {
    const v = connectName.trim();
    if (!v || connectBusy) return;
    connectBusy = true;
    try {
      const r = await api.linkConnect(user.Id, v);
      toast('success', r?.IsPending ? t('adminUsers.connect.pending', { name: v }) : t('adminUsers.connect.linked', { name: v }));
      connectName = '';
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.connect.failed', { error: errorMessage(err) }));
    } finally {
      connectBusy = false;
    }
  }
  async function unlinkConnect(): Promise<void> {
    connectBusy = true;
    try {
      await api.unlinkConnect(user.Id);
      toast('success', t('adminUsers.connect.unlinked'));
      await onchanged();
    } catch (err) {
      toast('error', t('adminUsers.connect.failed', { error: errorMessage(err) }));
    } finally {
      connectBusy = false;
    }
  }

  // ---- Delete ----
  let deleteOpen = $state(false);
  async function remove(): Promise<void> {
    deleteOpen = false;
    if (guarded) return;
    try {
      await api.remove(user.Id);
      toast('success', t('adminUsers.delete.done', { name: user.Name }));
      ondeleted();
    } catch (err) {
      toast('error', t('adminUsers.delete.failed', { error: errorMessage(err) }));
    }
  }

  const label = (key: string) => t(`adminUsers.policy.${key}.label`);
  const desc = (key: string) => (has(`adminUsers.policy.${key}.desc`) ? t(`adminUsers.policy.${key}.desc`) : '');
  // Emby and Jellyfin word a few switches differently; a ".jellyfin" key overrides.
  const labelFor = (key: string) => (!emby && has(`adminUsers.policy.${key}.jellyfin`) ? t(`adminUsers.policy.${key}.jellyfin`) : label(key));

  const folderRows = $derived(libraries);
</script>

{#snippet sw(key: string, opts: { locked?: boolean; sub?: boolean; hint?: string } = {})}
  {#if hasField(key)}
    <div class="a-row" class:sub={opts.sub}>
      <div class="a-txt">
        <div class="a-lbl">{labelFor(key)}</div>
        {#if opts.hint || desc(key)}<div class="a-desc">{opts.hint || desc(key)}</div>{/if}
      </div>
      <Toggle label={labelFor(key)} checked={flag(key)} disabled={opts.locked} onchange={(v) => setFlag(key, v)} />
    </div>
  {/if}
{/snippet}

{#snippet checklist(key: string, rows: { id: string; name: string }[])}
  {#each rows as r (r.id)}
    <div class="a-row compact sub">
      <div class="a-txt"><div class="a-lbl soft"><span class="name">{r.name}</span></div></div>
      <Toggle label={r.name} checked={inList(key, r.id)} onchange={(v) => toggleIn(key, r.id, v)} />
    </div>
  {/each}
{/snippet}

{#snippet tags(key: string)}
  {#if hasField(key)}
    <div class="a-row tags-row">
      <div class="a-txt">
        <div class="a-lbl">{label(key)}</div>
        {#if desc(key)}<div class="a-desc">{desc(key)}</div>{/if}
        <div class="chips">
          {#each (draft[key] as string[] | undefined) ?? [] as tag (tag)}
            <span class="chip-tag">
              {tag}
              <button type="button" aria-label={t('adminUsers.policy.removeTag', { tag })} onclick={() => removeTag(key, tag)}><Icon name="close" size={12} /></button>
            </span>
          {/each}
          <input
            class="a-input tag-input"
            placeholder={t('adminUsers.policy.addTag')}
            aria-label={label(key)}
            bind:value={tagDraft[key]}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(key);
              }
            }}
            onblur={() => addTag(key)}
          />
        </div>
      </div>
    </div>
  {/if}
{/snippet}

<div class="editor">
  <button type="button" class="back" onclick={onback}><Icon name="chevronLeft" size={16} />{t('adminUsers.editor.back')}</button>

  <header class="who">
    <Avatar userId={user.Id} name={user.Name} tag={user.PrimaryImageTag} {serverId} large />
    <div class="who-txt">
      <div class="who-name">
        <span class="name">{user.Name}</span>
        {#if isMe}<span class="tag">{t('adminUsers.badge.you')}</span>{/if}
        {#if user.Policy?.IsAdministrator}<span class="tag">{t('adminUsers.badge.admin')}</span>{/if}
        {#if user.Policy?.IsDisabled}<span class="tag">{t('adminUsers.badge.disabled')}</span>{/if}
      </div>
      <div class="who-meta">
        {user.LastActivityDate ? t('adminUsers.list.active', { when: fmt.relative(user.LastActivityDate) }) : t('adminUsers.list.never')}
        {#if user.LastLoginDate}· {t('adminUsers.list.login', { when: `${fmt.date(user.LastLoginDate)} ${fmt.time(user.LastLoginDate)}` })}{/if}
      </div>
    </div>
  </header>

  <!-- Profile -->
  <h3 class="a-gh">{t('adminUsers.groups.profile')}</h3>
  <div class="a-group">
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{t('adminUsers.profile.name')}</div>
        {#if nameTaken}<div class="a-desc warn">{t('adminUsers.create.taken')}</div>{/if}
      </div>
      <input
        class="a-input wide"
        bind:value={name}
        maxlength="128"
        spellcheck="false"
        aria-label={t('adminUsers.profile.name')}
        onkeydown={(e) => e.key === 'Enter' && void rename()}
      />
      {#if name.trim() !== user.Name}
        <button type="button" class="a-push" disabled={!name.trim() || nameTaken || renaming} onclick={rename}>{t('adminUsers.profile.rename')}</button>
      {/if}
    </div>
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{t('adminUsers.password.label')}</div>
        <div class="a-desc">{hasPassword ? t('adminUsers.password.set') : t('adminUsers.password.none')}</div>
      </div>
      <div class="a-actions">
        {#if hasPassword && !isMe}<button type="button" class="a-push ghost" onclick={() => (resetOpen = true)}>{t('adminUsers.password.clear')}</button>{/if}
        <button type="button" class="a-push" onclick={openPassword}>{hasPassword ? t('adminUsers.password.change') : t('adminUsers.password.define')}</button>
      </div>
    </div>
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{t('adminUsers.profile.avatar')}</div>
        <div class="a-desc">{t('adminUsers.profile.avatarHint')}</div>
      </div>
      {#if user.PrimaryImageTag}
        <button type="button" class="a-push ghost" onclick={removeAvatar}>{t('adminUsers.profile.avatarRemove')}</button>
      {/if}
    </div>
    {#if emby}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminUsers.connect.label')}</div>
          <div class="a-desc">
            {user.ConnectUserName ? t('adminUsers.connect.linkedTo', { name: user.ConnectUserName }) : t('adminUsers.connect.hint')}
          </div>
        </div>
        {#if user.ConnectUserName}
          <button type="button" class="a-push ghost" disabled={connectBusy} onclick={unlinkConnect}>{t('adminUsers.connect.unlink')}</button>
        {:else}
          <input
            class="a-input wide"
            bind:value={connectName}
            placeholder={t('adminUsers.connect.placeholder')}
            aria-label={t('adminUsers.connect.label')}
            spellcheck="false"
            onkeydown={(e) => e.key === 'Enter' && void linkConnect()}
          />
          <button type="button" class="a-push" disabled={!connectName.trim() || connectBusy} onclick={linkConnect}>{t('adminUsers.connect.link')}</button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Role and visibility -->
  <h3 class="a-gh">{t('adminUsers.groups.role')}</h3>
  <div class="a-group">
    {@render sw('IsAdministrator', { locked: guarded && flag('IsAdministrator'), hint: guarded && flag('IsAdministrator') ? (isMe ? t('adminUsers.policy.selfLocked') : t('adminUsers.policy.lastAdmin')) : '' })}
    {@render sw('IsDisabled', { locked: (guarded || (!emby && flag('IsAdministrator'))) && !flag('IsDisabled'), hint: !emby && flag('IsAdministrator') && !flag('IsDisabled') ? t('adminUsers.policy.disableAdmin') : '' })}
    {@render sw('IsHidden')}
    {@render sw('IsHiddenRemotely')}
    {@render sw('IsHiddenFromUnusedDevices')}
    {#if draft.LockedOutDate}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminUsers.policy.lockedOut')}</div>
          <div class="a-desc">{t('adminUsers.policy.lockedOutDesc')}</div>
        </div>
        <button type="button" class="a-push" onclick={unlock}>{t('adminUsers.policy.unlock')}</button>
      </div>
    {/if}
  </div>

  <!-- Remote access -->
  {#if hasField('EnableRemoteAccess') || hasField('RemoteClientBitrateLimit')}
    <h3 class="a-gh">{t('adminUsers.groups.remote')}</h3>
    <div class="a-group">
      {@render sw('EnableRemoteAccess')}
      {#if hasField('RemoteClientBitrateLimit')}
        <div class="a-row" class:dim={hasField('EnableRemoteAccess') && !flag('EnableRemoteAccess')}>
          <div class="a-txt">
            <div class="a-lbl">{label('RemoteClientBitrateLimit')}</div>
            <div class="a-desc">{desc('RemoteClientBitrateLimit')}</div>
          </div>
          <Picker label={label('RemoteClientBitrateLimit')} value={Number(draft.RemoteClientBitrateLimit ?? 0)} options={bitrateOptions} onchange={(v) => (draft.RemoteClientBitrateLimit = v)} />
        </div>
      {/if}
    </div>
  {/if}

  <!-- Playback -->
  <h3 class="a-gh">{t('adminUsers.groups.playback')}</h3>
  <div class="a-group">
    {@render sw('EnableMediaPlayback')}
    {@render sw('EnableAudioPlaybackTranscoding')}
    {@render sw('EnableVideoPlaybackTranscoding')}
    {@render sw('EnablePlaybackRemuxing')}
    {@render sw('ForceRemoteSourceTranscoding')}
    {@render sw('EnableContentDownloading')}
    {@render sw('EnableSyncTranscoding')}
    {@render sw('EnableMediaConversion')}
    {#if hasField('SyncPlayAccess')}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{label('SyncPlayAccess')}</div>
          <div class="a-desc">{desc('SyncPlayAccess')}</div>
        </div>
        <Picker
          label={label('SyncPlayAccess')}
          value={String(draft.SyncPlayAccess)}
          options={SYNC_PLAY.map((v) => ({ value: v, label: t(`adminUsers.policy.SyncPlayAccess.${v}`) }))}
          onchange={(v) => (draft.SyncPlayAccess = v)}
        />
      </div>
    {/if}
  </div>

  <!-- Libraries and channels -->
  <h3 class="a-gh">{t('adminUsers.groups.libraries')}</h3>
  <div class="a-group">
    {@render sw('EnableAllFolders')}
    {#if hasField('EnableAllFolders') && !flag('EnableAllFolders')}
      {#if folderRows.length}
        {@render checklist('EnabledFolders', folderRows)}
      {:else}
        <div class="a-row compact sub"><div class="a-desc">{t('adminUsers.policy.noLibraries')}</div></div>
      {/if}
    {/if}
  </div>
  {#if hasField('EnableAllChannels') && (channels.length || !flag('EnableAllChannels'))}
    <div class="a-group">
      {@render sw('EnableAllChannels')}
      {#if !flag('EnableAllChannels')}
        {#if channels.length}
          {@render checklist('EnabledChannels', channels.map((c) => ({ id: c.Id, name: c.Name })))}
        {:else}
          <div class="a-row compact sub"><div class="a-desc">{t('adminUsers.policy.noChannels')}</div></div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Parental control -->
  <h3 class="a-gh">{t('adminUsers.groups.parental')}</h3>
  <div class="a-group">
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{label('MaxParentalRating')}</div>
        <div class="a-desc">{desc('MaxParentalRating')}</div>
      </div>
      <Picker
        label={label('MaxParentalRating')}
        value={draft.MaxParentalRating ?? -1}
        options={ratingOptions}
        onchange={(v) => {
          draft.MaxParentalRating = v < 0 ? null : v;
          // Jellyfin 10.11+: the sub-score refines the old score, so it goes with it.
          if (hasField('MaxParentalSubRating')) draft.MaxParentalSubRating = null;
        }}
      />
    </div>
    {@render tags('BlockedTags')}
    {@render tags('AllowedTags')}
    {@render tags('IncludeTags')}
    {#if hasField('AccessSchedules')}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminUsers.schedule.label')}</div>
          <div class="a-desc">{schedules.length ? t('adminUsers.schedule.desc') : t('adminUsers.schedule.none')}</div>
        </div>
        <button type="button" class="a-push" onclick={addSchedule}>{t('adminUsers.schedule.add')}</button>
      </div>
      {#each schedules as s, i (i)}
        <div class="a-row compact sub schedule">
          <Picker label={t('adminUsers.schedule.day')} value={s.DayOfWeek} options={dayOptions} onchange={(v) => setSchedule(i, { DayOfWeek: v })} />
          <Picker label={t('adminUsers.schedule.from')} value={s.StartHour} options={startOptions} onchange={(v) => setSchedule(i, { StartHour: v })} />
          <span class="to">{t('adminUsers.schedule.to')}</span>
          <Picker label={t('adminUsers.schedule.until')} value={s.EndHour} options={endOptions} onchange={(v) => setSchedule(i, { EndHour: v })} />
          <button type="button" class="a-push icon" title={t('adminUsers.schedule.remove')} aria-label={t('adminUsers.schedule.remove')} onclick={() => removeSchedule(i)}><Icon name="trash" size={14} /></button>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Live TV -->
  {#if hasField('EnableLiveTvAccess') || hasField('EnableLiveTvManagement')}
    <h3 class="a-gh">{t('adminUsers.groups.livetv')}</h3>
    <div class="a-group">
      {@render sw('EnableLiveTvAccess')}
      {@render sw('EnableLiveTvManagement')}
    </div>
  {/if}

  <!-- Deletion -->
  {#if hasField('EnableContentDeletion')}
    <h3 class="a-gh">{t('adminUsers.groups.deletion')}</h3>
    <div class="a-group">
      {@render sw('EnableContentDeletion')}
      {#if !flag('EnableContentDeletion') && hasField('EnableContentDeletionFromFolders') && folderRows.length}
        {@render checklist('EnableContentDeletionFromFolders', folderRows)}
      {/if}
    </div>
  {/if}

  <!-- Devices -->
  {#if hasField('EnableAllDevices')}
    <h3 class="a-gh">{t('adminUsers.groups.devices')}</h3>
    <div class="a-group">
      {@render sw('EnableAllDevices')}
      {#if !flag('EnableAllDevices')}
        {#if devices.length}
          {@render checklist(
            'EnabledDevices',
            devices.map((d) => ({ id: d.ReportedDeviceId ?? d.Id, name: `${d.CustomName || d.Name}${d.AppName ? ` · ${d.AppName}` : ''}` })),
          )}
        {:else}
          <div class="a-row compact sub"><div class="a-desc">{t('adminUsers.policy.noDevices')}</div></div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Sessions and security -->
  {#if sessionKey || hasField('LoginAttemptsBeforeLockout')}
    <h3 class="a-gh">{t('adminUsers.groups.security')}</h3>
    <div class="a-group">
      {#if sessionKey}
        <div class="a-row">
          <div class="a-txt">
            <div class="a-lbl">{label(sessionKey)}</div>
            <div class="a-desc">{desc(sessionKey)}</div>
          </div>
          <input
            class="a-input num"
            type="number"
            min="0"
            max="100"
            aria-label={label(sessionKey)}
            value={Number(draft[sessionKey] ?? 0)}
            onchange={(e) => setNumber(sessionKey, e.currentTarget.value, 0)}
          />
        </div>
      {/if}
      {#if hasField('LoginAttemptsBeforeLockout')}
        <div class="a-row">
          <div class="a-txt">
            <div class="a-lbl">{label('LoginAttemptsBeforeLockout')}</div>
            <div class="a-desc">{desc('LoginAttemptsBeforeLockout')}</div>
          </div>
          <input
            class="a-input num"
            type="number"
            min="-1"
            max="1000"
            aria-label={label('LoginAttemptsBeforeLockout')}
            value={Number(draft.LoginAttemptsBeforeLockout ?? 0)}
            onchange={(e) => setNumber('LoginAttemptsBeforeLockout', e.currentTarget.value, -1)}
          />
        </div>
      {/if}
    </div>
  {/if}

  <!-- Other permissions -->
  <h3 class="a-gh">{t('adminUsers.groups.other')}</h3>
  <div class="a-group">
    {@render sw('EnableRemoteControlOfOtherUsers')}
    {@render sw('EnableSharedDeviceControl')}
    {@render sw('EnableUserPreferenceAccess')}
    {@render sw('EnableSubtitleDownloading')}
    {@render sw('EnableSubtitleManagement')}
    {@render sw('EnableLyricManagement')}
    {@render sw('EnableCollectionManagement')}
    {@render sw('EnablePublicSharing')}
    {@render sw('AllowSharingPersonalItems')}
    {@render sw('AllowCameraUpload')}
  </div>

  <!-- Delete -->
  <h3 class="a-gh">{t('adminUsers.groups.danger')}</h3>
  <div class="a-group">
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{t('adminUsers.delete.label')}</div>
        <div class="a-desc">{isMe ? t('adminUsers.delete.self') : lastAdmin ? t('adminUsers.delete.lastAdmin') : t('adminUsers.delete.hint')}</div>
      </div>
      <button type="button" class="a-push danger" disabled={guarded} onclick={() => (deleteOpen = true)}>{t('common.actions.delete')}</button>
    </div>
  </div>

  {#if dirty}
    <div class="savebar material">
      <span>{t('adminUsers.policy.unsaved')}</span>
      <button type="button" class="a-push ghost" onclick={revert} disabled={saving}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push primary" onclick={savePolicy} disabled={saving}>{t('common.actions.save')}</button>
    </div>
  {/if}
</div>

<Sheet open={pwOpen} onclose={() => (pwOpen = false)} label={t('adminUsers.password.title')} width={440}>
  <form
    class="au a-sheet"
    onsubmit={(e) => {
      e.preventDefault();
      void savePassword();
    }}
  >
    <h2>{t('adminUsers.password.title')}</h2>
    <p>{t('adminUsers.password.lead', { name: user.Name })}</p>
    {#if isMe && hasPassword}
      <label>
        {t('adminUsers.password.current')}
        <input class="a-input" type="password" bind:value={pwCurrent} autocomplete="current-password" data-autofocus />
      </label>
    {/if}
    <label>
      {t('adminUsers.password.new')}
      <input class="a-input" type="password" bind:value={pwNew} autocomplete="new-password" data-autofocus={!(isMe && hasPassword) || undefined} />
    </label>
    <label>
      {t('adminUsers.password.confirm')}
      <input class="a-input" type="password" bind:value={pwConfirm} autocomplete="new-password" />
      {#if pwMismatch}<span class="hint bad">{t('adminUsers.password.mismatch')}</span>{/if}
    </label>
    <div class="a-sheet-actions">
      <button type="button" class="a-push" onclick={() => (pwOpen = false)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="a-push primary" disabled={!pwNew || pwNew !== pwConfirm || pwBusy}>{t('common.actions.save')}</button>
    </div>
  </form>
</Sheet>

<Sheet open={resetOpen} onclose={() => (resetOpen = false)} label={t('adminUsers.password.clearTitle')} width={420}>
  <div class="au a-sheet">
    <h2>{t('adminUsers.password.clearTitle')}</h2>
    <p>{t('adminUsers.password.clearLead', { name: user.Name })}</p>
    <div class="a-sheet-actions">
      <button type="button" class="a-push" data-autofocus onclick={() => (resetOpen = false)}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push danger" onclick={resetPassword}>{t('adminUsers.password.clear')}</button>
    </div>
  </div>
</Sheet>

<Sheet open={deleteOpen} onclose={() => (deleteOpen = false)} label={t('adminUsers.delete.title')} width={420}>
  <div class="au a-sheet">
    <h2>{t('adminUsers.delete.title')}</h2>
    <p>{t('adminUsers.delete.lead', { name: user.Name })}</p>
    <div class="a-sheet-actions">
      <button type="button" class="a-push" data-autofocus onclick={() => (deleteOpen = false)}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push danger" onclick={remove}>{t('adminUsers.delete.confirm')}</button>
    </div>
  </div>
</Sheet>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    padding-bottom: 72px;
  }
  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 28px;
    padding: 0 10px 0 4px;
    margin: 0 0 14px -4px;
    border-radius: var(--r-xs);
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .back:hover,
  .back:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
  }
  .who-txt {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .who-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-title-3);
    font-weight: 600;
    letter-spacing: -0.014em;
  }
  .who-meta {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .warn {
    color: var(--warning);
  }
  .tags-row {
    align-items: flex-start;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
  }
  .chip-tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 26px;
    padding: 0 4px 0 10px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .chip-tag button {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label-3);
  }
  .chip-tag button:hover,
  .chip-tag button:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .tag-input {
    width: 160px;
    height: 26px;
  }
  .schedule {
    gap: 8px;
  }
  .schedule .to {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .schedule .a-push.icon {
    margin-left: auto;
  }
  .savebar {
    position: sticky;
    bottom: 16px;
    z-index: 5;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 24px;
    padding: 8px 8px 8px 18px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    color: var(--label-2);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-2);
    animation: bar-in var(--t-med) var(--ease-out) both;
  }
  .savebar span {
    margin-right: 8px;
  }
  @keyframes bar-in {
    from {
      opacity: 0;
      transform: translate3d(0, 8px, 0);
    }
  }
</style>
