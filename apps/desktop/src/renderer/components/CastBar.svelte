<script lang="ts">
  import { TICKS_PER_MS, type CastCommand } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { cast } from '../lib/cast.svelte';
  import { clock } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import CastRemote from './CastRemote.svelte';
  import Icon from './Icon.svelte';

  // While casting (cast-spec CA-04): above the content, the item, "Lecture sur {device}", play/pause and a seek bar.
  // Space and ←/→ drive the cast while the bar has focus; the remote button opens the full remote sheet.
  const STEP_TICKS = 10_000 * TICKS_PER_MS;

  let remoteOpen = $state(false);
  let drag = $state<number | null>(null);
  const s = $derived(cast.state);
  const duration = $derived(s?.item?.runTimeTicks ?? 0);
  const playing = $derived(s?.status === 'playing');
  const poster = $derived(s?.item ? imageUrl(s.item.id, 'Primary', { server: s.serverId, maxHeight: 44 }) : '');

  function send(cmd: CastCommand): void {
    w.cast.control(cmd).catch((err) => toast('error', errorMessage(err)));
  }

  function keys(e: KeyboardEvent): void {
    if (!playing || e.target instanceof HTMLInputElement) return;
    if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) send({ type: 'toggle-pause' });
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') send({ type: 'seek-relative', deltaTicks: e.key === 'ArrowLeft' ? -STEP_TICKS : STEP_TICKS });
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if s}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="castbar" role="group" aria-label={t('cast.bar.castingTo', { device: s.target.name })} tabindex="0" onkeydown={keys}>
    {#if poster}<img class="poster" src={poster} alt="" />{:else}<span class="poster ph"><Icon name="cast" size={18} /></span>{/if}
    <div class="meta">
      <div class="name">{s.item?.seriesName ? `${s.item.seriesName} · ${s.item.name}` : (s.item?.name ?? '')}</div>
      <div class="sub">{t('cast.bar.castingTo', { device: s.target.name })}</div>
    </div>
    {#if s.status === 'failed'}
      <button class="btn" onclick={() => void w.cast.takeBack()}>{t('cast.remote.playHere')}</button>
    {:else}
      <button class="btn icon ghost" disabled={!playing} aria-label={s.paused ? t('player.osd.play') : t('player.osd.pause')} onclick={() => send({ type: 'toggle-pause' })}>
        <Icon name={s.paused ? 'play' : 'pause'} size={18} fill />
      </button>
      <span class="time tabular">{clock((drag ?? s.positionTicks) / TICKS_PER_MS)}</span>
      <input
        type="range"
        class="cast-slider seek"
        min="0"
        max={duration || 1}
        step={TICKS_PER_MS * 1000}
        value={drag ?? s.positionTicks}
        disabled={!playing || !duration}
        aria-label={t('player.osd.position')}
        aria-valuetext={clock((drag ?? s.positionTicks) / TICKS_PER_MS)}
        oninput={(e) => (drag = +e.currentTarget.value)}
        onchange={(e) => {
          send({ type: 'seek', positionTicks: +e.currentTarget.value });
          drag = null;
        }}
      />
      <span class="time tabular">{duration ? clock(duration / TICKS_PER_MS) : ''}</span>
      <button class="btn icon ghost" disabled={!playing} aria-haspopup="dialog" aria-label={t('cast.button')} title={t('cast.button')} onclick={() => (remoteOpen = true)}>
        <Icon name="cast" size={18} />
      </button>
    {/if}
    <button class="btn icon ghost" aria-label={t('cast.remote.stop')} title={t('cast.remote.stop')} onclick={() => void w.cast.stop()}><Icon name="close" size={16} /></button>
  </div>
  <CastRemote open={remoteOpen && playing} onclose={() => (remoteOpen = false)} />
{/if}

<style>
  .castbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 16px 8px;
    padding: 8px 10px;
    border-radius: var(--r-lg);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .castbar:focus-visible {
    outline: none;
    background: var(--fill-2);
  }
  .poster {
    width: 30px;
    height: 44px;
    flex: none;
    border-radius: 6px;
    object-fit: cover;
    background: var(--fill-2);
  }
  .ph {
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .meta {
    min-width: 0;
    flex: 0 1 260px;
  }
  .name,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-weight: 600;
  }
  .sub {
    font-size: 12px;
    color: var(--label-2);
  }
  .time {
    flex: none;
    min-width: 44px;
    font-size: 12px;
    color: var(--label-2);
  }
  .seek {
    flex: 1;
    min-width: 80px;
  }
  /* Shared with CastRemote (always mounted under this bar). */
  :global(.cast-slider) {
    height: 22px;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: pointer;
  }
  :global(.cast-slider:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  :global(.cast-slider::-webkit-slider-runnable-track) {
    height: 4px;
    border-radius: 2px;
    background: var(--fill-3);
  }
  :global(.cast-slider::-webkit-slider-thumb) {
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--label);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  }
  :global(.cast-slider:focus) {
    outline: none;
  }
  :global(.cast-slider:focus-visible::-webkit-slider-thumb) {
    box-shadow:
      0 0 0 4px var(--fill-3),
      0 1px 4px rgb(0 0 0 / 0.4);
  }
</style>
