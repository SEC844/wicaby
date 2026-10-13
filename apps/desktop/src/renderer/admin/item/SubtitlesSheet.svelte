<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem, MediaSource } from '../../../shared/models';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { errorMessage, settings, toast } from '../../lib/stores.svelte';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import { cultures, downloadSubtitle, editableItem, searchSubtitles, type Culture, type RemoteSubtitle } from './metadata';

  // Remote subtitle search for one media source of the item, then download to the server.
  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  let sources = $state<MediaSource[]>([]);
  let sourceId = $state('');
  let langs = $state<Culture[]>([]);
  let language = $state('');
  let results = $state<RemoteSubtitle[] | null>(null);
  let searching = $state(false);
  let busy = $state('');
  let error = $state('');

  const source = $derived(sources.find((s) => s.Id === sourceId) ?? sources[0]);
  const langOptions = $derived(
    langs
      .filter((c) => c.ThreeLetterISOLanguageName)
      .map((c) => ({ value: c.ThreeLetterISOLanguageName!, label: c.DisplayName }))
      .sort((a, b) => fmt.compare(a.label, b.label)),
  );
  const existing = $derived((source?.MediaStreams ?? item.MediaStreams ?? []).filter((s) => s.Type === 'Subtitle'));

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      results = null;
      error = '';
      sources = item.MediaSources ?? [];
      sourceId = sources[0]?.Id ?? '';
      language = settings.value?.playback.preferredSubtitleLanguage || (navigator.language.startsWith('fr') ? 'fre' : 'eng');
      if (!sources.length) void editableItem(item).then((d) => ((sources = d.MediaSources ?? []), (sourceId = sources[0]?.Id ?? '')));
      void cultures(item.ServerId).then((c) => (langs = c));
    });
  });

  async function search(): Promise<void> {
    if (searching || !language) return;
    searching = true;
    error = '';
    results = null;
    try {
      results = await searchSubtitles(item, language, source);
    } catch (err) {
      error = errorMessage(err);
      results = [];
    } finally {
      searching = false;
    }
  }

  async function download(sub: RemoteSubtitle): Promise<void> {
    if (busy) return;
    busy = sub.Id;
    try {
      await downloadSubtitle(item, sub, source);
      toast('success', t('adminMetadata.subtitles.downloaded'));
      onclose();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = '';
    }
  }
</script>

<AdminSheet {open} {onclose} title={t('adminMetadata.subtitles.title')} subtitle={item.Name} width={680}>
  <div class="bar">
    {#if sources.length > 1}
      <Picker label={t('adminMetadata.subtitles.version')} value={sourceId} options={sources.map((s, i) => ({ value: s.Id, label: s.Name || t('adminMetadata.subtitles.versionN', { n: i + 1 }) }))} onchange={(v) => (sourceId = v)} />
    {/if}
    <Picker
      label={t('adminMetadata.subtitles.language')}
      value={language}
      options={langOptions.length ? langOptions : [{ value: language, label: fmt.language(language) }]}
      onchange={(v) => (language = v)}
    />
    <button type="button" class="btn primary" disabled={searching || !language} onclick={search} data-autofocus>
      <Icon name="search" size={15} />
      {searching ? t('adminMetadata.subtitles.searching') : t('adminMetadata.subtitles.search')}
    </button>
  </div>
  {#if existing.length}
    <p class="a-foot">{t('adminMetadata.subtitles.existing', { list: fmt.list(existing.map((s) => s.DisplayTitle || s.Language || '?')) })}</p>
  {/if}
  {#if error}<p class="am-error">{error}</p>{/if}

  {#if searching}
    <div class="sk skeleton"></div>
  {:else if results}
    {#if results.length === 0}
      <p class="am-empty">{t('adminMetadata.subtitles.none')}</p>
    {:else}
      <h3 class="a-gh">{t('adminMetadata.subtitles.results', { n: results.length })}</h3>
      <div class="a-group">
        {#each results as r (r.Id)}
          <div class="a-row">
            <div class="a-txt">
              <span class="a-lbl">
                <span class="nm">{r.Name ?? r.Id}</span>
                {#if r.IsHashMatch}<span class="chip accent">{t('adminMetadata.subtitles.exact')}</span>{/if}
                {#if r.IsForced}<span class="chip">{t('adminMetadata.subtitles.forced')}</span>{/if}
                {#if r.IsHearingImpaired}<span class="chip">{t('adminMetadata.subtitles.sdh')}</span>{/if}
              </span>
              <span class="a-desc">
                {[
                  r.ProviderName,
                  r.Format?.toUpperCase(),
                  r.CommunityRating ? `★ ${fmt.number(r.CommunityRating, { maximumFractionDigits: 1 })}` : '',
                  r.DownloadCount ? t('adminMetadata.subtitles.downloads', { n: r.DownloadCount }) : '',
                  r.Author,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {#if r.Comment}<span class="a-desc cm">{r.Comment}</span>{/if}
            </div>
            <button type="button" class="a-push" disabled={busy !== ''} onclick={() => download(r)}>
              <Icon name="download" size={14} />
              {busy === r.Id ? t('adminMetadata.subtitles.downloading') : t('adminMetadata.subtitles.download')}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</AdminSheet>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 4px 0 4px;
  }
  .bar .btn {
    margin-left: auto;
  }
  .sk {
    height: 220px;
    margin-top: 16px;
    border-radius: var(--r-md);
  }
  .chip {
    flex: none;
    white-space: nowrap;
  }
  .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cm {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
