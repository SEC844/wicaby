<script lang="ts">
  import type { ChannelRow, ProgramLite } from '../../../shared/livetv/model';
  import { markFor } from '../../../shared/livetv/timers';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';
  import { live } from '../../lib/livetv.svelte';
  import type { LiveTvStore, Program } from '../../lib/livetv.svelte';

  // Detail band over the grid (§6.1, desktop: optional). The art and overview come from the
  // programme detail call, made after 400 ms of stable focus (tiles carry no images).
  let { store, program, channel }: { store: LiveTvStore; program: ProgramLite | null; channel: ChannelRow | null } = $props();

  const details = new Map<string, Program>();
  let full = $state<Program | null>(null);

  $effect(() => {
    const id = program?.id;
    const cached = id ? (details.get(id) ?? null) : null;
    full = cached;
    if (!id || cached) return;
    const timer = setTimeout(() => {
      live
        .program(id, store.serverId)
        .then((p) => {
          if (details.size > 64) details.clear();
          details.set(id, p);
          if (program?.id === id) full = p;
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  });

  const art = $derived.by(() => {
    const p = full;
    if (!p?.Id) return '';
    const tag = p.ImageTags?.Thumb ?? p.ImageTags?.Primary;
    return tag ? imageUrl(p.Id, p.ImageTags?.Thumb ? 'Thumb' : 'Primary', { tag, maxWidth: 220, server: store.serverId }) : '';
  });
  const se = $derived(program?.season !== undefined && program?.episode !== undefined ? t('livetv.guide.episode', { season: program.season, episode: program.episode }) : '');
  const mark = $derived(program ? markFor(program, store.dvr.overlay) : null);
  const MARK_KEY: Record<string, string> = {
    timer: 'marks.timer',
    series: 'marks.series',
    recording: 'marks.recording',
    'conflict-wont': 'marks.wontRecord',
    'conflict-ok': 'marks.conflictOk',
    error: 'marks.error',
    'rule-skip': 'marks.ruleSkips',
  };
</script>

<div class="band" aria-hidden="true">
  {#if program}
    <div class="art">{#if art}<img src={art} alt="" decoding="async" />{/if}</div>
    <div class="text">
      <div class="title headline">{program.title}</div>
      <div class="meta footnote mono">
        {[channel?.name, se, program.episodeTitle, `${fmt.time(program.start)} – ${fmt.time(program.end)}`].filter(Boolean).join(' · ')}
      </div>
      {#if full?.Overview}<p class="overview footnote">{full.Overview}</p>{/if}
      {#if mark}<div class="mark caption">{t(`livetv.${MARK_KEY[mark]}`)}</div>{/if}
    </div>
  {:else if channel}
    <div class="text"><div class="title headline">{channel.name}</div></div>
  {/if}
</div>

<style>
  .band {
    display: flex;
    gap: 16px;
    height: 132px;
    margin-bottom: 12px;
    padding: 12px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated-2);
    overflow: hidden;
  }
  .art {
    flex: none;
    width: 192px;
    height: 108px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    overflow: hidden;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .title,
  .meta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .overview {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .mark {
    color: var(--label-2);
  }
</style>
