<script lang="ts">
  // Android TV RecordingsTab (livetv/RecordingsTab.kt, spec §9.5): the recordings in rails, recording now first, then
  // series, films, sport and the rest, the newest first. OK offers Play or Delete (confirmed); Play opens the player.
  import type { BaseItem } from '$shared/models';
  import MediaRow from '../MediaRow.svelte';
  import Spinner from '../Spinner.svelte';
  import { plural, t } from '../../lib/i18n.svelte';
  import { useLoad } from '../../lib/load.svelte';
  import type { LiveTv } from '../../lib/livetv.svelte';
  import { closeAlert, showAlert } from '../../lib/overlay.svelte';
  import { play } from '../../lib/playback';
  import { showToast } from '../../lib/toast.svelte';

  let { repo }: { repo: LiveTv } = $props();

  let rev = $state(0);
  const recordings = useLoad(
    () => `livetv-recordings-${repo.api.address}-${rev}`,
    () => repo.recordings(),
  );
  type Rec = BaseItem & { Status?: string; IsSeries?: boolean; IsMovie?: boolean; IsSports?: boolean; DateCreated?: string };
  const sections = $derived.by(() => {
    const all = ((recordings.value ?? []) as Rec[]).slice().sort((a, b) => (b.DateCreated ?? '').localeCompare(a.DateCreated ?? ''));
    const live = all.filter((r) => r.Status === 'InProgress');
    const rest = all.filter((r) => r.Status !== 'InProgress');
    const series = rest.filter((r) => r.IsSeries || r.SeriesName);
    const movies = rest.filter((r) => !series.includes(r) && r.IsMovie);
    const sports = rest.filter((r) => !series.includes(r) && !movies.includes(r) && r.IsSports);
    const other = rest.filter((r) => !series.includes(r) && !movies.includes(r) && !sports.includes(r));
    return [
      { key: 'live', title: t('livetv_recordings_sections_in_progress'), items: live },
      { key: 'recent', title: t('livetv_recordings_sections_recent'), items: rest.slice(0, 20) },
      { key: 'series', title: t('livetv_recordings_sections_series'), items: series },
      { key: 'movies', title: t('livetv_recordings_sections_movies'), items: movies },
      { key: 'sports', title: t('livetv_recordings_sections_sports'), items: sports },
      { key: 'other', title: t('livetv_recordings_sections_other'), items: other.length === rest.length ? [] : other },
    ].filter((s) => s.items.length);
  });

  function open(item: BaseItem): void {
    showAlert({
      title: item.Name,
      actions: [
        { label: t('play'), run: () => play(item) },
        { label: t('livetv_recordings_delete'), destructive: true, run: () => confirmDelete(item) },
        { label: t('cancel'), run: closeAlert },
      ],
      focusIndex: 0,
    });
  }
  function confirmDelete(item: BaseItem): void {
    showAlert({
      title: item.Name,
      message: t('livetv_recordings_delete_hint'),
      actions: [
        {
          label: t('livetv_recordings_delete'),
          destructive: true,
          run: () =>
            void repo.deleteRecording(item.Id).then(
              () => {
                showToast(plural('livetv_toasts_recordings_deleted', 1, 1));
                rev++;
              },
              () => showToast(t('player_live_record_failed')),
            ),
        },
        { label: t('cancel'), run: closeAlert },
      ],
      focusIndex: 1,
    });
  }
</script>

<div class="recordings">
  {#if recordings.value === undefined && recordings.error === undefined}
    <div class="center"><Spinner size={36} /></div>
  {:else if !sections.length}
    <p class="t-body label-3 empty">{t('livetv_recordings_empty')}</p>
  {:else}
    {#each sections as s (s.key)}
      <MediaRow title={s.title} items={s.items} api={repo.api} wide onclick={open} />
    {/each}
  {/if}
</div>

<style>
  .recordings {
    padding-bottom: 56rem;
  }
  .empty {
    margin: 14rem 48rem 0;
    max-width: 640rem;
  }
  .center {
    display: flex;
    justify-content: center;
    padding: 48rem 0;
  }
</style>
