<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { linux } from '../../lib/platform';
  import { settings } from '../../lib/stores.svelte';
  import { deviceOptions as outputOptions, languageOptions, set, type SettingsData } from './shared.svelte';

  let { data }: { data: SettingsData } = $props();

  const LANGUAGES = $derived(languageOptions());
  const SPDIF = $derived([
    { value: 'ac3', label: 'Dolby Digital', sub: 'AC3' },
    { value: 'eac3', label: 'Dolby Digital Plus', sub: 'E-AC3' },
    { value: 'dts', label: 'DTS', sub: 'DTS core' },
    { value: 'dts-hd', label: 'DTS-HD Master Audio', sub: 'DTS-HD MA' },
    { value: 'truehd', label: 'Dolby TrueHD', sub: t('settings.audio.atmosIncluded') },
  ]);

  const s = $derived(settings.value);

  // ---- Audio output devices (mpv) ----
  const devices = $derived(data.devices);
  const devicesLoading = $derived(data.devicesLoading);
  const deviceOptions = $derived(outputOptions(devices, s?.playback.audioDevice ?? 'auto', linux));

  // Music (music-spec MU-02): ReplayGain mode, preamp and the engine's options.
  const RG_MODES = $derived([
    { value: 'album' as const, label: t('settings.audio.music.replayGainAlbum') },
    { value: 'track' as const, label: t('settings.audio.music.replayGainTrack') },
    { value: 'auto' as const, label: t('settings.audio.music.replayGainAuto') },
    { value: 'off' as const, label: t('settings.audio.music.replayGainOff') },
  ]);
  const PREAMPS = $derived([-15, -12, -9, -6, -3, 0, 3, 6].map((db) => ({ value: db, label: t('settings.audio.music.preampValue', { db: db > 0 ? `+${db}` : String(db) }) })));
  const builtInMusic = $derived(s?.playback.playerByType.music === 'html' || (s?.playback.playerByType.music === 'default' && s?.playback.player === 'html'));

  function toggleSpdif(codec: string, on: boolean): void {
    if (!s) return;
    const next = on ? [...new Set([...s.playback.spdif, codec])] : s.playback.spdif.filter((c) => c !== codec);
    void set({ playback: { spdif: next } });
  }
</script>

{#if s}
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.output.label')}</div>
        <div class="desc">
          {#if devicesLoading}{t('settings.audio.output.searching')}{:else if devices !== null && devices.length === 0}{t('settings.audio.output.needsMpv')}{:else}{t(linux ? 'settings.audio.output.descLinux' : 'settings.audio.output.desc')}{/if}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="push ghost" title={t('settings.audio.output.refresh')} aria-label={t('settings.audio.output.refresh')} disabled={devicesLoading} onclick={data.loadDevices}>
          <Icon name="refresh" size={14} />
        </button>
        <Picker label={t('settings.audio.output.label')} value={s.playback.audioDevice} options={deviceOptions} onchange={(v) => set({ playback: { audioDevice: v } })} />
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.language.label')}</div>
        <div class="desc">{t('settings.audio.language.desc')}</div>
      </div>
      <Picker label={t('settings.audio.language.aria')} value={s.playback.preferredAudioLanguage} options={LANGUAGES} onchange={(v) => set({ playback: { preferredAudioLanguage: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t(linux ? 'settings.audio.exclusive.labelLinux' : 'settings.audio.exclusive.label')}</div>
        <div class="desc">{t(linux ? 'settings.audio.exclusive.descLinux' : 'settings.audio.exclusive.desc')}</div>
      </div>
      <Toggle label={t(linux ? 'settings.audio.exclusive.labelLinux' : 'settings.audio.exclusive.label')} checked={s.playback.audioExclusive} onchange={(v) => set({ playback: { audioExclusive: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.audio.volume')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.normalize.label')}</div>
        <div class="desc">{t('settings.audio.normalize.desc')}</div>
      </div>
      <Toggle label={t('settings.audio.normalize.label')} checked={s.playback.normalize} onchange={(v) => set({ playback: { normalize: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.boost.label')}</div>
        <div class="desc">{t('settings.audio.boost.desc')}</div>
      </div>
      <Toggle label={t('settings.audio.boost.label')} checked={s.playback.volumeBoost} onchange={(v) => set({ playback: { volumeBoost: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.night.label')}</div>
        <div class="desc">{t('settings.audio.night.desc')}</div>
      </div>
      <Toggle label={t('settings.audio.night.label')} checked={s.playback.nightMode} onchange={(v) => set({ playback: { nightMode: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.audio.dialogue.label')}</div>
        <div class="desc">{t('settings.audio.dialogue.desc')}</div>
      </div>
      <Toggle label={t('settings.audio.dialogue.label')} checked={s.playback.dialogueBoost} onchange={(v) => set({ playback: { dialogueBoost: v } })} />
    </div>
  </div>
  <p class="foot">{t('settings.audio.volumeFoot')}</p>

  <h3 class="gh">{t('settings.audio.passthrough')}</h3>
  <div class="group">
    {#each SPDIF as codec (codec.value)}
      <div class="row">
        <div class="txt">
          <div class="lbl">{codec.label}</div>
          <div class="desc">{codec.sub}</div>
        </div>
        <Toggle label={codec.label} checked={s.playback.spdif.includes(codec.value)} onchange={(v) => toggleSpdif(codec.value, v)} />
      </div>
    {/each}
  </div>
  <p class="foot">{t(linux ? 'settings.audio.passthroughFootLinux' : 'settings.audio.passthroughFoot')}</p>

  <h3 class="gh">{t('settings.audio.music.title')}</h3>
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
  {#if builtInMusic}<p class="foot">{t('settings.audio.music.fallbackNote')}</p>{/if}
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
    transition: background-color var(--t-fast) var(--ease);
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
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
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .actions .push.ghost:has(:global(svg)) {
    width: 28px;
    padding: 0;
    display: grid;
    place-items: center;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
