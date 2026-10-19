<script lang="ts">
  import { SUBTITLE_FONTS, type SubtitleMode, type SubtitleStyle } from '../../../shared/contract';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/stores.svelte';
  import { languageOptions, set } from './shared.svelte';

  // Option lists are $derived so their labels follow a language switch.
  const LANGUAGES = $derived(languageOptions());
  const SUB_MODES = $derived(
    (['manual', 'foreign', 'always', 'default'] as SubtitleMode[]).map((v) => ({
      value: v,
      label: t(`settings.subtitles.modes.${v}.label`),
      desc: t(`settings.subtitles.modes.${v}.desc`),
    })),
  );
  const SUB_SIZES = $derived([
    { value: 75, label: t('settings.subtitles.size.small') },
    { value: 100, label: t('settings.subtitles.size.normal') },
    { value: 125, label: t('settings.subtitles.size.large') },
    { value: 150, label: t('settings.subtitles.size.xlarge') },
  ]);
  const SUB_COLORS = $derived([
    { value: '#FFFFFF', label: t('settings.subtitles.color.white') },
    { value: '#FFE14D', label: t('settings.subtitles.color.yellow') },
    { value: '#D1D1D6', label: t('settings.subtitles.color.lightGray') },
  ]);
  const SUB_POSITIONS = $derived([
    { value: 100, label: t('settings.subtitles.position.bottom') },
    { value: 95, label: t('settings.subtitles.position.slightlyRaised') },
    { value: 88, label: t('settings.subtitles.position.raised') },
  ]);

  const s = $derived(settings.value);

  function setStyle(patch: Partial<SubtitleStyle>): void {
    void set({ playback: { subtitleStyle: patch } });
  }
</script>

{#if s}
  {@const st = s.playback.subtitleStyle}
  <h3 class="gh">{t('settings.subtitles.languageDisplay')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.language.label')}</div>
        <div class="desc">{t('settings.subtitles.language.desc')}</div>
      </div>
      <Picker label={t('settings.subtitles.language.aria')} value={s.playback.preferredSubtitleLanguage} options={LANGUAGES} onchange={(v) => set({ playback: { preferredSubtitleLanguage: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.show.label')}</div>
        <div class="desc">{SUB_MODES.find((m) => m.value === s.playback.subtitleMode)?.desc}</div>
      </div>
      <Picker label={t('settings.subtitles.show.aria')} value={s.playback.subtitleMode} options={SUB_MODES} onchange={(v) => set({ playback: { subtitleMode: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.alwaysForced.label')}</div>
        <div class="desc">{t('settings.subtitles.alwaysForced.desc')}</div>
      </div>
      <Toggle label={t('settings.subtitles.alwaysForced.label')} checked={s.playback.alwaysForced} onchange={(v) => set({ playback: { alwaysForced: v } })} />
    </div>
  </div>
  <p class="foot">{t('settings.subtitles.forcedFoot')}</p>

  <h3 class="gh">{t('settings.subtitles.style')}</h3>
  <div class="group">
    <div class="sub-preview" aria-hidden="true">
      <span
        class="sub-sample"
        class:box={st.border === 'box'}
        class:shadow={st.border === 'shadow'}
        style:font-family={st.font === 'Geist' ? 'var(--font-sans)' : `'${st.font}', sans-serif`}
        style:color={st.color}
        style:font-size="{(17 * st.size) / 100}px"
        style:bottom="{(100 - st.position) * 1.6 + 10}px"
      >
        {t('settings.subtitles.sample')}
      </span>
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.subtitles.size.label')}</div></div>
      <Picker label={t('settings.subtitles.size.aria')} value={st.size} options={SUB_SIZES} onchange={(v) => setStyle({ size: v })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.scaleWithVideo.label')}</div>
        <div class="desc">{t('settings.subtitles.scaleWithVideo.desc')}</div>
      </div>
      <Toggle label={t('settings.subtitles.scaleWithVideo.label')} checked={st.scaleWithVideo} onchange={(v) => setStyle({ scaleWithVideo: v })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.subtitles.font.label')}</div></div>
      <Picker label={t('settings.subtitles.font.aria')} value={st.font} options={SUBTITLE_FONTS.map((f) => ({ value: f as string, label: f }))} onchange={(v) => setStyle({ font: v })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.color.label')}</div>
        <div class="desc">{SUB_COLORS.find((c) => c.value === st.color)?.label ?? st.color}</div>
      </div>
      <div class="accents" role="radiogroup" aria-label={t('settings.subtitles.color.aria')}>
        {#each SUB_COLORS as c (c.value)}
          <button type="button" class="swatch" role="radio" aria-checked={st.color === c.value} aria-label={c.label} title={c.label} style:--c={c.value} onclick={() => setStyle({ color: c.value })}></button>
        {/each}
      </div>
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.subtitles.border.label')}</div></div>
      <Segmented
        label={t('settings.subtitles.border.aria')}
        value={st.border}
        options={[
          { value: 'outline', label: t('settings.subtitles.border.outline') },
          { value: 'shadow', label: t('settings.subtitles.border.shadow') },
          { value: 'box', label: t('settings.subtitles.border.box') },
        ]}
        onchange={(v) => setStyle({ border: v })}
      />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.subtitles.position.label')}</div></div>
      <Picker label={t('settings.subtitles.position.aria')} value={st.position} options={SUB_POSITIONS} onchange={(v) => setStyle({ position: v })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.subtitles.overrideAss.label')}</div>
        <div class="desc">{t('settings.subtitles.overrideAss.desc')}</div>
      </div>
      <Toggle label={t('settings.subtitles.overrideAss.label')} checked={st.overrideAss} onchange={(v) => setStyle({ overrideAss: v })} />
    </div>
  </div>
  <p class="foot">
    {s.playback.useMpvConfig ? t('settings.subtitles.footMpvConf') : t('settings.subtitles.footStyle')}
  </p>
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

  /* Theme tiles */
  /* Subtitle preview: a dim frame with the sample text, styled like mpv renders it. */
  .sub-preview {
    position: relative;
    height: 128px;
    margin: 14px 14px 4px;
    border-radius: var(--r-xs);
    overflow: hidden;
    background:
      radial-gradient(90% 120% at 25% 10%, rgb(120 140 170 / 0.35), transparent 60%),
      radial-gradient(70% 90% at 85% 90%, rgb(170 120 90 / 0.25), transparent 60%),
      #0b0b0d;
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .sub-sample {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    max-width: 92%;
    padding: 1px 6px;
    font-weight: 500;
    line-height: 1.25;
    text-align: center;
    white-space: nowrap;
    text-shadow:
      -1.5px -1.5px 0 #000,
      1.5px -1.5px 0 #000,
      -1.5px 1.5px 0 #000,
      1.5px 1.5px 0 #000;
  }
  .sub-sample.shadow {
    text-shadow: 2px 2px 3px rgb(0 0 0 / 0.85);
  }
  .sub-sample.box {
    text-shadow: none;
    background: rgb(0 0 0 / 0.69);
    border-radius: 3px;
  }

  /* Accent swatches: small dots, a thin ring marks the current one. */
  .accents {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
  }
  .swatch::before {
    content: '';
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--c);
  }
  .swatch::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--label-2);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .swatch:hover::after,
  .swatch:focus-visible::after {
    opacity: 0.35;
  }
  .swatch[aria-checked='true']::after {
    opacity: 1;
  }
  :global(.searching) .foot,
  :global(.searching) .sub-preview {
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
