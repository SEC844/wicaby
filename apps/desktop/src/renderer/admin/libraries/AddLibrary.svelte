<script lang="ts">
  // New library: name, content type, folders picked on the server, and the few
  // options that matter up front. The rest is edited afterwards.
  import type { ServerKind } from '../../../shared/contract';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import FolderBrowser from './FolderBrowser.svelte';
  import { CONTENT_TYPES, isVideoType, setFetcherRows, type LibraryAdmin, type LibraryOptions } from './libraryAdmin';

  type Opt = { value: string; label: string };

  let {
    open,
    admin,
    kind,
    serverName,
    existing,
    languages,
    countries,
    onclose,
    oncreated,
  }: {
    open: boolean;
    admin: LibraryAdmin;
    kind: ServerKind;
    serverName: string;
    existing: string[];
    languages: Opt[];
    countries: Opt[];
    onclose: () => void;
    oncreated: (name: string) => void;
  } = $props();

  let name = $state('');
  let nameTouched = $state(false);
  let type = $state('movies');
  let paths = $state<string[]>([]);
  let language = $state('');
  let country = $state('');
  let realtime = $state(true);
  let scanNow = $state(true);
  let browsing = $state(false);
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    name = '';
    nameTouched = false;
    type = 'movies';
    paths = [];
    language = '';
    country = '';
    realtime = true;
    scanNow = true;
  });

  const typeLabel = (v: string) => t(`adminLibraries.types.${v}`);
  const types = $derived(CONTENT_TYPES[kind].map((v) => ({ value: v, label: typeLabel(v) })));
  const clash = $derived(existing.some((n) => n.toLowerCase() === name.trim().toLowerCase()));
  const valid = $derived(!!name.trim() && !clash && paths.length > 0);

  function pickType(v: string): void {
    type = v;
    if (!nameTouched) name = typeLabel(v);
  }

  async function create(): Promise<void> {
    if (!valid || saving) return;
    saving = true;
    const options: LibraryOptions = {
      PathInfos: paths.map((Path) => ({ Path })),
      EnableRealtimeMonitor: realtime,
      PreferredMetadataLanguage: language,
      MetadataCountryCode: country,
      EnablePhotos: true,
      EnableInternetProviders: true,
      SaveLocalMetadata: false,
      EnableChapterImageExtraction: false,
      ExtractChapterImagesDuringLibraryScan: false,
      AutomaticRefreshIntervalDays: 0,
      EnableEmbeddedTitles: false,
      SkipSubtitlesIfEmbeddedSubtitlesPresent: false,
      SkipSubtitlesIfAudioTrackMatches: false,
      RequirePerfectSubtitleMatch: true,
      SaveSubtitlesWithMedia: true,
      SubtitleDownloadLanguages: [],
      TypeOptions: [],
    };
    if (kind === 'jellyfin') Object.assign(options, { EnableTrickplayImageExtraction: false, ExtractTrickplayImagesDuringLibraryScan: false, SeasonZeroDisplayName: 'Specials', EnableEmbeddedEpisodeInfos: false, EnableAutomaticSeriesGrouping: false });
    if (!isVideoType(type)) options.EnableChapterImageExtraction = false;
    try {
      // The server's default fetchers, so the new library starts like the web client's.
      const avail = await admin.availableOptions(type, true).catch(() => null);
      for (const to of avail?.TypeOptions ?? []) {
        setFetcherRows(options, to, 'Metadata', (to.MetadataFetchers ?? []).map((f) => ({ name: f.Name, enabled: f.DefaultEnabled })));
        setFetcherRows(options, to, 'Image', (to.ImageFetchers ?? []).map((f) => ({ name: f.Name, enabled: f.DefaultEnabled })));
      }
      await admin.add(name.trim(), type, options, scanNow);
      toast('success', t('adminLibraries.add.created', { name: name.trim() }));
      oncreated(name.trim());
    } catch (err) {
      toast('error', t('adminLibraries.add.failed', { error: errorMessage(err) }));
    } finally {
      saving = false;
    }
  }
</script>

<Sheet {open} {onclose} label={t('adminLibraries.add.title')} width={600}>
  <div class="a-sheet">
    <h2>{t('adminLibraries.add.title')}</h2>

    <div class="a-group">
      <div class="a-row">
        <div class="a-txt"><div class="a-lbl">{t('adminLibraries.fields.type')}</div></div>
        <Picker label={t('adminLibraries.fields.type')} value={type} options={types} onchange={pickType} />
      </div>
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminLibraries.fields.name')}</div>
          {#if clash}<div class="a-desc warn">{t('adminLibraries.add.nameTaken')}</div>{/if}
        </div>
        <input
          class="a-input name"
          data-autofocus
          bind:value={name}
          maxlength="120"
          oninput={() => (nameTouched = true)}
          placeholder={typeLabel(type)}
        />
      </div>
    </div>

    <div class="a-gh">{t('adminLibraries.fields.folders')}</div>
    <div class="server-note">
      <Icon name="server" size={16} />
      <span>{t('adminLibraries.add.serverNote', { server: serverName })}</span>
    </div>
    <div class="a-group">
      {#each paths as p (p)}
        <div class="a-row compact">
          <Icon name={p.startsWith('\\\\') ? 'network' : 'folder'} size={16} />
          <span class="a-lbl soft mono path">{p}</span>
          <button type="button" class="a-push icon ghost" aria-label={t('adminLibraries.fields.removeFolder', { path: p })} onclick={() => (paths = paths.filter((x) => x !== p))}>
            <Icon name="close" size={14} />
          </button>
        </div>
      {/each}
      <div class="a-row compact">
        <button type="button" class="a-push" onclick={() => (browsing = true)}><Icon name="plus" size={14} /> {t('adminLibraries.fields.addFolder')}</button>
        {#if paths.length === 0}<span class="a-desc">{t('adminLibraries.add.needFolder')}</span>{/if}
      </div>
    </div>

    <div class="a-gh">{t('adminLibraries.add.options')}</div>
    <div class="a-group">
      <div class="a-row">
        <div class="a-txt"><div class="a-lbl">{t('adminLibraries.fields.language')}</div></div>
        <Picker label={t('adminLibraries.fields.language')} value={language} options={languages} onchange={(v) => (language = v)} />
      </div>
      <div class="a-row">
        <div class="a-txt"><div class="a-lbl">{t('adminLibraries.fields.country')}</div></div>
        <Picker label={t('adminLibraries.fields.country')} value={country} options={countries} onchange={(v) => (country = v)} />
      </div>
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminLibraries.fields.realtime')}</div>
          <div class="a-desc">{t('adminLibraries.fields.realtimeDesc')}</div>
        </div>
        <Toggle label={t('adminLibraries.fields.realtime')} checked={realtime} onchange={(v) => (realtime = v)} />
      </div>
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('adminLibraries.add.scanNow')}</div>
          <div class="a-desc">{t('adminLibraries.add.scanNowDesc')}</div>
        </div>
        <Toggle label={t('adminLibraries.add.scanNow')} checked={scanNow} onchange={(v) => (scanNow = v)} />
      </div>
    </div>
    <p class="a-foot">{t('adminLibraries.add.moreLater')}</p>

    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={onclose}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push primary" disabled={!valid || saving} onclick={create}>
        {saving ? t('adminLibraries.add.creating') : t('adminLibraries.add.create')}
      </button>
    </div>
  </div>
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
  .name {
    width: 260px;
  }
  .warn {
    color: var(--warning);
  }
  .server-note {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: -6px;
    padding: 10px 14px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    font-size: var(--fs-footnote);
    color: var(--label-2);
    line-height: 1.45;
  }
  .server-note :global(.wi-icon) {
    margin-top: 1px;
    color: var(--label-2);
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
  }
  .a-sheet > :global(.a-gh) {
    margin: 6px 0 -6px 2px;
  }
</style>
