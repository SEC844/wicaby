<script lang="ts">
  import { onMount } from 'svelte';
  import type { PlaybackCommand, PlaybackState } from '../../../shared/contract';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';

  // The OSD dock's bar in live mode (livetv-spec-final.md §8.8, D-7). With timeshift: [buffer start,
  // live edge] in wall-clock time, the "Direct" pill at the edge, "Revenir au direct" (End) once more
  // than 15 s behind. Without: the airing programme's progress. Keys stay in LiveOverlay; a click seeks
  // inside the window and main clamps it to mpv's seekable ranges. After a pause released the tuner:
  // "Reprendre le direct".
  let { state: pb }: { state: PlaybackState } = $props();

  const BEHIND_MS = 15_000;

  const lv = $derived(pb.live!);
  const ts = $derived(lv.timeshift);
  let clock = $state(Date.now());
  let bar = $state<HTMLElement>();

  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const span = $derived(ts ? Math.max(1, ts.endWall - ts.startWall) : 0);
  const fraction = $derived(ts ? clamp01((ts.posWall - ts.startWall) / span) : lv.now ? clamp01((clock - lv.now.start) / Math.max(1, lv.now.end - lv.now.start)) : 0);
  const behind = $derived(ts ? Math.max(0, ts.endWall - ts.posWall) : 0);

  function cmd(c: PlaybackCommand): void {
    void w.playback.command(c).catch(() => undefined);
  }

  function onDown(e: PointerEvent): void {
    if (!ts || !bar) return;
    const r = bar.getBoundingClientRect();
    const f = clamp01((e.clientX - r.left) / Math.max(1, r.width));
    cmd({ type: 'seek-relative', deltaMs: Math.round(ts.startWall + f * span - ts.posWall) });
  }

  onMount(() => {
    const timer = setInterval(() => (clock = Date.now()), 1_000);
    return () => clearInterval(timer);
  });
</script>

<div class="row">
  {#if ts}
    <span class="time mono">{fmt.time(ts.startWall)}</span>
    <div
      class="bar"
      bind:this={bar}
      role="slider"
      tabindex="0"
      aria-label={t('player.live.timeline')}
      aria-valuemin={0}
      aria-valuemax={Math.round(span / 1000)}
      aria-valuenow={Math.round((ts.posWall - ts.startWall) / 1000)}
      aria-valuetext={fmt.time(ts.posWall)}
      onpointerdown={onDown}
    >
      <div class="track"><span class="fill" style:transform="scaleX({fraction})"></span></div>
      <span class="knob" style:left="{fraction * 100}%"></span>
    </div>
    <span class="time mono dim">{fmt.time(ts.posWall)}</span>
  {:else if lv.now}
    <span class="time mono">{fmt.time(lv.now.start)}</span>
    <div class="bar static"><div class="track"><span class="fill" style:transform="scaleX({fraction})"></span></div></div>
    <span class="time mono dim">{fmt.time(lv.now.end)}</span>
  {:else}
    <span class="grow"></span>
  {/if}
  {#if lv.pausedReleased}
    <!-- The paused stream was released after 30 s (§8.8): re-tune. -->
    <button class="pill btn" onclick={() => cmd({ type: 'resume' })}>{t('player.live.resumeLive')}</button>
  {:else if ts && behind > BEHIND_MS}
    <span class="behind footnote">{t('player.live.behind', { time: fmt.duration(Math.max(60_000, behind)) })}</span>
    <button class="pill btn" onclick={() => cmd({ type: 'live-edge' })}>{t('player.live.backToLive')}</button>
  {:else}
    <span class="pill"><span class="dot" aria-hidden="true"></span>{t('player.live.badge')}</span>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 22px;
    margin-bottom: 2px;
  }
  .time {
    min-width: 46px;
    font-size: var(--fs-footnote);
    color: var(--label);
  }
  .time.dim {
    color: var(--label-2);
    text-align: right;
  }
  .bar,
  .grow {
    position: relative;
    flex: 1;
    height: 22px;
    display: flex;
    align-items: center;
    touch-action: none;
    border-radius: 4px;
  }
  .bar:not(.static) {
    cursor: pointer;
  }
  .track {
    position: relative;
    width: 100%;
    height: 5px;
    border-radius: 5px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0;
    background: var(--label);
    transform-origin: left;
  }
  .knob {
    position: absolute;
    top: 4px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.45);
    transform: scale(0);
    transition: transform var(--t-med) var(--spring);
    pointer-events: none;
  }
  .bar:hover .knob,
  .bar:focus-visible .knob {
    transform: scale(1);
  }
  .bar:focus-visible {
    outline: none;
  }
  .behind {
    color: var(--label-2);
    white-space: nowrap;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    height: 24px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
    font: inherit;
    font-size: var(--fs-footnote);
    font-weight: 560;
    white-space: nowrap;
  }
  .pill.btn {
    cursor: pointer;
  }
  .pill.btn:hover,
  .pill.btn:focus-visible {
    background: var(--label);
    color: var(--bg, #000);
    outline: none;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
  }
  @media (forced-colors: active) {
    .bar:focus-visible,
    .pill.btn:focus-visible {
      outline: 3px solid Highlight;
    }
  }
</style>
