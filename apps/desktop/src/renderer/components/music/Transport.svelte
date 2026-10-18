<script lang="ts">
  import { t } from '../../lib/i18n.svelte';
  import { command } from '../../lib/music-ui.svelte';
  import { playback } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';

  // Shuffle, previous, play/pause, next, repeat: the bar's and the full-screen player's controls. On = a --fill-2
  // background (Graphite: one accent, the play button).
  let { large = false }: { large?: boolean } = $props();

  const s = $derived(playback.value);
  const m = $derived(s?.music);
  const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' } as const;
  const repeatLabel = $derived(t(m?.repeat === 'all' ? 'music.bar.repeatAll' : m?.repeat === 'one' ? 'music.bar.repeatOne' : 'music.bar.repeatOff'));
</script>

<div class="transport" class:large>
  <button class="ctl side" data-ctl="shuffle" class:on={m?.shuffle} aria-pressed={Boolean(m?.shuffle)} title={t(m?.shuffle ? 'music.bar.shuffleOn' : 'music.bar.shuffleOff')} aria-label={t('music.actions.shuffle')} onclick={() => command({ type: 'shuffle', value: !m?.shuffle })}>
    <Icon name="shuffle" size={large ? 20 : 16} stroke={2} />
  </button>
  <button class="ctl" data-ctl="previous" title={t('music.bar.previous')} aria-label={t('music.bar.previous')} onclick={() => command({ type: 'previous' })}>
    <Icon name="prev" size={large ? 24 : 18} fill stroke={0} />
  </button>
  <button class="ctl play" data-ctl="play" title={t(s?.paused ? 'music.bar.play' : 'music.bar.pause')} aria-label={t(s?.paused ? 'music.bar.play' : 'music.bar.pause')} onclick={() => command({ type: 'toggle-pause' })}>
    <Icon name={s?.paused ? 'play' : 'pause'} size={large ? 26 : 18} fill stroke={0} />
  </button>
  <button class="ctl" data-ctl="next" title={t('music.bar.next')} aria-label={t('music.bar.next')} onclick={() => command({ type: 'next' })}>
    <Icon name="next" size={large ? 24 : 18} fill stroke={0} />
  </button>
  <button class="ctl side" data-ctl="repeat" class:on={m?.repeat !== 'off'} aria-pressed={m?.repeat !== 'off'} title={repeatLabel} aria-label={repeatLabel} onclick={() => command({ type: 'repeat', mode: NEXT_REPEAT[m?.repeat ?? 'off'] })}>
    <Icon name={m?.repeat === 'one' ? 'repeatOne' : 'repeat'} size={large ? 20 : 16} stroke={2} />
  </button>
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .ctl {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--label);
    transition:
      transform var(--t-med) var(--spring);
  }
  .ctl:hover,
  .ctl:focus-visible {
    background: var(--fill-2);
  }
  .ctl:active {
    transform: scale(0.92);
  }
  .side {
    color: var(--label-2);
    border-radius: var(--r-xs);
  }
  .side.on {
    background: var(--fill-2);
    color: var(--label);
  }
  .play {
    width: 38px;
    height: 38px;
    background: var(--accent);
    color: var(--accent-fg);
  }
  .play:hover,
  .play:focus-visible {
    background: color-mix(in srgb, var(--accent) 86%, #fff);
  }
  .large {
    gap: 14px;
  }
  .large .ctl {
    width: 48px;
    height: 48px;
  }
  .large .play {
    width: 64px;
    height: 64px;
  }
</style>
