<script lang="ts">
  import { formatDuration } from '../../../shared/music';
  import { t } from '../../lib/i18n.svelte';
  import { command } from '../../lib/music-ui.svelte';

  // The song's position: a range input (keyboard and screen readers for free), times in Geist Mono. While the
  // thumb is dragged the shown time follows it; the seek goes on release.
  let { positionMs, durationMs }: { positionMs: number; durationMs: number } = $props();

  let dragging = $state<number | null>(null);
  const shown = $derived(dragging ?? positionMs);
  const pct = $derived(durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0);

  // A click on the duration shows the time left instead (music spec C8), remembered on this device.
  const KEY = 'wicaby.music.remaining';
  let remaining = $state(read());
  function read(): boolean {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  }
  function toggle(): void {
    remaining = !remaining;
    try {
      localStorage.setItem(KEY, remaining ? '1' : '0');
    } catch {
      // Best effort: the choice lasts this session.
    }
  }
</script>

<div class="seek">
  <span class="time mono">{formatDuration(shown)}</span>
  <input
    type="range"
    min="0"
    max={Math.max(1, Math.round(durationMs))}
    step="1000"
    value={Math.round(shown)}
    style:--pct="{pct}%"
    aria-label={t('music.bar.seek')}
    aria-valuetext={`${formatDuration(shown)} / ${formatDuration(durationMs)}`}
    oninput={(e) => (dragging = Number(e.currentTarget.value))}
    onchange={(e) => {
      command({ type: 'seek', positionMs: Number(e.currentTarget.value) });
      dragging = null;
    }}
  />
  <button class="time mono end" title={t('music.barExtra.timeToggle')} aria-label={t('music.barExtra.timeToggle')} aria-pressed={remaining} data-time-toggle onclick={toggle}>
    {remaining ? `−${formatDuration(Math.max(0, durationMs - shown))}` : formatDuration(durationMs)}
  </button>
</div>

<style>
  .seek {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .end {
    padding: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .end:hover {
    color: var(--label);
  }
  .time {
    font-size: var(--fs-caption);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  input {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 14px;
    background: transparent;
    cursor: pointer;
  }
  input::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--accent) var(--pct), var(--fill-3) var(--pct));
  }
  input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--label);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  input:hover::-webkit-slider-thumb,
  input:focus-visible::-webkit-slider-thumb {
    opacity: 1;
  }
</style>
