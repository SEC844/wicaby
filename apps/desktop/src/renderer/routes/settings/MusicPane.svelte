<script lang="ts">
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import Equalizer from '../../components/music/Equalizer.svelte';
  import { EQ_PRESETS, presetOf, type EqPreset } from '../../../shared/equalizer';
  import { t } from '../../lib/i18n.svelte';
  import { musicSourceOptions } from '../../lib/music-ui.svelte';
  import { settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  const s = $derived(settings.value);

  // Music (music-spec MU-02): ReplayGain mode, preamp and the engine's options.
  const RG_MODES = $derived([
    { value: 'album' as const, label: t('settings.audio.music.replayGainAlbum') },
    { value: 'track' as const, label: t('settings.audio.music.replayGainTrack') },
    { value: 'auto' as const, label: t('settings.audio.music.replayGainAuto') },
    { value: 'off' as const, label: t('settings.audio.music.replayGainOff') },
  ]);
  const PREAMPS = $derived([-15, -12, -9, -6, -3, 0, 3, 6].map((db) => ({ value: db, label: t('settings.audio.music.preampValue', { db: db > 0 ? `+${db}` : String(db) }) })));
  // Equalizer (MU-11): a preset writes its bands; moving a band makes it 'custom'.
  const eq = $derived(s?.music.eq);
  const eqPreset = $derived(eq ? presetOf(eq.bands) : 'flat');
  const EQ_NAMES = $derived({ flat: t('music.eq.preset.flat'), bass: t('music.eq.preset.bass'), vocal: t('music.eq.preset.vocal'), treble: t('music.eq.preset.treble'), custom: t('music.eq.preset.custom') });
  const EQ_OPTIONS = $derived([...(Object.keys(EQ_PRESETS) as EqPreset[]), ...(eqPreset === 'custom' ? (['custom'] as const) : [])].map((p) => ({ value: p, label: EQ_NAMES[p] })));
  const EQ_PREAMPS = $derived([-12, -9, -6, -3, 0, 3, 6].map((db) => ({ value: db, label: t('music.eq.value', { db: db > 0 ? `+${db}` : String(db) }) })));
  const setEq = (patch: { bands?: number[]; preampDb?: number }) => eq && set({ music: { eq: { ...eq, ...patch } } });
  const SOURCES = $derived(musicSourceOptions());
  const builtInMusic = $derived(s?.playback.playerByType.music === 'html' || (s?.playback.playerByType.music === 'default' && s?.playback.player === 'html'));
</script>

{#if s}
  <h3 class="gh">{t('settings.music.source')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.music.source')}</div>
        <div class="desc">{t('settings.audio.music.sourceHint')}</div>
      </div>
      <Picker label={t('settings.audio.music.source')} value={s.music.source} options={SOURCES} onchange={(v) => set({ music: { source: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.music.playback')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.music.gapless')}</div>
        <div class="desc">{t('settings.audio.music.gaplessHint')}</div>
      </div>
      <Toggle label={t('settings.audio.music.gapless')} checked={s.music.gapless} onchange={(v) => set({ music: { gapless: v } })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.audio.music.resumeQueue')}</div></div>
      <Toggle label={t('settings.audio.music.resumeQueue')} checked={s.music.resumeQueue} onchange={(v) => set({ music: { resumeQueue: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.music.volume')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.music.replayGain')}</div>
        <div class="desc">{t('settings.audio.music.replayGainDesc')}</div>
      </div>
      <Picker label={t('settings.audio.music.replayGain')} value={s.music.replayGain} options={RG_MODES} onchange={(v) => set({ music: { replayGain: v } })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.audio.music.preamp')}</div></div>
      <Picker label={t('settings.audio.music.preamp')} value={s.music.preampDb} options={PREAMPS} onchange={(v) => set({ music: { preampDb: v } })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.audio.music.preventClipping')}</div></div>
      <Toggle label={t('settings.audio.music.preventClipping')} checked={s.music.preventClipping} onchange={(v) => set({ music: { preventClipping: v } })} />
    </div>
  </div>
  {#if builtInMusic}<p class="foot">{t('settings.audio.music.fallbackNote')}</p>{/if}

  <h3 class="gh">{t('settings.music.lyrics')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.music.lyricsOnline')}</div>
        <div class="desc">{t('settings.audio.music.lyricsOnlineHint')}</div>
      </div>
      <Toggle label={t('settings.audio.music.lyricsOnline')} checked={s.music.lyricsProvider === 'server+lrclib'} onchange={(v) => set({ music: { lyricsProvider: v ? 'server+lrclib' : 'server' } })} />
    </div>
  </div>

  <h3 class="gh">{t('music.eq.title')}</h3>
  <div class="group" data-eq>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('music.eq.preset.label')}</div>
        <div class="desc">{t('music.eq.desc')}</div>
      </div>
      <div class="actions">
        <button type="button" class="push ghost" disabled={eqPreset === 'flat' && !s.music.eq.preampDb} onclick={() => set({ music: { eq: { bands: [...EQ_PRESETS.flat], preampDb: 0 } } })}>{t('music.eq.reset')}</button>
        <Picker label={t('music.eq.preset.label')} value={eqPreset} options={EQ_OPTIONS} onchange={(v) => v !== 'custom' && setEq({ bands: [...EQ_PRESETS[v]] })} />
      </div>
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('music.eq.preamp')}</div></div>
      <Picker label={t('music.eq.preamp')} value={s.music.eq.preampDb} options={EQ_PREAMPS} onchange={(v) => setEq({ preampDb: v })} />
    </div>
    <div class="row bands-row"><Equalizer bands={s.music.eq.bands} onchange={(bands) => setEq({ bands })} /></div>
  </div>
  {#if builtInMusic}<p class="foot">{t('music.eq.htmlNote')}</p>{/if}
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  /* Hairline between rows, inset to the text edge. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }

  /* Push button: small, neutral. */
  .push {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
  }
  .push.ghost {
    background: transparent;
    color: var(--label-2);
  }
  .push.ghost:hover,
  .push.ghost:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .row.bands-row {
    display: block;
    padding: 0;
  }
  :global(.searching) .foot {
    display: none;
  }
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
