<script lang="ts">
  // Edit one library: name, folders and LibraryOptions. The draft is the
  // server's own options object, so fields Wicaby does not show are posted back
  // untouched. A field is shown only when this server kind has it and the
  // server sent it.
  import { untrack } from 'svelte';
  import type { ServerKind } from '../../../shared/contract';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import FolderBrowser from './FolderBrowser.svelte';
  import {
    contentType,
    fetcherRows,
    isVideoType,
    setFetcherRows,
    setSubtitleRows,
    subtitleRows,
    type AvailableOptions,
    type FetcherRow,
    type LibraryAdmin,
    type LibraryOptions,
    type VirtualFolder,
  } from './libraryAdmin';

  type Opt = { value: string; label: string };

  let {
    open,
    admin,
    kind,
    folder,
    serverName,
    languages,
    countries,
    subtitleLanguages,
    onclose,
    onsaved,
  }: {
    open: boolean;
    admin: LibraryAdmin;
    kind: ServerKind;
    folder: VirtualFolder | null;
    serverName: string;
    languages: Opt[];
    countries: Opt[];
    subtitleLanguages: Opt[];
    onclose: () => void;
    onsaved: () => void;
  } = $props();

  type Tab = 'general' | 'metadata' | 'scan' | 'subtitles' | 'series';

  let tab = $state<Tab>('general');
  let name = $state('');
  let paths = $state<string[]>([]);
  let draft = $state<LibraryOptions>({});
  let available = $state<AvailableOptions | null>(null);
  let fetcherType = $state('');
  let browsing = $state(false);
  let saving = $state(false);

  const type = $derived(folder ? contentType(folder) : 'mixed');
  const series = $derived(type === 'tvshows' || type === 'mixed');
  const video = $derived(isVideoType(type));

  // Load a fresh draft each time the sheet opens on a folder.
  $effect(() => {
    if (!open || !folder) return;
    const f = folder;
    untrack(() => reset(f));
  });

  function reset(f: VirtualFolder): void {
    tab = 'general';
    name = f.Name;
    paths = [...(f.Locations ?? [])];
    draft = ($state.snapshot(f.LibraryOptions) ?? {}) as LibraryOptions;
    available = null;
    admin
      .availableOptions(contentType(f), false)
      .then((a) => {
        available = a;
        fetcherType = a?.TypeOptions?.[0]?.Type ?? '';
      })
      .catch(() => (available = { TypeOptions: [] }));
  }

  const tabs = $derived(
    [
      { value: 'general' as Tab, label: t('adminLibraries.editor.tabs.general') },
      { value: 'metadata' as Tab, label: t('adminLibraries.editor.tabs.metadata') },
      { value: 'scan' as Tab, label: t('adminLibraries.editor.tabs.scan') },
      ...(video ? [{ value: 'subtitles' as Tab, label: t('adminLibraries.editor.tabs.subtitles') }] : []),
      ...(series ? [{ value: 'series' as Tab, label: t('adminLibraries.editor.tabs.series') }] : []),
    ],
  );

  // A field this server kind knows and this server sent.
  const known = (key: string, only?: ServerKind) => (!only || only === kind) && key in draft;
  const bool = (key: string) => draft[key] === true;
  const setv = (key: string, v: unknown) => (draft[key] = v);

  // Two booleans as one three-way choice: off, scheduled task, during the library scan.
  type Mode = 'off' | 'task' | 'scan';
  const modeOf = (on: string, scan: string): Mode => (!bool(on) ? 'off' : bool(scan) ? 'scan' : 'task');
  function setMode(on: string, scan: string, m: Mode): void {
    draft[on] = m !== 'off';
    draft[scan] = m === 'scan';
  }
  const modeOptions = $derived<{ value: Mode; label: string }[]>([
    { value: 'off', label: t('adminLibraries.editor.mode.off') },
    { value: 'task', label: t('adminLibraries.editor.mode.task') },
    { value: 'scan', label: t('adminLibraries.editor.mode.scan') },
  ]);

  const refreshDays = $derived([
    { value: '0', label: t('adminLibraries.editor.refreshNever') },
    ...[30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: t('adminLibraries.editor.refreshEvery', { n: d }) })),
  ]);

  // ---- Fetchers ----
  const typeChoices = $derived((available?.TypeOptions ?? []).map((x) => ({ value: x.Type, label: typeLabel(x.Type) })));
  const current = $derived(available?.TypeOptions?.find((x) => x.Type === fetcherType));
  const metaRows = $derived(current ? fetcherRows(draft, current.Type, 'Metadata', current.MetadataFetchers ?? []) : []);
  const imageRows = $derived(current ? fetcherRows(draft, current.Type, 'Image', current.ImageFetchers ?? []) : []);
  const subRows = $derived(subtitleRows(draft, available?.SubtitleFetchers ?? []));

  function typeLabel(itemType: string): string {
    const k = `common.types.${itemType}`;
    const s = t(k);
    return s === k ? itemType : s;
  }

  function move(rows: FetcherRow[], i: number, d: -1 | 1): FetcherRow[] {
    const next = rows.map((r) => ({ ...r }));
    const j = i + d;
    if (j < 0 || j >= next.length) return next;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }
  function toggleRow(rows: FetcherRow[], i: number, v: boolean): FetcherRow[] {
    return rows.map((r, k) => (k === i ? { ...r, enabled: v } : { ...r }));
  }

  // ---- Subtitle languages ----
  const subLangs = $derived((draft.SubtitleDownloadLanguages as string[] | undefined) ?? []);
  const subLabel = (code: string) => subtitleLanguages.find((l) => l.value === code)?.label ?? code;

  async function save(): Promise<void> {
    if (!folder || saving) return;
    const f = folder;
    const newName = name.trim();
    if (!newName) return;
    if (paths.length === 0) {
      toast('error', t('adminLibraries.editor.needPath'));
      return;
    }
    saving = true;
    try {
      const before = f.Locations ?? [];
      const added = paths.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !paths.includes(p));
      for (const p of added) await admin.addPath(f, p);
      for (const p of removed) await admin.removePath(f, p);
      const options = $state.snapshot(draft) as LibraryOptions;
      if (added.length || removed.length) {
        // The server rewrote PathInfos; post its version back, not the stale one.
        const fresh = (await admin.folders()).find((x) => x.Name === f.Name);
        options.PathInfos = fresh?.LibraryOptions?.PathInfos ?? paths.map((Path) => ({ Path }));
      }
      await admin.saveOptions(f, options);
      // Last: Jellyfin moves the folder (and its id) on rename.
      if (newName !== f.Name) await admin.rename(f, newName);
      toast('success', t('adminLibraries.editor.saved', { name: newName }));
      onsaved();
    } catch (err) {
      toast('error', t('adminLibraries.editor.saveFailed', { error: errorMessage(err) }));
    } finally {
      saving = false;
    }
  }
</script>

{#snippet fetchers(rows: FetcherRow[], onchange: (rows: FetcherRow[]) => void, empty: string)}
  <div class="a-group">
    {#each rows as r, i (r.name)}
      <div class="a-row compact">
        <Toggle label={r.name} checked={r.enabled} onchange={(v) => onchange(toggleRow(rows, i, v))} />
        <span class="a-lbl" class:soft={!r.enabled}>{r.name}</span>
        <span class="order">
          <button type="button" class="a-push icon ghost" disabled={i === 0} aria-label={t('adminLibraries.editor.moveUp', { name: r.name })} onclick={() => onchange(move(rows, i, -1))}>
            <Icon name="arrowUp" size={14} />
          </button>
          <button type="button" class="a-push icon ghost" disabled={i === rows.length - 1} aria-label={t('adminLibraries.editor.moveDown', { name: r.name })} onclick={() => onchange(move(rows, i, 1))}>
            <Icon name="arrowDown" size={14} />
          </button>
        </span>
      </div>
    {:else}
      <p class="a-empty">{empty}</p>
    {/each}
  </div>
{/snippet}

{#snippet toggleRowField(key: string, label: string, desc?: string)}
  <div class="a-row">
    <div class="a-txt">
      <div class="a-lbl">{label}</div>
      {#if desc}<div class="a-desc">{desc}</div>{/if}
    </div>
    <Toggle {label} checked={bool(key)} onchange={(v) => setv(key, v)} />
  </div>
{/snippet}

{#snippet modeRow(on: string, scan: string, label: string, desc: string)}
  <div class="a-row">
    <div class="a-txt">
      <div class="a-lbl">{label}</div>
      <div class="a-desc">{desc}</div>
    </div>
    <Picker {label} value={modeOf(on, scan)} options={modeOptions} onchange={(m) => setMode(on, scan, m)} />
  </div>
{/snippet}

<Sheet open={open && !!folder} {onclose} label={t('adminLibraries.editor.title', { name: folder?.Name ?? '' })} width={680}>
  {#if folder}
    <div class="a-sheet editor">
      <h2>{t('adminLibraries.editor.title', { name: folder.Name })}</h2>
      <div class="tabs"><Segmented label={t('adminLibraries.editor.tabsLabel')} value={tab} options={tabs} onchange={(v) => (tab = v)} /></div>

      <div class="body">
        {#if tab === 'general'}
          <label>
            {t('adminLibraries.fields.name')}
            <input class="a-input" bind:value={name} maxlength="120" />
          </label>

          <div class="a-gh">{t('adminLibraries.fields.folders')}</div>
          <div class="a-group">
            {#each paths as p (p)}
              <div class="a-row compact">
                <Icon name={p.startsWith('\\\\') ? 'network' : 'folder'} size={16} />
                <span class="a-lbl soft mono path">{p}</span>
                <button type="button" class="a-push icon ghost" aria-label={t('adminLibraries.fields.removeFolder', { path: p })} onclick={() => (paths = paths.filter((x) => x !== p))}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            {:else}
              <p class="a-empty">{t('adminLibraries.fields.noFolder')}</p>
            {/each}
          </div>
          <div class="row-actions">
            <button type="button" class="a-push" onclick={() => (browsing = true)}><Icon name="plus" size={14} /> {t('adminLibraries.fields.addFolder')}</button>
          </div>
          <p class="a-foot"><Icon name="server" size={12} /> {t('adminLibraries.fields.serverPaths', { server: serverName })}</p>
        {:else if tab === 'metadata'}
          <div class="a-group">
            {#if known('PreferredMetadataLanguage')}
              <div class="a-row">
                <div class="a-txt"><div class="a-lbl">{t('adminLibraries.fields.language')}</div></div>
                <Picker label={t('adminLibraries.fields.language')} value={(draft.PreferredMetadataLanguage as string) ?? ''} options={languages} onchange={(v) => setv('PreferredMetadataLanguage', v)} />
              </div>
            {/if}
            {#if known('MetadataCountryCode')}
              <div class="a-row">
                <div class="a-txt"><div class="a-lbl">{t('adminLibraries.fields.country')}</div></div>
                <Picker label={t('adminLibraries.fields.country')} value={(draft.MetadataCountryCode as string) ?? ''} options={countries} onchange={(v) => setv('MetadataCountryCode', v)} />
              </div>
            {/if}
            {#if known('PreferredImageLanguage', 'emby')}
              <div class="a-row">
                <div class="a-txt"><div class="a-lbl">{t('adminLibraries.editor.imageLanguage')}</div></div>
                <Picker label={t('adminLibraries.editor.imageLanguage')} value={(draft.PreferredImageLanguage as string) ?? ''} options={languages} onchange={(v) => setv('PreferredImageLanguage', v)} />
              </div>
            {/if}
            {#if known('AutomaticRefreshIntervalDays')}
              <div class="a-row">
                <div class="a-txt">
                  <div class="a-lbl">{t('adminLibraries.editor.refreshInterval')}</div>
                  <div class="a-desc">{t('adminLibraries.editor.refreshIntervalDesc')}</div>
                </div>
                <Picker
                  label={t('adminLibraries.editor.refreshInterval')}
                  value={String(draft.AutomaticRefreshIntervalDays ?? 0)}
                  options={refreshDays}
                  onchange={(v) => setv('AutomaticRefreshIntervalDays', Number(v))}
                />
              </div>
            {/if}
            {#if known('SaveLocalMetadata')}
              {@render toggleRowField('SaveLocalMetadata', t('adminLibraries.editor.saveLocal'), t('adminLibraries.editor.saveLocalDesc'))}
            {/if}
          </div>

          {#if available === null}
            <div class="skeleton fetch-skel"></div>
          {:else if typeChoices.length}
            <div class="fetch-head">
              <div class="a-gh">{t('adminLibraries.editor.fetchers')}</div>
              {#if typeChoices.length > 1}
                {#if typeChoices.length <= 4}
                  <Segmented label={t('adminLibraries.editor.fetchersFor')} value={fetcherType} options={typeChoices} onchange={(v) => (fetcherType = v)} />
                {:else}
                  <Picker label={t('adminLibraries.editor.fetchersFor')} value={fetcherType} options={typeChoices} onchange={(v) => (fetcherType = v)} />
                {/if}
              {/if}
            </div>
            <p class="a-foot first">{t('adminLibraries.editor.fetchersDesc')}</p>
            {@render fetchers(metaRows, (rows) => current && setFetcherRows(draft, current, 'Metadata', rows), t('adminLibraries.editor.noFetcher'))}
            <div class="a-gh">{t('adminLibraries.editor.imageFetchers')}</div>
            {@render fetchers(imageRows, (rows) => current && setFetcherRows(draft, current, 'Image', rows), t('adminLibraries.editor.noFetcher'))}
          {/if}
        {:else if tab === 'scan'}
          <div class="a-group">
            {#if known('EnableRealtimeMonitor')}
              {@render toggleRowField('EnableRealtimeMonitor', t('adminLibraries.fields.realtime'), t('adminLibraries.fields.realtimeDesc'))}
            {/if}
            {#if known('EnableEmbeddedTitles')}
              {@render toggleRowField('EnableEmbeddedTitles', t('adminLibraries.editor.embeddedTitles'), t('adminLibraries.editor.embeddedTitlesDesc'))}
            {/if}
            {#if known('EnablePhotos') && (type === 'homevideos' || type === 'mixed')}
              {@render toggleRowField('EnablePhotos', t('adminLibraries.editor.photos'))}
            {/if}
          </div>
          {#if video}
            <div class="a-gh">{t('adminLibraries.editor.images')}</div>
            <div class="a-group">
              {#if kind === 'jellyfin'}
                {#if known('EnableChapterImageExtraction')}
                  {@render modeRow('EnableChapterImageExtraction', 'ExtractChapterImagesDuringLibraryScan', t('adminLibraries.editor.chapterImages'), t('adminLibraries.editor.chapterImagesDesc'))}
                {/if}
                {#if known('EnableTrickplayImageExtraction')}
                  {@render modeRow('EnableTrickplayImageExtraction', 'ExtractTrickplayImagesDuringLibraryScan', t('adminLibraries.editor.trickplay'), t('adminLibraries.editor.trickplayDesc'))}
                {/if}
                {#if known('SaveTrickplayWithMedia')}
                  {@render toggleRowField('SaveTrickplayWithMedia', t('adminLibraries.editor.trickplayWithMedia'))}
                {/if}
              {:else if known('EnableChapterImageExtraction')}
                <!-- Emby's "thumbnail image extraction" makes both chapter images and the BIF scrub previews. -->
                {@render modeRow('EnableChapterImageExtraction', 'ExtractChapterImagesDuringLibraryScan', t('adminLibraries.editor.thumbnails'), t('adminLibraries.editor.thumbnailsDesc'))}
              {/if}
            </div>
          {/if}
        {:else if tab === 'subtitles'}
          <div class="a-gh">{t('adminLibraries.editor.subtitleLanguages')}</div>
          <div class="a-group">
            <div class="a-row chips-row">
              <div class="chips">
                {#each subLangs as code (code)}
                  <span class="lang">
                    {subLabel(code)}
                    <button type="button" aria-label={t('adminLibraries.editor.removeLanguage', { lang: subLabel(code) })} onclick={() => setv('SubtitleDownloadLanguages', subLangs.filter((c) => c !== code))}>
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                {:else}
                  <span class="a-desc">{t('adminLibraries.editor.noSubtitleLanguage')}</span>
                {/each}
              </div>
              <Picker
                label={t('adminLibraries.editor.addLanguage')}
                value=""
                options={[{ value: '', label: t('adminLibraries.editor.addLanguage') }, ...subtitleLanguages.filter((l) => !subLangs.includes(l.value))]}
                onchange={(v) => v && setv('SubtitleDownloadLanguages', [...subLangs, v])}
              />
            </div>
          </div>
          <div class="a-group">
            {#if known('SkipSubtitlesIfEmbeddedSubtitlesPresent')}
              {@render toggleRowField('SkipSubtitlesIfEmbeddedSubtitlesPresent', t('adminLibraries.editor.skipEmbedded'))}
            {/if}
            {#if known('SkipSubtitlesIfAudioTrackMatches')}
              {@render toggleRowField('SkipSubtitlesIfAudioTrackMatches', t('adminLibraries.editor.skipAudioMatch'))}
            {/if}
            {#if known('RequirePerfectSubtitleMatch')}
              {@render toggleRowField('RequirePerfectSubtitleMatch', t('adminLibraries.editor.perfectMatch'), t('adminLibraries.editor.perfectMatchDesc'))}
            {/if}
            {#if known('SaveSubtitlesWithMedia')}
              {@render toggleRowField('SaveSubtitlesWithMedia', t('adminLibraries.editor.saveWithMedia'))}
            {/if}
          </div>
          {#if subRows.length}
            <div class="a-gh">{t('adminLibraries.editor.subtitleFetchers')}</div>
            {@render fetchers(subRows, (rows) => setSubtitleRows(draft, rows), '')}
          {/if}
        {:else if tab === 'series'}
          <div class="a-group">
            {#if known('SeasonZeroDisplayName', 'jellyfin')}
              <div class="a-row">
                <div class="a-txt">
                  <div class="a-lbl">{t('adminLibraries.editor.seasonZero')}</div>
                  <div class="a-desc">{t('adminLibraries.editor.seasonZeroDesc')}</div>
                </div>
                <input class="a-input season0" value={(draft.SeasonZeroDisplayName as string) ?? ''} oninput={(e) => setv('SeasonZeroDisplayName', e.currentTarget.value)} />
              </div>
            {/if}
            {#if known('EnableAutomaticSeriesGrouping')}
              {@render toggleRowField('EnableAutomaticSeriesGrouping', t('adminLibraries.editor.seriesGrouping'), t('adminLibraries.editor.seriesGroupingDesc'))}
            {/if}
            {#if known('EnableEmbeddedEpisodeInfos', 'jellyfin')}
              {@render toggleRowField('EnableEmbeddedEpisodeInfos', t('adminLibraries.editor.embeddedEpisodes'), t('adminLibraries.editor.embeddedEpisodesDesc'))}
            {/if}
            {#if known('EnableMarkerDetection', 'emby')}
              {@render modeRow('EnableMarkerDetection', 'EnableMarkerDetectionDuringLibraryScan', t('adminLibraries.editor.introDetection'), t('adminLibraries.editor.introDetectionDesc'))}
            {/if}
          </div>
        {/if}
      </div>

      <div class="a-sheet-actions">
        <button type="button" class="a-push ghost" onclick={onclose}>{t('common.actions.cancel')}</button>
        <button type="button" class="a-push primary" disabled={saving || !name.trim()} onclick={save}>
          {saving ? t('adminLibraries.editor.saving') : t('common.actions.save')}
        </button>
      </div>
    </div>
  {/if}
</Sheet>

<FolderBrowser
  open={browsing}
  {admin}
  {serverName}
  onclose={() => (browsing = false)}
  onpick={(p) => {
    browsing = false;
    if (!paths.includes(p)) paths = [...paths, p];
  }}
/>

<style>
  .editor {
    min-height: 560px;
  }
  .tabs {
    display: flex;
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .body > :global(.a-gh) {
    margin: 12px 0 -4px 2px;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
  }
  .row-actions {
    display: flex;
    gap: 8px;
  }
  .a-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 0;
  }
  .a-foot.first {
    margin: -6px 2px 0;
  }
  .order {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .fetch-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
  }
  .fetch-head .a-gh {
    margin: 0 0 0 2px;
  }
  .fetch-skel {
    height: 180px;
    border-radius: var(--r-sm);
  }
  .chips-row {
    align-items: flex-start;
  }
  .chips {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    padding-top: 3px;
  }
  .lang {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 4px 0 10px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    color: var(--label);
  }
  .lang button {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--label-3);
  }
  .lang button:hover,
  .lang button:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .season0 {
    width: 160px;
  }
</style>
