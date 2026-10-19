<script lang="ts">
  import { TICKS_PER_MS, type CastCommand } from '../../shared/contract';
  import type { MediaStream } from '../../shared/models';
  import { apiFor } from '../lib/api';
  import { w } from '../lib/bridge';
  import { cast } from '../lib/cast.svelte';
  import { clock } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Picker from './Picker.svelte';
  import Sheet from './Sheet.svelte';

  // The remote sheet (cast-spec §2.3): controls the target does not take are disabled and say so.
  let { open, onclose }: { open: boolean; onclose: () => void } = $props();

  const STEP_TICKS = 10_000 * TICKS_PER_MS;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  const s = $derived(cast.state);
  const c = $derived(s?.controls);
  const duration = $derived(s?.item?.runTimeTicks ?? 0);
  const na = t('cast.remote.unavailable');
  let drag = $state<number | null>(null);
  // The released point stays shown until the device reports it (or 3 s): a seek is a LAN round trip.
  let landing = $state<number | null>(null);
  let landingTimer: ReturnType<typeof setTimeout> | null = null;
  const shown = $derived(drag ?? landing ?? s?.positionTicks ?? 0);
  $effect(() => {
    if (landing !== null && Math.abs((s?.positionTicks ?? 0) - landing) < 1500 * TICKS_PER_MS) landing = null;
  });
  let rate = $state(1);
  let streams = $state<MediaStream[]>([]);

  // The item's tracks, from its own server (the target reports only the indexes).
  $effect(() => {
    const id = s?.item?.id;
    const server = s?.serverId;
    if (!open || !id) return;
    let live = true;
    apiFor(server)
      .item(id)
      .then((i) => live && (streams = i.MediaSources?.[0]?.MediaStreams ?? i.MediaStreams ?? []), () => undefined);
    return () => {
      live = false;
    };
  });

  const label = (m: MediaStream) => m.DisplayTitle || m.Title || m.Language || `#${m.Index}`;
  const audioOptions = $derived(streams.filter((m) => m.Type === 'Audio').map((m) => ({ value: m.Index, label: label(m) })));
  const subOptions = $derived([{ value: -1, label: t('player.tracks.off') }, ...streams.filter((m) => m.Type === 'Subtitle').map((m) => ({ value: m.Index, label: label(m) }))]);

  function send(cmd: CastCommand): void {
    w.cast.control(cmd).catch((err) => toast('error', errorMessage(err)));
  }
</script>

<Sheet {open} {onclose} label={s ? t('cast.bar.castingTo', { device: s.target.name }) : t('cast.button')} width={480}>
  {#if s && c}
    <div class="body">
      <h2 class="title-3">{s.item?.name ?? ''}</h2>
      <p class="sub">{t('cast.bar.castingTo', { device: s.target.name })}</p>

      <div class="seek">
        <span class="time tabular">{clock(shown / TICKS_PER_MS)}</span>
        <input
          type="range"
          class="cast-slider"
          min="0"
          max={duration || 1}
          step={TICKS_PER_MS * 1000}
          value={shown}
          disabled={!duration}
          aria-label={t('player.osd.position')}
          aria-valuetext={clock(shown / TICKS_PER_MS)}
          oninput={(e) => (drag = +e.currentTarget.value)}
          onchange={(e) => {
            landing = +e.currentTarget.value;
            if (landingTimer) clearTimeout(landingTimer);
            landingTimer = setTimeout(() => (landing = null), 3000);
            send({ type: 'seek', positionTicks: landing });
            drag = null;
          }}
        />
        <span class="time tabular">{duration ? clock(duration / TICKS_PER_MS) : ''}</span>
      </div>

      <div class="transport">
        <button class="btn icon ghost" disabled={!c.nextPrev} aria-label={t('player.osd.previous')} title={c.nextPrev ? t('player.osd.previous') : na} onclick={() => send({ type: 'previous' })}><Icon name="prev" size={18} fill /></button>
        <button class="btn icon ghost" aria-label={t('player.osd.skipBack', { seconds: 10 })} onclick={() => send({ type: 'seek-relative', deltaTicks: -STEP_TICKS })}><Icon name="back10" size={18} /></button>
        <button class="btn icon light lg" data-autofocus aria-label={s.paused ? t('player.osd.play') : t('player.osd.pause')} onclick={() => send({ type: 'toggle-pause' })}>
          <Icon name={s.paused ? 'play' : 'pause'} size={20} fill />
        </button>
        <button class="btn icon ghost" aria-label={t('player.osd.skipForward', { seconds: 10 })} onclick={() => send({ type: 'seek-relative', deltaTicks: STEP_TICKS })}><Icon name="fwd30" size={18} /></button>
        <button class="btn icon ghost" disabled={!c.nextPrev} aria-label={t('player.osd.next')} title={c.nextPrev ? t('player.osd.next') : na} onclick={() => send({ type: 'next' })}><Icon name="next" size={18} fill /></button>
      </div>

      <div class="row">
        <span class="lbl">{t('cast.remote.volume')}</span>
        <button class="btn icon ghost" disabled={!c.mute} aria-label={t('player.osd.mute')} aria-pressed={Boolean(s.muted)} title={c.mute ? t('player.osd.mute') : na} onclick={() => send({ type: 'mute', value: !s.muted })}>
          <Icon name={s.muted ? 'mute' : 'volume'} size={16} />
        </button>
        <input
          type="range"
          class="cast-slider grow"
          min="0"
          max="100"
          step="5"
          value={s.volume ?? 100}
          disabled={!c.volume}
          title={c.volume ? undefined : na}
          aria-label={c.volume ? t('cast.remote.volume') : `${t('cast.remote.volume')}, ${na}`}
          onchange={(e) => send({ type: 'volume', value: +e.currentTarget.value })}
        />
      </div>
      <div class="row">
        <span class="lbl">{t('cast.remote.audio')}</span>
        {#if c.audio && audioOptions.length}
          <Picker label={t('cast.remote.audio')} value={s.audio ?? audioOptions[0].value} options={audioOptions} onchange={(v) => send({ type: 'audio', index: v })} />
        {:else}<span class="na">{c.audio ? t('player.tracks.noTracks') : na}</span>{/if}
      </div>
      <div class="row">
        <span class="lbl">{t('cast.remote.subtitles')}</span>
        {#if c.subtitles}
          <Picker label={t('cast.remote.subtitles')} value={s.sub ?? -1} options={subOptions} onchange={(v) => send({ type: 'subtitle', index: v })} />
        {:else}<span class="na">{na}</span>{/if}
      </div>
      {#if c.rate}
        <div class="row">
          <span class="lbl">{t('player.speed.label')}</span>
          <Picker label={t('player.speed.label')} value={rate} options={SPEEDS.map((v) => ({ value: v, label: t('player.speed.rate', { rate: v }) }))} onchange={(v) => ((rate = v), send({ type: 'rate', value: v }))} />
        </div>
      {/if}

      <div class="actions">
        <button class="btn" onclick={() => (onclose(), void w.cast.takeBack())}><Icon name="laptop" size={16} /> {t('cast.remote.playHere')}</button>
        <button class="btn danger" onclick={() => (onclose(), void w.cast.stop())}>{t('cast.remote.stop')}</button>
      </div>
    </div>
  {/if}
</Sheet>

<style>
  .body {
    padding: 24px;
  }
  h2 {
    margin: 0;
    padding-right: 40px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    margin: 2px 0 16px;
    color: var(--label-2);
  }
  .seek,
  .row,
  .transport,
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .seek input {
    flex: 1;
  }
  .time {
    min-width: 48px;
    font-size: 12px;
    color: var(--label-2);
  }
  .seek .time:last-child {
    text-align: right;
  }
  .transport {
    justify-content: center;
    margin: 12px 0 18px;
  }
  .row {
    min-height: 40px;
  }
  .lbl {
    width: 110px;
    flex: none;
    color: var(--label-2);
  }
  .grow {
    flex: 1;
  }
  .na {
    font-size: 13px;
    color: var(--label-3);
  }
  .actions {
    justify-content: flex-end;
    margin-top: 18px;
  }
</style>
