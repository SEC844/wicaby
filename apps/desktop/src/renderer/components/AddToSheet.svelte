<script lang="ts">
  import type { BaseItem } from '../../shared/models';
  import { t } from '../lib/i18n.svelte';
  import { posterUrl } from '../lib/images';
  import { addTo, create, list, mediaTypeOf, type Kind } from '../lib/playlists';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // "Ajouter à une playlist / collection": pick an existing one or name a new one.
  // ids: a multi-selection of tracks (music spec C3), all of item's server and type.
  let { kind, item, ids, onclose }: { kind: Kind | null; item: BaseItem; ids?: string[]; onclose: () => void } = $props();

  let targets = $state<BaseItem[] | null>(null);
  let name = $state('');
  let busy = $state(false);
  const noun = $derived(kind === 'collection' ? 'collection' : 'playlist');

  $effect(() => {
    const k = kind;
    targets = null;
    name = '';
    if (!k) return;
    list(k, item.ServerId)
      .then((r) => {
        const type = mediaTypeOf(item);
        // A playlist keeps one media type; unknown types are offered anyway.
        targets = k === 'playlist' ? r.Items.filter((p) => !p.MediaType || p.MediaType === type) : r.Items;
      })
      .catch(() => (targets = []));
  });

  async function run(fn: () => Promise<unknown>, label: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await fn();
      toast('success', t('browse.addTo.added', { name: label }));
      onclose();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const n = name.trim();
    if (n && kind) void run(() => create(kind, n, item, ids), n);
  }
</script>

<Sheet open={kind !== null} {onclose} label={t('browse.addTo.title', { kind: noun })} width={440}>
  <div class="body">
    <h2 class="title-3">{t('browse.addTo.title', { kind: noun })}</h2>
    <p class="footnote">{ids && ids.length > 1 ? t('music.selection.count', { count: ids.length }) : item.Name}</p>

    <form class="new" onsubmit={submit}>
      <input class="field" bind:value={name} placeholder={t('browse.addTo.newPlaceholder', { kind: noun })} maxlength="120" aria-label={t('browse.addTo.newName', { kind: noun })} />
      <button class="btn primary" type="submit" disabled={busy || !name.trim()}><Icon name="plus" size={15} /> {t('browse.addTo.create')}</button>
    </form>

    {#if targets === null}
      <div class="sk skeleton"></div>
    {:else if targets.length > 0}
      <ul class="targets">
        {#each targets as target (target.Id)}
          {@const art = posterUrl(target, 96)}
          <li>
            <button disabled={busy} onclick={() => kind && run(() => addTo(kind, target.Id, item, ids), target.Name)}>
              <span class="art">{#if art}<img src={art} alt="" loading="lazy" decoding="async" />{:else}<Icon name={kind === 'collection' ? 'collection' : 'list'} size={16} />{/if}</span>
              <span class="t-name">{target.Name}</span>
              {#if target.ChildCount}<span class="t-count">{target.ChildCount}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="caption none">{t('browse.addTo.none', { kind: noun })}</p>
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
  .footnote {
    margin: 4px 0 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .new {
    display: flex;
    gap: 8px;
    margin: 18px 0 12px;
  }
  .new .field {
    flex: 1;
    height: 36px;
  }
  .targets {
    list-style: none;
    margin: 0 -8px;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  .targets button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 10px 0 8px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .targets button:hover,
  .targets button:focus-visible {
    background: var(--fill-2);
  }
  .art {
    width: 32px;
    height: 32px;
    flex: none;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--label-2);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .t-name {
    flex: 1;
    min-width: 0;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t-count {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .sk {
    height: 96px;
    border-radius: var(--r-sm);
  }
  .none {
    margin: 8px 0 0;
  }
</style>
