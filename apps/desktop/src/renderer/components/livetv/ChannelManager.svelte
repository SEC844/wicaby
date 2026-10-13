<script lang="ts">
  import { untrack } from 'svelte';
  import { nameKey } from '../../../shared/livetv/channel-order';
  import { t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { serverName } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import Toggle from '../Toggle.svelte';

  // "Gérer les chaînes" (§3.1, §6.5, LT-07, LT-20): favourite order (that order is the zap order of the
  // Favoris lens), hidden channels, client groups (Emby tags are listed read-only). Everything writes
  // the synced DisplayPreferences document through the store.
  let { store, open, onclose, channelId }: { store: LiveTvStore; open: boolean; onclose: () => void; channelId?: string } = $props();

  let filter = $state('');
  let editing = $state<string | null>(null); // client group whose members the list edits
  let newName = $state('');
  let dragId: string | null = null;

  $effect(() => {
    const id = open ? channelId : undefined;
    if (id) filter = untrack(() => store.channels.find((r) => r.id === id)?.name ?? '');
  });

  const favorites = $derived(store.favorites);
  const hiddenSet = $derived(new Set(store.prefs.hidden));
  const hiddenRows = $derived(store.channels.filter((r) => hiddenSet.has(r.id)));
  const tags = $derived(store.lenses.flatMap((l) => (l.kind === 'tag' ? [l.tag] : [])));
  const group = $derived(editing ? store.prefs.groups.find((g) => g.id === editing) : undefined);
  const matches = $derived.by(() => {
    const k = nameKey(filter);
    if (!k) return [];
    return store.channels.filter((r) => nameKey(r.name).includes(k) || r.number.startsWith(filter.trim())).slice(0, 50);
  });

  function move(id: string, to: number): void {
    const order = favorites.map((r) => r.id).filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
    store.reorderFavorites(order);
  }

  function favKey(e: KeyboardEvent, id: string, i: number): void {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(id, i + (e.key === 'ArrowUp' ? -1 : 1));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-fav="${CSS.escape(id)}"]`)?.focus());
  }

  function addGroup(): void {
    const name = newName.trim();
    if (!name) return;
    editing = store.createGroup(name);
    newName = '';
  }

  function toggleMember(id: string): void {
    if (!group) return;
    store.updateGroup(group.id, { ids: group.ids.includes(id) ? group.ids.filter((x) => x !== id) : [...group.ids, id] });
  }
</script>

<Sheet {open} {onclose} label={t('livetv.manage.title')} width={600}>
  <div class="mgr">
    <h2 class="title-3">{t('livetv.manage.title')}</h2>
    <p class="footnote">{t('livetv.manage.synced', { server: serverName(store.serverId) })}</p>

    <div class="line">
      <span>{t('livetv.sort.favoritesFirst')}</span>
      <Toggle checked={store.favFirst} onchange={(v) => store.setFavFirst(v)} label={t('livetv.sort.favoritesFirst')} />
    </div>

    {#if favorites.length}
      <section>
        <h3 class="headline">{t('livetv.manage.reorderFavorites')}</h3>
        <p class="footnote">{t('livetv.manage.reorderHint')}</p>
        <ol class="list">
          {#each favorites as r, i (r.id)}
            <li
              draggable={store.favoritesEditable}
              ondragstart={() => (dragId = r.id)}
              ondragover={(e) => e.preventDefault()}
              ondrop={(e) => (e.preventDefault(), dragId && dragId !== r.id && move(dragId, i), (dragId = null))}
            >
              <button class="item" data-fav={r.id} onkeydown={(e) => favKey(e, r.id, i)} disabled={!store.favoritesEditable}>
                <Icon name="grip" size={14} />
                <span class="num mono">{r.number}</span>
                <span class="name">{r.name}</span>
              </button>
              <button class="btn icon ghost" onclick={() => move(r.id, i - 1)} disabled={i === 0 || !store.favoritesEditable} aria-label={t('livetv.manage.moveUp')}><Icon name="arrowUp" size={14} /></button>
              <button class="btn icon ghost" onclick={() => move(r.id, i + 1)} disabled={i === favorites.length - 1 || !store.favoritesEditable} aria-label={t('livetv.manage.moveDown')}><Icon name="arrowDown" size={14} /></button>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    <section>
      <h3 class="headline">{t('livetv.manage.hidden')}</h3>
      <p class="footnote">{t('livetv.manage.hiddenCount', { count: hiddenRows.length })} · {t('livetv.manage.hiddenHint')}</p>
      {#if hiddenRows.length}
        <ul class="list">
          {#each hiddenRows as r (r.id)}
            <li>
              <span class="item static"><span class="num mono">{r.number}</span><span class="name">{r.name}</span></span>
              <button class="btn" onclick={() => store.setHidden(r.id, false)}>{t('livetv.channel.unhide')}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h3 class="headline">{t('livetv.lens.groups')}</h3>
      {#if tags.length}
        <h4 class="caption">{t('livetv.lens.serverGroups')}</h4>
        <ul class="list">
          {#each tags as tag (tag)}
            <li><span class="item static"><span class="name">{tag}</span><span class="caption">{t('livetv.manage.readOnly')}</span></span></li>
          {/each}
        </ul>
      {/if}
      <h4 class="caption">{t('livetv.lens.myGroups')}</h4>
      <ul class="list">
        {#each store.prefs.groups as g (g.id)}
          <li class:on={editing === g.id}>
            <input class="field" value={g.name} aria-label={t('livetv.manage.renameGroup')} onchange={(e) => e.currentTarget.value.trim() && store.updateGroup(g.id, { name: e.currentTarget.value.trim() })} />
            <button class="btn" aria-pressed={editing === g.id} onclick={() => (editing = editing === g.id ? null : g.id)}>{t('livetv.manage.members', { count: g.ids.length })}</button>
            <button class="btn icon ghost" onclick={() => (store.deleteGroup(g.id), editing === g.id && (editing = null))} aria-label={t('livetv.manage.deleteGroup')} title={t('livetv.manage.deleteGroup')}><Icon name="trash" size={14} /></button>
          </li>
        {/each}
        <li>
          <input class="field" bind:value={newName} placeholder={t('livetv.manage.groupName')} aria-label={t('livetv.manage.groupName')} onkeydown={(e) => e.key === 'Enter' && addGroup()} />
          <button class="btn" onclick={addGroup} disabled={!newName.trim()}><Icon name="plus" size={14} />{t('livetv.manage.newGroup')}</button>
        </li>
      </ul>
    </section>

    <section>
      <input class="field" type="search" bind:value={filter} placeholder={t('livetv.manage.filter')} aria-label={t('livetv.manage.filter')} />
      {#if matches.length}
        <ul class="list">
          {#each matches as r (r.id)}
            <li>
              <span class="item static"><span class="num mono">{r.number}</span><span class="name">{r.name}</span></span>
              {#if group}
                <Toggle checked={group.ids.includes(r.id)} onchange={() => toggleMember(r.id)} label={`${group.name}: ${r.name}`} />
              {/if}
              <button class="btn" onclick={() => store.setHidden(r.id, !hiddenSet.has(r.id))}>{t(hiddenSet.has(r.id) ? 'livetv.channel.unhide' : 'livetv.channel.hide')}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</Sheet>

<style>
  .mgr {
    display: grid;
    gap: 12px;
    padding: 24px 24px 20px;
    max-height: min(76vh, 720px);
    overflow-y: auto;
  }
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }
  section {
    display: grid;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--separator);
  }
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .list li.on {
    background: var(--fill-1);
    border-radius: var(--r-sm);
  }
  .item {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label-2);
  }
  button.item:is(:hover, :focus-visible) {
    background: var(--fill-4);
    color: var(--label);
  }
  .num {
    width: 36px;
    flex: none;
    color: var(--label-3);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .field {
    flex: 1;
    min-width: 0;
  }
  .btn[aria-pressed='true'] {
    background: var(--fill-4);
  }
</style>
