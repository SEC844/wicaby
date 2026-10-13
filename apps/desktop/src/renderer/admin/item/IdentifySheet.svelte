<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Icon from '../../components/Icon.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import { applyRemote, remoteSearch, remoteSrc, type RemoteSearchResult } from './metadata';

  // "Identifier": search the metadata providers by name, year or provider id,
  // then apply the chosen match (the server refreshes the item from it).
  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  let name = $state('');
  let year = $state('');
  let imdb = $state('');
  let tmdb = $state('');
  let tvdb = $state('');
  // Replacing artwork is opt-in: an identify should not silently drop custom images.
  let replaceImages = $state(false);
  let results = $state<RemoteSearchResult[] | null>(null);
  let searching = $state(false);
  let applying = $state<RemoteSearchResult | null>(null);
  let error = $state('');

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      const ids = item.ProviderIds ?? {};
      const pid = (k: string) => Object.entries(ids).find(([key]) => key.toLowerCase() === k)?.[1] ?? '';
      name = item.Name ?? '';
      year = item.ProductionYear ? String(item.ProductionYear) : '';
      imdb = pid('imdb');
      tmdb = pid('tmdb');
      tvdb = pid('tvdb');
      replaceImages = false;
      results = null;
      error = '';
    });
  });

  async function search(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (searching) return;
    searching = true;
    error = '';
    const ProviderIds: Record<string, string> = {};
    if (imdb.trim()) ProviderIds.Imdb = imdb.trim();
    if (tmdb.trim()) ProviderIds.Tmdb = tmdb.trim();
    if (tvdb.trim()) ProviderIds.Tvdb = tvdb.trim();
    try {
      results = await remoteSearch(item, { Name: name.trim() || undefined, Year: Number(year) || undefined, ProviderIds });
    } catch (err) {
      error = errorMessage(err);
      results = [];
    } finally {
      searching = false;
    }
  }

  async function apply(r: RemoteSearchResult): Promise<void> {
    if (applying) return;
    applying = r;
    try {
      await applyRemote(item, $state.snapshot(r) as RemoteSearchResult, replaceImages);
      toast('success', t('adminMetadata.identify.applied', { name: r.Name }));
      onclose();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      applying = null;
    }
  }

  const ids = (r: RemoteSearchResult) =>
    Object.entries(r.ProviderIds ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
</script>

<AdminSheet {open} {onclose} title={t('adminMetadata.identify.title')} subtitle={item.Name} width={680}>
  <form class="am-grid q" onsubmit={search}>
    <label class="am-f wide"><span class="am-l">{t('adminMetadata.identify.name')}</span><input class="field" bind:value={name} maxlength="300" data-autofocus /></label>
    <label class="am-f"><span class="am-l">{t('adminMetadata.identify.year')}</span><input class="field mono" type="number" min="1800" max="2200" bind:value={year} /></label>
    <label class="am-f"><span class="am-l">IMDb</span><input class="field mono" bind:value={imdb} placeholder="tt0000000" maxlength="40" /></label>
    <label class="am-f"><span class="am-l">TMDb</span><input class="field mono" bind:value={tmdb} maxlength="40" /></label>
    <label class="am-f"><span class="am-l">TVDb</span><input class="field mono" bind:value={tvdb} maxlength="40" /></label>
    <div class="wide row">
      <label class="am-check opt">
        <span class="callout">{t('adminMetadata.identify.replaceImages')}</span>
        <Toggle checked={replaceImages} label={t('adminMetadata.identify.replaceImages')} onchange={(v) => (replaceImages = v)} />
      </label>
      <button class="btn primary" type="submit" disabled={searching}><Icon name="search" size={15} /> {searching ? t('adminMetadata.identify.searching') : t('adminMetadata.identify.search')}</button>
    </div>
  </form>

  {#if error}<p class="am-error">{error}</p>{/if}

  {#if searching && !results}
    <div class="sk skeleton"></div>
  {:else if results}
    {#if results.length === 0}
      <p class="am-empty">{t('adminMetadata.identify.none')}</p>
    {:else}
      <h3 class="a-gh">{t('adminMetadata.identify.results', { n: results.length })}</h3>
      <ul class="results">
        {#each results as r, i (i)}
          {@const art = remoteSrc(r.ImageUrl)}
          <li>
            <button type="button" disabled={applying !== null} onclick={() => apply(r)}>
              <span class="art">
                {#if art}<img src={art} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add('in')} />{:else}<Icon name="film" size={18} />{/if}
              </span>
              <span class="txt">
                <span class="headline">{r.Name}{#if r.ProductionYear}<span class="year">&nbsp;({r.ProductionYear})</span>{/if}</span>
                {#if r.SearchProviderName}<span class="caption">{r.SearchProviderName}</span>{/if}
                {#if r.Overview}<span class="ov footnote">{r.Overview}</span>{/if}
                {#if ids(r)}<span class="caption mono">{ids(r)}</span>{/if}
              </span>
              <span class="go">{applying === r ? t('adminMetadata.identify.applying') : t('adminMetadata.identify.apply')}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</AdminSheet>

<style>
  .q {
    margin-top: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .opt {
    gap: 12px;
    justify-content: flex-start;
  }
  .sk {
    height: 240px;
    margin-top: 18px;
    border-radius: var(--r-md);
  }
  .results {
    list-style: none;
    margin: 0 -10px;
    padding: 0;
  }
  .results button {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 10px;
    border-radius: var(--r-md);
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .results button:hover,
  .results button:focus-visible {
    background: var(--fill-2);
  }
  .results button:hover .go,
  .results button:focus-visible .go {
    opacity: 1;
  }
  .art {
    flex: none;
    width: 64px;
    aspect-ratio: 2 / 3;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    color: var(--label-3);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .art img:global(.in) {
    opacity: 1;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .year {
    font-weight: 400;
    color: var(--label-2);
  }
  .ov {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .go {
    flex: none;
    align-self: center;
    padding: 0 12px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: var(--fill-3);
    font-size: var(--fs-callout);
    font-weight: 560;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
</style>
