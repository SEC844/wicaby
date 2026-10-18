<script lang="ts">
  import type { PlaybackCommand, PlaybackState } from '../../shared/contract';
  import { clock } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // X-04 sleep timer sheet: "end of this video" (of this programme in live) or a duration; while
  // a timer runs, +15 min and Cancel come first. The timer itself lives in main (state.sleep).
  let {
    open,
    sleep,
    live,
    now,
    onclose,
    oncommand,
  }: { open: boolean; sleep: PlaybackState['sleep']; live: boolean; now: number; onclose: () => void; oncommand: (c: PlaybackCommand) => void } = $props();

  const MINUTES = [5, 10, 15, 30, 45, 60, 90, 120];
  const leftMs = $derived(sleep?.endsAt ? Math.max(0, sleep.endsAt - now) : null);

  function pick(minutes: number | 'eov' | null): void {
    oncommand({ type: 'sleep', minutes });
    onclose();
  }
</script>

<Sheet {open} {onclose} label={t('player.sleep.title')} width={360}>
  <div class="body">
    <h2 class="title-3">{t('player.sleep.title')}</h2>
    {#if sleep}
      <p class="footnote">{leftMs !== null ? t('player.osd.sleepActive', { time: clock(leftMs) }) : t(live ? 'player.sleep.endOfProgram' : 'player.sleep.endOfVideo')}</p>
    {/if}
    <ul class="rows">
      {#if sleep}
        {#if leftMs !== null}
          <li><button data-autofocus onclick={() => pick(leftMs / 60_000 + 15)}><Icon name="plus" size={15} /> {t('player.sleep.extend')}</button></li>
        {/if}
        <li><button data-autofocus={leftMs === null || undefined} onclick={() => pick(null)}><Icon name="close" size={15} /> {t('player.sleep.cancel')}</button></li>
      {/if}
      <li>
        <button role="menuitemradio" aria-checked={sleep?.minutes === 'eov'} onclick={() => pick('eov')}>
          <span class="check">{#if sleep?.minutes === 'eov'}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
          {t(live ? 'player.sleep.endOfProgram' : 'player.sleep.endOfVideo')}
        </button>
      </li>
      {#each MINUTES as m (m)}
        <li>
          <button role="menuitemradio" aria-checked={sleep?.minutes === m} onclick={() => pick(m)}>
            <span class="check">{#if sleep?.minutes === m}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
            {t('player.sleep.minutes', { count: m })}
          </button>
        </li>
      {/each}
    </ul>
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0;
    padding-right: 40px;
  }
  .footnote {
    margin: 4px 0 0;
    font-variant-numeric: tabular-nums;
  }
  .rows {
    list-style: none;
    margin: 14px -8px 0;
    padding: 0;
  }
  .rows button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .rows button:hover,
  .rows button:focus-visible {
    background: var(--fill-2);
  }
  .check {
    width: 16px;
    display: grid;
    place-items: center;
  }
</style>
