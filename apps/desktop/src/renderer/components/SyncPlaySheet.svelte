<script lang="ts">
  import { untrack } from 'svelte';
  import type { SyncPlayGroup } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage, sessionFor, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // Jellyfin SyncPlay ("Regarder ensemble"): the group this app is in (members, Leave), else the server's groups
  // and New group. Only shown where bridge.syncplay exists; main applies the group's commands to the player.
  // oncreated: the item page starts its item, which becomes the new group's queue.
  let { open, serverId, onclose, oncreated }: { open: boolean; serverId?: string; onclose: () => void; oncreated?: () => void } = $props();

  const sp = w.syncplay;
  let group = $state<SyncPlayGroup | null>(sp?.current() ?? null);
  let groups = $state<SyncPlayGroup[] | null>(null);
  let busy = $state(false);

  $effect(() => sp?.onChange((g) => (group = g)));
  $effect(() => {
    if (open && !group) untrack(() => void load());
  });

  async function load(): Promise<void> {
    groups = null;
    try {
      groups = (await sp?.list(serverId)) ?? [];
    } catch (err) {
      groups = [];
      toast('error', errorMessage(err));
    }
  }

  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy || !sp) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  const create = () =>
    run(async () => {
      await sp!.create(t('player.syncplay.defaultName', { name: sessionFor(serverId)?.user?.name ?? '' }), serverId);
      onclose();
      oncreated?.();
    });
  const join = (id: string) =>
    run(async () => {
      await sp!.join(id, serverId);
      onclose();
    });
  const leave = () => run(() => sp!.leave());
</script>

<Sheet {open} {onclose} label={t('player.syncplay.title')} width={400}>
  <div class="body">
    <h2 class="title-3">{t('player.syncplay.title')}</h2>
    {#if group}
      <p class="footnote">{t('player.syncplay.inGroup', { name: group.name })} · {t('player.syncplay.members', { count: group.members.length })}</p>
      <ul class="rows" aria-label={t('player.syncplay.members', { count: group.members.length })}>
        {#each group.members as m, i (i)}
          <li class="member"><Icon name="user" size={15} /> {m}</li>
        {/each}
      </ul>
      <button class="btn glass wide" data-autofocus aria-disabled={busy} onclick={leave}><Icon name="logout" size={15} /> {t('player.syncplay.leave')}</button>
    {:else}
      <p class="footnote">{t('player.syncplay.intro')}</p>
      <button class="btn light wide" data-autofocus aria-disabled={busy} onclick={create}><Icon name="plus" size={15} /> {t('player.syncplay.create')}</button>
      <h3 class="headline">{t('player.syncplay.groups')}</h3>
      {#if groups === null}
        <p class="footnote" aria-busy="true">…</p>
      {:else if groups.length === 0}
        <p class="footnote">{t('player.syncplay.none')}</p>
      {:else}
        <ul class="rows">
          {#each groups as g (g.id)}
            <li>
              <button aria-disabled={busy} onclick={() => join(g.id)}>
                <Icon name="users" size={15} />
                <span class="name">{g.name}</span>
                <span class="footnote">{t('player.syncplay.members', { count: g.members.length })} · {t('player.syncplay.join')}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0;
    padding-right: 40px;
  }
  h3 {
    margin: 18px 0 0;
  }
  .footnote {
    margin: 4px 0 0;
  }
  .wide {
    width: 100%;
    margin-top: 14px;
    justify-content: center;
  }
  .rows {
    list-style: none;
    margin: 10px -8px 0;
    padding: 0;
  }
  .rows button,
  .member {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .rows button:hover,
  .rows button:focus-visible {
    background: var(--fill-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rows .footnote {
    margin: 0;
  }
</style>
