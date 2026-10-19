<script module lang="ts">
  export interface OsdButton {
    key: string;
    icon: string;
    // An inline path for the player's own glyphs (chapters), else an Android icon name.
    path?: string;
    text: string;
    value?: string;
    run: () => void;
  }
</script>

<script lang="ts">
  // Android TV Osd + ScrubBar (PlayerActivity.kt): the title over a bottom gradient, the time left and "Ends at" at
  // the scrub bar's right end, the bar with its chapter gaps (taller with the target time while seeking), then the
  // play state, the position and the control buttons, white pills when focused.
  import type { BaseItem } from '$shared/models';
  import { focusable } from '../../lib/focus';
  import { clock, episodeLine } from '../../lib/format';
  import { locale, t } from '../../lib/i18n.svelte';
  import Icon from '../Icon.svelte';

  let {
    item,
    position,
    duration,
    scrubbing,
    playing,
    chapterStarts,
    buttons,
    now,
  }: {
    item: BaseItem;
    position: number;
    duration: number;
    scrubbing: boolean;
    playing: boolean;
    chapterStarts: number[];
    buttons: OsdButton[];
    now: number;
  } = $props();

  const eyebrow = $derived(item.Type === 'Episode' ? item.SeriesName : item.ProductionYear?.toString());
  const title = $derived(item.Type === 'Episode' ? (episodeLine(item) ?? item.Name) : item.Name);
  const f = $derived(duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0);
  // "Ends at": stable while playing (position and clock advance together), follows the clock while paused.
  const endsAt = $derived(
    duration > 0 ? new Date(now + Math.max(0, duration - position)).toLocaleTimeString(locale.current, { hour: '2-digit', minute: '2-digit' }) : '',
  );
</script>

<div class="osd">
  <div class="shade-top"></div>
  <div class="shade"></div>
  <div class="bottom">
    <div class="head">
      <div class="titles">
        {#if eyebrow}<p class="eyebrow t-callout">{eyebrow}</p>{/if}
        <p class="title t-title1 ellipsis">{title}</p>
      </div>
      <span class="left mono">-{clock(Math.max(0, duration - position))}</span>
      {#if endsAt}<span class="ends t-caption">&nbsp;&nbsp;{t('ends_at', endsAt)}</span>{/if}
    </div>
    <div class="bar" class:scrubbing>
      <div class="track">
        <div class="played" style="transform:scaleX({f})"></div>
        {#each chapterStarts as s (s)}
          {#if s > 0 && s < duration}<span class="chapter" style="left:{(s / duration) * 100}%"></span>{/if}
        {/each}
      </div>
      {#if scrubbing}<span class="target mono" style="left:{f * 100}%">{clock(position)}</span>{/if}
    </div>
    <div class="controls" data-focus-group>
      <Icon name={playing ? 'Pause' : 'Play'} size={18} />
      <span class="position mono">{clock(position)}</span>
      <span class="spring"></span>
      {#each buttons as b (b.key)}
        <button class="button t-caption" use:focusable onclick={b.run} data-osd-button={b.key}>
          {#if b.path}
            <svg viewBox="0 0 24 24" class="glyph" aria-hidden="true"><path d={b.path} fill="currentColor" /></svg>
          {:else}
            <Icon name={b.icon} size={16} />
          {/if}
          <span>{b.text}</span>
          {#if b.value}<span class="value">· {b.value}</span>{/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .osd {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    animation: in var(--t-fast) var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
  .shade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to bottom, transparent 50%, rgba(0, 0, 0, 0.86));
  }
  .shade-top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 120rem;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5), transparent);
  }
  .bottom {
    position: absolute;
    left: 56rem;
    right: 56rem;
    bottom: 40rem;
  }
  .head {
    display: flex;
    align-items: flex-end;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .eyebrow,
  .left {
    color: var(--label-2);
  }
  .left {
    margin-left: 24rem;
  }
  .ends {
    color: var(--label-3);
  }
  .mono {
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
  }
  .bar {
    position: relative;
    margin-top: 8rem;
    padding: 12rem 0;
  }
  .track {
    position: relative;
    height: 8rem;
    border-radius: 4rem;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.22);
    transition: height var(--t-fast) var(--ease-out);
  }
  .scrubbing .track {
    height: 12rem;
  }
  .played {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: #fff;
    transform-origin: left;
  }
  .chapter {
    position: absolute;
    top: 0;
    width: 2rem;
    height: 100%;
    margin-left: -1rem;
    background: rgba(0, 0, 0, 0.6);
  }
  .target {
    position: absolute;
    bottom: 34rem;
    padding: 3rem 8rem;
    border-radius: var(--r-xs);
    background: #fff;
    color: #000;
    transform: translateX(-50%);
  }
  .controls {
    display: flex;
    align-items: center;
  }
  .position {
    margin-left: 10rem;
  }
  .spring {
    flex: 1;
  }
  .button {
    display: flex;
    align-items: center;
    margin-left: 8rem;
    padding: 7rem 14rem;
    border-radius: 999rem;
    color: var(--label-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .button > :global(*) + :global(*) {
    margin-left: 7rem;
  }
  .button:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.06);
  }
  .glyph {
    width: 16rem;
    height: 16rem;
  }
  .value {
    color: var(--label-3);
  }
  .button:global(.focused) .value {
    color: rgba(0, 0, 0, 0.55);
  }
</style>
