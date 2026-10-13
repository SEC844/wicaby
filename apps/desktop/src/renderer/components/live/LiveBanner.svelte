<script lang="ts">
  import type { LiveNowNext as BannerProgram, ZapEntry } from '../../../shared/contract';
  import { PF } from '../../../shared/livetv/model';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';

  // Info banner over the live picture (livetv-spec-final.md §8.5): channel, lens position, clock,
  // the programme now (or the one browsed with ←/→) and the next one; a second I expands it into
  // the detail panel (overview, the next programmes, Enregistrer).
  let {
    entry,
    serverId,
    position,
    tuning,
    clock,
    programs,
    browse,
    recording,
    expanded,
    overview,
    lifted,
    onwheel,
    onrecord,
  }: {
    entry: ZapEntry;
    serverId: string;
    position: string;
    tuning: boolean;
    clock: number;
    programs: BannerProgram[];
    browse: number;
    recording: boolean;
    expanded: boolean;
    overview: string;
    lifted: boolean;
    onwheel: (e: WheelEvent) => void;
    onrecord: (programId: string) => void;
  } = $props();

  const main = $derived(programs[browse]);
  const after = $derived(programs[browse + 1]);
  const airing = $derived(main && main.start <= clock && clock < main.end);
  const progress = $derived(airing && main ? Math.min(1, (clock - main.start) / (main.end - main.start)) : 0);
  const logo = $derived(entry.logoTag ? imageUrl(entry.id, 'Primary', { tag: entry.logoTag, maxHeight: 56, server: serverId }) : '');
  const label = (p: BannerProgram | undefined, first: boolean): string =>
    !p ? '' : first && p.start <= clock ? t('player.live.now') : first ? fmt.time(p.start) : browse === 0 ? t('player.live.next') : fmt.time(p.start);
  const span = (p: BannerProgram): string => `${fmt.time(p.start)} – ${fmt.time(p.end)}`;
  const upcoming = $derived(programs.slice(browse + 1, browse + 4));
</script>

<div class="banner" class:lifted class:expanded {onwheel} role="presentation">
  <div class="row head">
    <span class="logo" class:plate={!logo}>
      {#if logo}<img src={logo} alt="" decoding="async" />{:else}<span class="mono">{entry.number}</span>{/if}
    </span>
    <span class="num mono">{entry.number}</span>
    <span class="name headline">{entry.name}</span>
    <span class="spacer"></span>
    {#if position}<span class="pos footnote">{position}</span>{/if}
    <span class="clock mono">{tuning ? t('player.live.tuning') : fmt.time(clock)}</span>
  </div>
  {#if main}
    <div class="row prog">
      <span class="lbl caption">{label(main, true)}</span>
      <span class="title">{main.title}{#if main.episodeTitle}<span class="ep"> · {main.episodeTitle}</span>{/if}</span>
      <span class="when mono caption">{span(main)}</span>
      <span class="bar" aria-hidden="true"><span style:transform="scaleX({progress})"></span></span>
      <span class="badges caption">
        {#if airing}<span class="badge"><span class="dot" aria-hidden="true"></span>{t('player.live.badge')}</span>{/if}
        {#if main.flags & PF.HD}<span class="badge">HD</span>{/if}
        {#if recording && browse === 0}<span class="rec" title={t('player.live.recording')} aria-label={t('player.live.recording')}></span>{/if}
      </span>
    </div>
  {:else}
    <div class="row prog"><span class="title dim">{t('livetv.guide.noInfo')}</span></div>
  {/if}
  {#if after}
    <div class="row prog">
      <span class="lbl caption">{label(after, false)}</span>
      <span class="title soft">{after.title}</span>
      <span class="when mono caption">{fmt.time(after.start)}</span>
    </div>
  {/if}
  {#if expanded && main}
    <div class="detail">
      {#if overview}<p class="overview">{overview}</p>{/if}
      {#each upcoming as p (p.id)}
        <div class="up"><span class="mono caption">{fmt.time(p.start)}</span><span class="soft">{p.title}</span></div>
      {/each}
      {#if main.end > clock}
        <button class="btn" onclick={() => onrecord(main.id)}>{t('livetv.actions.record')}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .banner {
    position: absolute;
    left: 48px;
    right: 48px;
    bottom: 48px;
    z-index: 4;
    max-width: 1100px;
    margin: 0 auto;
    padding: 14px 18px;
    border-radius: var(--r-xl);
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    color: var(--label);
    animation: banner-in var(--t-med) var(--ease-out) both;
    transition: transform var(--t-slow) var(--ease);
  }
  .banner.lifted {
    transform: translate3d(0, -128px, 0);
  }
  @keyframes banner-in {
    from {
      opacity: 0;
      transform: translate3d(0, 12px, 0);
    }
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .head {
    margin-bottom: 8px;
  }
  .prog {
    height: 26px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 64px;
    height: 40px;
    flex: none;
  }
  .logo img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .logo.plate {
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--label-2);
  }
  .num {
    font-size: var(--fs-headline);
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1;
  }
  .pos {
    white-space: nowrap;
  }
  .clock {
    font-variant-numeric: tabular-nums;
    color: var(--label-2);
    white-space: nowrap;
  }
  .lbl {
    width: 76px;
    flex: none;
    color: var(--label-2);
  }
  .title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 560;
  }
  .ep,
  .soft {
    color: var(--label-2);
    font-weight: 400;
  }
  .dim {
    color: var(--label-3);
  }
  .when {
    flex: none;
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    position: relative;
    width: 140px;
    height: 3px;
    flex: none;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .bar span {
    position: absolute;
    inset: 0;
    background: var(--label);
    opacity: 0.6;
    transform-origin: left;
  }
  .badges {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
  }
  .dot,
  .rec {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
    flex: none;
  }
  .detail {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 0.5px solid var(--hairline);
    justify-items: start;
  }
  .overview {
    margin: 0 0 4px;
    max-width: 80ch;
    color: var(--label-2);
    font-size: var(--fs-callout);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .up {
    display: flex;
    gap: 12px;
    font-size: var(--fs-callout);
  }
  .detail .btn {
    margin-top: 6px;
    height: 32px;
    padding: 0 14px;
  }
</style>
