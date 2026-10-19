<script lang="ts">
  import { untrack } from 'svelte';
  import { EQ_FREQS, EQ_MAX_DB } from '../../../shared/equalizer';
  import { t } from '../../lib/i18n.svelte';

  // The 10 bands of the music equalizer (MU-11), one vertical slider each; Settings > Audio holds the preset and
  // preamp rows. A change is saved on release (each new filter chain reinitialises mpv's output).
  let { bands, onchange }: { bands: number[]; onchange: (bands: number[]) => void } = $props();

  // The bands as moved but not yet saved: the label follows the thumb, and held arrow keys save once (300 ms).
  let draft = $state<number[] | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const shown = $derived(draft ?? bands);
  // A fresh bands array (the save echoed back, or a preset) replaces the draft.
  $effect(() => {
    void bands;
    untrack(() => !saveTimer && (draft = null));
  });
  function move(i: number, v: number): void {
    draft = shown.map((g, j) => (j === i ? v : g));
  }
  function save(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (draft) onchange(draft);
    }, 300);
  }

  const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));
  const db = (g: number) => (g > 0 ? `+${g}` : String(g));
</script>

<div class="bands" data-eq-bands>
  {#each EQ_FREQS as f, i (f)}
    <label class="band">
      <span class="mono caption" data-db={shown[i]}>{db(shown[i])}</span>
      <input
        type="range"
        min={-EQ_MAX_DB}
        max={EQ_MAX_DB}
        step="1"
        value={shown[i]}
        aria-label={t('music.eq.band', { freq: hz(f) })}
        aria-valuetext={t('music.eq.value', { db: db(shown[i]) })}
        oninput={(e) => move(i, Number(e.currentTarget.value))}
        onchange={(e) => (move(i, Number(e.currentTarget.value)), save())}
      />
      <span class="caption hz">{hz(f)}</span>
    </label>
  {/each}
</div>

<style>
  .bands {
    display: grid;
    grid-template-columns: repeat(10, minmax(0, 1fr));
    gap: 4px;
    padding: 14px 18px 12px;
  }
  .band {
    display: grid;
    justify-items: center;
    gap: 6px;
    color: var(--label-2);
  }
  .hz {
    color: var(--label-3);
  }
  input {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 20px;
    height: 120px;
    accent-color: var(--accent);
  }
</style>
