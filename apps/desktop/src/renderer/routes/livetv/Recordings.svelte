<script lang="ts">
  import { onMount } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import Card from '../../components/Card.svelte';
  import Icon from '../../components/Icon.svelte';
  import { checkRecordPolicy, dvrToast, dvrWritten } from '../../components/livetv/RecordOptionsSheet.svelte';
  import Row from '../../components/Row.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import { fmt, t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { toast } from '../../lib/stores.svelte';

  // "Enregistrements" (§9.5): grouped on the client into En cours, Récemment enregistrés, Séries (by
  // show), Films, Sport and Autres. Delete: "Sélectionner" (or Ctrl/Shift-click a card) lists them with
  // check boxes, Shift-click selects a range; one confirmation, serialized DELETEs, one summary toast.
  let { store }: { store: LiveTvStore } = $props();

  type Rec = BaseItem & { Status?: string; IsSeries?: boolean; IsMovie?: boolean; IsSports?: boolean; DateCreated?: string; SeriesName?: string; StartDate?: string };
  let loaded = $state(false);
  let selecting = $state(false);
  let selected = $state(new Set<string>());
  let anchor = -1;
  let confirming = $state(false);
  let busy = $state(false);
  const RECENT = 20;

  const items = $derived(store.dvr.recordings.map((d) => ({ ...d, ServerId: store.serverId }) as unknown as Rec));
  const sections = $derived.by(() => {
    const done = items.filter((r) => r.Status !== 'InProgress');
    const shows = new Map<string, Rec[]>();
    for (const r of done.filter((x) => x.IsSeries)) {
      const key = r.SeriesId ?? r.SeriesName ?? r.Name ?? '';
      shows.set(key, [...(shows.get(key) ?? []), r]);
    }
    return {
      inProgress: items.filter((r) => r.Status === 'InProgress'),
      recent: [...done].sort((a, b) => Date.parse(b.DateCreated ?? '') - Date.parse(a.DateCreated ?? '')).slice(0, RECENT),
      shows: [...shows.values()].map((eps) => [eps[0].SeriesName ?? eps[0].Name ?? '', eps] as const).sort((a, b) => fmt.compare(a[0], b[0])),
      movies: done.filter((r) => !r.IsSeries && r.IsMovie),
      sports: done.filter((r) => !r.IsSeries && !r.IsMovie && r.IsSports),
      other: done.filter((r) => !r.IsSeries && !r.IsMovie && !r.IsSports),
    };
  });
  // The selection list: newest first.
  const flat = $derived([...items].sort((a, b) => Date.parse(b.DateCreated ?? '') - Date.parse(a.DateCreated ?? '')));
  const chosen = $derived(flat.filter((r) => selected.has(r.Id)));

  onMount(() => {
    checkRecordPolicy(store);
    void store.dvr
      .loadRecordings()
      .catch(() => undefined)
      .finally(() => (loaded = true));
  });

  function pick(i: number, e: MouseEvent | KeyboardEvent): void {
    const next = new Set(selected);
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      for (const r of flat.slice(a, b + 1)) next.add(r.Id);
    } else if (next.has(flat[i].Id)) next.delete(flat[i].Id);
    else next.add(flat[i].Id);
    anchor = i;
    selected = next;
  }

  // Ctrl/Shift-click on a card starts a selection with it instead of opening it.
  function cardClick(e: MouseEvent): void {
    if (!store.dvr.canRecord || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const href = (e.target as HTMLElement).closest('a[href]')?.getAttribute('href') ?? '';
    const id = href.split('/').pop() ?? '';
    const i = flat.findIndex((r) => r.Id === id);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    selecting = true;
    selected = new Set([id]);
    anchor = i;
  }

  function stop(): void {
    selecting = false;
    selected = new Set();
    anchor = -1;
  }

  async function remove(): Promise<void> {
    if (busy) return;
    busy = true;
    let done = 0;
    try {
      // One at a time: the server deletes files, and a failure stops the rest.
      for (const r of chosen) {
        await store.dvr.deleteRecording(r.Id);
        done++;
      }
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
      confirming = false;
      if (done) {
        dvrWritten(store);
        toast('success', t('livetv.toasts.recordingsDeleted', { count: done }));
      }
      stop();
    }
  }
</script>

<div class="recs" role="presentation" onclickcapture={cardClick}>
  {#if store.dvr.canRecord && items.length}
    <div class="bar">
      {#if selecting}
        <button class="btn" onclick={stop}>{t('common.actions.cancel')}</button>
        <button class="btn danger" disabled={!chosen.length} onclick={() => (confirming = true)}><Icon name="trash" size={15} />{t('common.actions.delete')} <span class="mono">{chosen.length}</span></button>
      {:else}
        <button class="btn" onclick={() => (selecting = true)}>{t('livetv.recordings.select')}</button>
      {/if}
    </div>
  {/if}

  {#if selecting}
    <ul class="list" aria-label={t('livetv.recordings.select')}>
      {#each flat as r, i (r.Id)}
        <li>
          <label>
            <input type="checkbox" checked={selected.has(r.Id)} onclick={(e) => pick(i, e)} />
            <span class="name">{r.SeriesName && r.SeriesName !== r.Name ? `${r.SeriesName} · ${r.Name}` : r.Name}</span>
            <span class="when mono">{r.DateCreated ? fmt.day(r.DateCreated) : ''}</span>
          </label>
        </li>
      {/each}
    </ul>
  {:else}
    {#if sections.inProgress.length}<Row title={t('livetv.recordings.sections.inProgress')} items={sections.inProgress} variant="thumb" />{/if}
    {#if sections.recent.length}<Row title={t('livetv.recordings.sections.recent')} items={sections.recent} variant="thumb" />{/if}
    {#if sections.shows.length}
      <h2 class="sec">{t('livetv.recordings.sections.series')}</h2>
      {#each sections.shows as [name, eps] (name)}
        <Row title={`${name} · ${t('livetv.recordings.episodes', { count: eps.length })}`} items={eps} variant="thumb" />
      {/each}
    {/if}
    {#if sections.movies.length}<Row title={t('livetv.recordings.sections.movies')} items={sections.movies} />{/if}
    {#if sections.sports.length}<Row title={t('livetv.recordings.sections.sports')} items={sections.sports} variant="thumb" />{/if}
    {#if sections.other.length}
      <h2 class="sec">{t('livetv.recordings.sections.other')}</h2>
      <div class="grid">
        {#each sections.other as r (r.Id)}<Card item={r} variant="thumb" />{/each}
      </div>
    {/if}
  {/if}
  {#if loaded && !items.length}
    <div class="state"><Icon name="record" size={36} /><p class="footnote">{t('livetv.recordings.empty')}</p></div>
  {/if}
</div>

<Sheet open={confirming} onclose={() => (confirming = false)} label={t('livetv.recordings.delete')} width={440}>
  <div class="confirm">
    <p>{chosen.length === 1 ? t('livetv.recordings.deleteConfirm', { name: chosen[0].Name ?? '' }) : t('livetv.recordings.deleteMany', { count: chosen.length })}</p>
    <div class="c-acts">
      <button class="btn" data-autofocus onclick={() => (confirming = false)}>{t('common.actions.cancel')}</button>
      <button class="btn danger" disabled={busy} onclick={remove}>{t('common.actions.delete')}</button>
    </div>
  </div>
</Sheet>

<style>
  .recs {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  /* Rows bring their own gutter; the page has one already. */
  .recs > :global(section.row) {
    margin-inline: calc(-1 * var(--gutter));
  }
  .bar {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .sec {
    margin: 18px 0 10px;
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.016em;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(220px, 17vw, 300px), 1fr));
    gap: 28px clamp(14px, 1.3vw, 22px);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 6px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
  }
  .list li + li {
    box-shadow: 0 -1px 0 var(--separator);
  }
  label {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    color: var(--label);
    cursor: pointer;
  }
  label:hover {
    background: var(--fill-1);
  }
  input {
    accent-color: var(--label);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 80px 0;
    color: var(--label-3);
  }
  .confirm {
    display: grid;
    gap: 14px;
    padding: 24px 24px 20px;
  }
  .confirm p {
    margin: 0;
    padding-right: 24px;
  }
  .c-acts {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
</style>
