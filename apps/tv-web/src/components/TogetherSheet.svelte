<script lang="ts">
  // Jellyfin SyncPlay ("Watch together", Android TV Together.kt TogetherSheet and the player's TogetherPanel): in a
  // group, who is in it and Leave; otherwise a new group on this video (at this position) or one of the server's
  // groups (joining plays the group's item).
  import type { Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { deviceName } from '../lib/identity';
  import { createGroup, joinGroup, leaveGroup, syncGroups, syncplay, type SyncGroup } from '../lib/syncplay.svelte';
  import { showToast } from '../lib/toast.svelte';
  import Sheet from './Sheet.svelte';
  import SheetButton from './SheetButton.svelte';

  let { api, itemId, startMs, onclose }: { api: Api; itemId: string; startMs: number; onclose: () => void } = $props();

  // The server's groups, loaded once (null while loading, empty on failure).
  let groups = $state<SyncGroup[] | null>(null);
  // svelte-ignore state_referenced_locally
  syncGroups(api).then(
    (g) => (groups = g),
    () => (groups = []),
  );

  const label = (g: SyncGroup) => (g.participants.length ? `${g.name} · ${g.participants.join(', ')}` : g.name);

  function act(block: () => Promise<void>): void {
    onclose();
    block().catch(() => showToast(t('syncplay_failed')));
  }
</script>

<Sheet width={520} {onclose}>
  <p class="t-title3 title">{t('syncplay_title')}</p>
  {#if syncplay.group}
    <p class="t-callout label-2 note">{t('syncplay_members', syncplay.group.participants.join(', '))}</p>
    <SheetButton
      text={t('syncplay_leave')}
      icon="Logout"
      onclick={() => {
        leaveGroup();
        onclose();
      }}
    />
  {:else}
    <SheetButton text={t('syncplay_new')} icon="Group" onclick={() => act(() => createGroup(api, t('syncplay_group_name', deviceName()), itemId, startMs))} />
    {#if groups?.length === 0}<p class="t-callout label-2 none">{t('syncplay_none')}</p>{/if}
    {#each groups ?? [] as g (g.id)}
      <SheetButton text={label(g)} icon="Person" onclick={() => act(() => joinGroup(api, g.id))} />
    {/each}
  {/if}
</Sheet>

<style>
  p {
    margin: 0;
  }
  .title {
    margin-bottom: 18rem;
    text-align: center;
  }
  .note {
    margin-bottom: 12rem;
  }
  .none {
    margin-top: 8rem;
  }
</style>
