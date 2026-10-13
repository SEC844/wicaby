<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { w } from '../../lib/bridge';
  import { has, t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import ChipsInput from './ChipsInput.svelte';
  import {
    editableItem,
    editorInfo,
    fromDateInput,
    isJellyfin,
    lockableFields,
    namePairs,
    saveItem,
    toDateInput,
    type EditableItem,
    type MetadataEditorInfo,
    type Person,
  } from './metadata';

  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  const PERSON_TYPES = ['Actor', 'GuestStar', 'Director', 'Writer', 'Producer', 'Composer'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MAIN_PROVIDERS = ['Imdb', 'Tmdb', 'Tvdb'];

  interface Row extends Person {
    key: number;
  }

  let dto = $state<EditableItem | null>(null);
  let info = $state<MetadataEditorInfo>({});
  let error = $state('');
  let saving = $state(false);
  let seq = 0;

  // Form state, filled from the DTO.
  let f = $state({
    name: '',
    originalTitle: '',
    sortName: '',
    tagline: '',
    overview: '',
    year: '',
    premiere: '',
    end: '',
    officialRating: '',
    community: '',
    critic: '',
    index: '',
    parentIndex: '',
    status: '',
    airTime: '',
    lockData: false,
  });
  let genres = $state<string[]>([]);
  let studios = $state<string[]>([]);
  let tags = $state<string[]>([]);
  let people = $state<Row[]>([]);
  let airDays = $state<string[]>([]);
  let providers = $state<{ key: string; value: string }[]>([]);
  let locked = $state<string[]>([]);

  const sid = $derived(item.ServerId);
  const lockable = $derived(lockableFields(sid));
  const isEpisode = $derived(item.Type === 'Episode');
  const isSeries = $derived(item.Type === 'Series');
  const ratings = $derived([
    { value: '', label: t('adminMetadata.edit.noRating') },
    ...[...new Set([...(info.ParentalRatingOptions ?? []).map((r) => r.Name), ...(f.officialRating ? [f.officialRating] : [])])].map((n) => ({ value: n, label: n })),
  ]);

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      dto = null;
      error = '';
      const it = item;
      Promise.all([editableItem(it), editorInfo(it)])
        .then(([d, i]) => {
          info = i;
          fill(d);
          dto = d;
        })
        .catch((err) => (error = errorMessage(err)));
    });
  });

  function fill(d: EditableItem): void {
    const num = (n: number | undefined | null) => (n === undefined || n === null ? '' : String(n));
    f = {
      name: d.Name ?? '',
      originalTitle: d.OriginalTitle ?? '',
      sortName: d.ForcedSortName ?? '',
      tagline: d.Taglines?.[0] ?? '',
      overview: d.Overview ?? '',
      year: num(d.ProductionYear),
      premiere: toDateInput(d.PremiereDate),
      end: toDateInput(d.EndDate),
      officialRating: d.OfficialRating ?? '',
      community: num(d.CommunityRating),
      critic: num(d.CriticRating),
      index: num(d.IndexNumber),
      parentIndex: num(d.ParentIndexNumber),
      status: d.Status ?? '',
      airTime: d.AirTime ?? '',
      lockData: d.LockData === true,
    };
    genres = [...(d.Genres ?? d.GenreItems?.map((g) => g.Name) ?? [])];
    studios = (d.Studios ?? []).map((s) => s.Name);
    tags = [...(d.TagItems?.map((x) => x.Name) ?? d.Tags ?? [])];
    people = (d.People ?? []).map((p) => ({ ...p, key: ++seq }));
    airDays = [...(d.AirDays ?? [])];
    const ids = d.ProviderIds ?? {};
    const keys = [...MAIN_PROVIDERS, ...Object.keys(ids).filter((k) => !MAIN_PROVIDERS.some((m) => m.toLowerCase() === k.toLowerCase()))];
    providers = keys.map((key) => {
      const actual = Object.keys(ids).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
      return { key: actual, value: ids[actual] ?? '' };
    });
    locked = [...(d.LockedFields ?? [])];
  }

  function providerUrl(key: string, value: string): string | null {
    if (!value.trim()) return null;
    const fromServer = info.ExternalIdInfos?.find((x) => x.Key.toLowerCase() === key.toLowerCase() && x.UrlFormatString);
    const v = encodeURIComponent(value.trim());
    if (fromServer?.UrlFormatString) return fromServer.UrlFormatString.replace('{0}', v);
    const k = key.toLowerCase();
    const tv = item.Type === 'Series' || item.Type === 'Season' || item.Type === 'Episode';
    if (k === 'imdb') return `https://www.imdb.com/${item.Type === 'Person' ? 'name' : 'title'}/${v}`;
    if (k === 'tmdb') return `https://www.themoviedb.org/${item.Type === 'Person' ? 'person' : tv ? 'tv' : item.Type === 'BoxSet' ? 'collection' : 'movie'}/${v}`;
    if (k === 'tvdb') return `https://thetvdb.com/dereferrer/${item.Type === 'Episode' ? 'episode' : item.Type === 'Person' ? 'person' : tv ? 'series' : 'movie'}/${v}`;
    return null;
  }

  function toggleLock(field: string): void {
    locked = locked.includes(field) ? locked.filter((x) => x !== field) : [...locked, field];
  }

  function move(i: number, d: number): void {
    const j = i + d;
    if (j < 0 || j >= people.length) return;
    const next = [...people];
    [next[i], next[j]] = [next[j], next[i]];
    people = next;
  }

  const int = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Math.trunc(Number(s)));
  const float = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s.replace(',', '.'))) ? null : Number(s.replace(',', '.')));

  async function save(): Promise<void> {
    if (!dto || saving) return;
    if (!f.name.trim()) {
      error = t('adminMetadata.edit.nameRequired');
      return;
    }
    saving = true;
    error = '';
    const jelly = isJellyfin(sid);
    const providerIds: Record<string, string> = {};
    for (const p of providers) if (p.value.trim()) providerIds[p.key] = p.value.trim();
    const out: Record<string, unknown> = {
      ...$state.snapshot(dto),
      Name: f.name.trim(),
      OriginalTitle: f.originalTitle.trim(),
      ForcedSortName: f.sortName.trim(),
      Taglines: f.tagline.trim() ? [f.tagline.trim()] : [],
      Overview: f.overview,
      ProductionYear: int(f.year) ?? undefined,
      PremiereDate: fromDateInput(f.premiere),
      EndDate: fromDateInput(f.end),
      OfficialRating: f.officialRating,
      CommunityRating: float(f.community) ?? undefined,
      CriticRating: float(f.critic) ?? undefined,
      Genres: [...genres],
      Studios: namePairs(studios, dto.Studios),
      Tags: [...tags],
      People: people.filter((p) => p.Name.trim()).map(({ key: _k, ...p }) => ({ ...p, Name: p.Name.trim(), Role: p.Role?.trim() || undefined })),
      ProviderIds: providerIds,
      LockData: f.lockData,
      LockedFields: locked.filter((x) => lockable.includes(x)),
    };
    // Fields cleared in the form are sent as null so the server clears them too.
    for (const k of ['ProductionYear', 'PremiereDate', 'EndDate', 'CommunityRating', 'CriticRating'] as const) if (out[k] === undefined) out[k] = null;
    // Emby's newer DTOs carry the id lists too; keep them in step with the names.
    if (!jelly && dto.GenreItems) out.GenreItems = namePairs(genres, dto.GenreItems);
    if (!jelly && dto.TagItems) out.TagItems = namePairs(tags, dto.TagItems);
    if (isEpisode) {
      out.IndexNumber = int(f.index);
      out.ParentIndexNumber = int(f.parentIndex);
    }
    if (isSeries) {
      out.Status = f.status || null;
      out.AirDays = [...airDays];
      out.AirTime = f.airTime.trim();
    }
    try {
      await saveItem(item, out as EditableItem);
      toast('success', t('adminMetadata.edit.saved'));
      onclose();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet lbl(text: string, field?: string)}
  <span class="am-l">
    {text}
    {#if field && lockable.includes(field)}
      {@const on = locked.includes(field)}
      <button
        type="button"
        class="lock"
        class:on
        aria-pressed={on}
        title={on ? t('adminMetadata.edit.unlockField') : t('adminMetadata.edit.lockField')}
        aria-label={on ? t('adminMetadata.edit.unlockField') : t('adminMetadata.edit.lockField')}
        onclick={() => toggleLock(field)}
      >
        <Icon name={on ? 'lock' : 'unlock'} size={12} />
      </button>
    {/if}
  </span>
{/snippet}

<AdminSheet {open} {onclose} title={t('adminMetadata.edit.title')} subtitle={item.Name} width={760}>
  {#if !dto}
    {#if error}
      <p class="am-error">{error}</p>
    {:else}
      <div class="sk skeleton"></div>
    {/if}
  {:else}
    <h3 class="a-gh">{t('adminMetadata.edit.general')}</h3>
    <div class="am-grid">
      <label class="am-f wide">{@render lbl(t('adminMetadata.edit.name'), 'Name')}<input class="field" bind:value={f.name} maxlength="400" data-autofocus /></label>
      <label class="am-f">{@render lbl(t('adminMetadata.edit.originalTitle'), 'OriginalTitle')}<input class="field" bind:value={f.originalTitle} maxlength="400" /></label>
      <label class="am-f">{@render lbl(t('adminMetadata.edit.sortName'), 'SortName')}<input class="field" bind:value={f.sortName} maxlength="400" placeholder={dto.SortName ?? ''} /></label>
      <label class="am-f wide">{@render lbl(t('adminMetadata.edit.tagline'), 'Tagline')}<input class="field" bind:value={f.tagline} maxlength="400" /></label>
      <label class="am-f wide">{@render lbl(t('adminMetadata.edit.overview'), 'Overview')}<textarea class="field" bind:value={f.overview} rows="5"></textarea></label>
    </div>

    {#if isEpisode}
      <h3 class="a-gh">{t('adminMetadata.edit.episode')}</h3>
      <div class="am-grid three">
        <label class="am-f">{@render lbl(t('adminMetadata.edit.season'))}<input class="field mono" type="number" min="0" bind:value={f.parentIndex} /></label>
        <label class="am-f">{@render lbl(t('adminMetadata.edit.episodeNumber'))}<input class="field mono" type="number" min="0" bind:value={f.index} /></label>
        <label class="am-f">{@render lbl(t('adminMetadata.edit.airDate'))}<input class="field mono" type="date" bind:value={f.premiere} /></label>
      </div>
    {/if}

    {#if isSeries}
      <h3 class="a-gh">{t('adminMetadata.edit.series')}</h3>
      <div class="am-grid">
        <div class="am-f">
          {@render lbl(t('adminMetadata.edit.status'))}
          <Picker
            label={t('adminMetadata.edit.status')}
            value={f.status}
            options={[
              { value: '', label: t('adminMetadata.edit.statusUnknown') },
              { value: 'Continuing', label: t('adminMetadata.edit.statusContinuing') },
              { value: 'Ended', label: t('adminMetadata.edit.statusEnded') },
            ]}
            onchange={(v) => (f.status = v)}
          />
        </div>
        <label class="am-f">{@render lbl(t('adminMetadata.edit.airTime'))}<input class="field mono" bind:value={f.airTime} placeholder="20:45" maxlength="20" /></label>
        <div class="am-f wide">
          {@render lbl(t('adminMetadata.edit.airDays'))}
          <div class="days" role="group" aria-label={t('adminMetadata.edit.airDays')}>
            {#each DAYS as d (d)}
              {@const on = airDays.includes(d)}
              <button type="button" class:on aria-pressed={on} onclick={() => (airDays = on ? airDays.filter((x) => x !== d) : [...airDays, d])}>
                {t(`adminMetadata.days.${d}`)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <h3 class="a-gh">{t('adminMetadata.edit.datesRatings')}</h3>
    <div class="am-grid three">
      <label class="am-f">{@render lbl(t('adminMetadata.edit.year'))}<input class="field mono" type="number" min="1800" max="2200" bind:value={f.year} /></label>
      {#if !isEpisode}
        <label class="am-f">{@render lbl(t('adminMetadata.edit.premiere'))}<input class="field mono" type="date" bind:value={f.premiere} /></label>
      {/if}
      {#if !isEpisode && item.Type !== 'Movie'}
        <label class="am-f">{@render lbl(t('adminMetadata.edit.endDate'))}<input class="field mono" type="date" bind:value={f.end} /></label>
      {/if}
      <div class="am-f">
        {@render lbl(t('adminMetadata.edit.officialRating'), 'OfficialRating')}
        <Picker label={t('adminMetadata.edit.officialRating')} value={f.officialRating} options={ratings} onchange={(v) => (f.officialRating = v)} />
      </div>
      <label class="am-f">{@render lbl(t('adminMetadata.edit.communityRating'), 'CommunityRating')}<input class="field mono" type="number" min="0" max="10" step="0.1" bind:value={f.community} placeholder="0–10" /></label>
      <label class="am-f">{@render lbl(t('adminMetadata.edit.criticRating'), 'CriticRating')}<input class="field mono" type="number" min="0" max="100" step="1" bind:value={f.critic} placeholder="0–100" /></label>
    </div>

    <h3 class="a-gh">{t('adminMetadata.edit.classification')}</h3>
    <div class="am-grid">
      <div class="am-f wide">{@render lbl(t('adminMetadata.edit.genres'), 'Genres')}<ChipsInput bind:values={genres} label={t('adminMetadata.edit.genres')} placeholder={t('adminMetadata.edit.addGenre')} /></div>
      <div class="am-f wide">{@render lbl(t('adminMetadata.edit.studios'), 'Studios')}<ChipsInput bind:values={studios} label={t('adminMetadata.edit.studios')} placeholder={t('adminMetadata.edit.addStudio')} /></div>
      <div class="am-f wide">{@render lbl(t('adminMetadata.edit.tags'), 'Tags')}<ChipsInput bind:values={tags} label={t('adminMetadata.edit.tags')} placeholder={t('adminMetadata.edit.addTag')} /></div>
    </div>

    <h3 class="a-gh people-h">
      {@render lbl(t('adminMetadata.edit.people'), 'Cast')}
    </h3>
    <div class="a-group">
      {#each people as p, i (p.key)}
        <div class="a-row compact person">
          <input class="field" bind:value={p.Name} placeholder={t('adminMetadata.edit.personName')} aria-label={t('adminMetadata.edit.personName')} maxlength="200" />
          <input class="field" bind:value={p.Role} placeholder={t('adminMetadata.edit.personRole')} aria-label={t('adminMetadata.edit.personRole')} maxlength="200" />
          <Picker
            label={t('adminMetadata.edit.personType')}
            value={p.Type ?? 'Actor'}
            options={[...new Set([...PERSON_TYPES, p.Type ?? 'Actor'])].map((v) => ({ value: v, label: has(`adminMetadata.personTypes.${v}`) ? t(`adminMetadata.personTypes.${v}`) : v }))}
            onchange={(v) => (p.Type = v)}
          />
          <div class="a-actions">
            <button type="button" class="a-push icon" disabled={i === 0} aria-label={t('adminMetadata.common.moveUp')} title={t('adminMetadata.common.moveUp')} onclick={() => move(i, -1)}><Icon name="arrowUp" size={14} /></button>
            <button type="button" class="a-push icon" disabled={i === people.length - 1} aria-label={t('adminMetadata.common.moveDown')} title={t('adminMetadata.common.moveDown')} onclick={() => move(i, 1)}><Icon name="arrowDown" size={14} /></button>
            <button type="button" class="a-push icon" aria-label={t('adminMetadata.common.remove')} title={t('adminMetadata.common.remove')} onclick={() => (people = people.filter((x) => x.key !== p.key))}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      {:else}
        <div class="a-row compact"><span class="a-lbl soft">{t('adminMetadata.edit.noPeople')}</span></div>
      {/each}
      <div class="a-row compact">
        <button type="button" class="a-push ghost" onclick={() => (people = [...people, { key: ++seq, Name: '', Role: '', Type: 'Actor' }])}>
          <Icon name="plus" size={14} />
          {t('adminMetadata.edit.addPerson')}
        </button>
      </div>
    </div>

    <h3 class="a-gh">{t('adminMetadata.edit.externalIds')}</h3>
    <div class="am-grid three">
      {#each providers as p (p.key)}
        {@const url = providerUrl(p.key, p.value)}
        <div class="am-f">
          <span class="am-l">
            {info.ExternalIdInfos?.find((x) => x.Key.toLowerCase() === p.key.toLowerCase())?.Name ?? p.key}
            {#if url}
              <button type="button" class="ext" title={t('adminMetadata.edit.openLink')} aria-label={t('adminMetadata.edit.openLink')} onclick={() => w.app.openExternal(url)}>
                <Icon name="externalLink" size={12} />
              </button>
            {/if}
          </span>
          <input class="field mono" bind:value={p.value} maxlength="100" aria-label={p.key} />
        </div>
      {/each}
    </div>

    <h3 class="a-gh">{t('adminMetadata.edit.locking')}</h3>
    <div class="a-group">
      <div class="a-row">
        <div class="a-txt">
          <span class="a-lbl">{t('adminMetadata.edit.lockItem')}</span>
          <span class="a-desc">{t('adminMetadata.edit.lockItemHint')}</span>
        </div>
        <Toggle checked={f.lockData} label={t('adminMetadata.edit.lockItem')} onchange={(v) => (f.lockData = v)} />
      </div>
      <div class="a-row">
        <div class="a-txt">
          <span class="a-lbl">{t('adminMetadata.edit.lockedFields')}</span>
          <span class="a-desc">{t('adminMetadata.edit.lockedFieldsHint')}</span>
          <div class="locks">
            {#each lockable as field (field)}
              {@const on = locked.includes(field)}
              <button type="button" class:on aria-pressed={on} onclick={() => toggleLock(field)}>
                <Icon name={on ? 'lock' : 'unlock'} size={12} />
                {t(`adminMetadata.fields.${field}`)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>

    {#if error}<p class="am-error">{error}</p>{/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn ghost" onclick={onclose}>{t('adminMetadata.common.cancel')}</button>
    <button type="button" class="btn primary" disabled={!dto || saving} onclick={save}>
      {saving ? t('adminMetadata.common.saving') : t('adminMetadata.common.save')}
    </button>
  {/snippet}
</AdminSheet>

<style>
  .sk {
    height: 420px;
    border-radius: var(--r-md);
  }
  .lock,
  .ext {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-3);
  }
  .lock:hover,
  .lock:focus-visible,
  .ext:hover,
  .ext:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .lock.on {
    color: var(--label);
  }
  .people-h :global(.am-l) {
    font-size: inherit;
    color: inherit;
  }
  .person :global(.field) {
    height: 32px;
    padding: 0 10px;
  }
  .person > input:first-child {
    flex: 1.2;
  }
  .person > input:nth-child(2) {
    flex: 1;
  }
  .days,
  .locks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .locks {
    margin-top: 10px;
  }
  .days button,
  .locks button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 11px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-callout);
    color: var(--label-2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .days button:hover,
  .days button:focus-visible,
  .locks button:hover,
  .locks button:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .days button.on,
  .locks button.on {
    background: var(--accent-soft);
    color: var(--label);
  }
</style>
