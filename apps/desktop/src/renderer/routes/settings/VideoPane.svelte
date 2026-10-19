<script lang="ts">
  import { ASPECT_MODES, type Settings } from '../../../shared/contract';
  import { parseMpvArgs } from '../../../shared/mpv-args';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { w } from '../../lib/bridge';
  import { t, tParts } from '../../lib/i18n.svelte';
  import { web } from '../../lib/platform';
  import { errorMessage, settings, toast } from '../../lib/stores.svelte';
  import { copy, set, type SettingsData } from './shared.svelte';

  let { data }: { data: SettingsData } = $props();

  // Option lists are $derived so their labels follow a language switch.
  // AppInfo.platform is os.type() + arch: "Linux x64", "Windows_NT x64".
  const linux = $derived(data.info?.platform.startsWith('Linux') ?? false);
  // DisplayModeSwitcher.available(): always on Windows; on Linux only where xrandr or kscreen-doctor can switch.
  const refreshOk = $derived(data.info?.refreshRateMatch ?? true);
  const HWDEC = $derived<{ value: Settings['playback']['hwdec']; label: string }[]>([
    { value: 'auto-safe', label: t('common.status.auto') },
    ...(linux
      ? [
          { value: 'vaapi' as const, label: 'VA-API' },
          { value: 'nvdec' as const, label: 'NVDEC' },
          { value: 'vulkan' as const, label: 'Vulkan' },
        ]
      : [
          { value: 'd3d11va' as const, label: 'D3D11VA' },
          { value: 'nvdec' as const, label: 'NVDEC' },
        ]),
    { value: 'no', label: t('settings.playback.hwdec.off') },
  ]);
  const ASPECTS = $derived(ASPECT_MODES.map((v) => ({ value: v, label: t(`player.aspect.modes.${v}`) })));

  const s = $derived(settings.value);
  const info = $derived(data.info);

  async function pickMpv(): Promise<void> {
    // Main validates the file and saves the path itself.
    const path = await w.settings.pickMpv().catch((err: unknown) => {
      toast('error', errorMessage(err));
      return null;
    });
    if (!path) return;
    await data.refreshInfo();
    data.devices = null;
    if (data.info?.mpvVersion) toast('success', t('settings.playback.mpv.detected', { version: data.info.mpvVersion }));
  }

  async function resetMpv(): Promise<void> {
    await set({ playback: { mpvPath: '' } });
    await data.refreshInfo();
  }

  // ---- mpv arguments: edited as a draft, saved on blur or Entrée ----
  let mpvArgsDraft = $state<string | null>(null);
  const mpvArgsText = $derived(mpvArgsDraft ?? s?.playback.mpvArgs ?? '');
  const mpvArgsRejected = $derived(parseMpvArgs(mpvArgsText).rejected);
  function saveMpvArgs(): void {
    if (mpvArgsDraft === null || mpvArgsDraft === s?.playback.mpvArgs) return;
    void set({ playback: { mpvArgs: mpvArgsDraft } }).then(() => (mpvArgsDraft = null));
  }
</script>

{#if s}
  <h3 class="gh">{t('settings.video.picture')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.aspect.label')}</div>
        <div class="desc">{t('settings.playback.aspect.desc')}</div>
      </div>
      <Picker label={t('settings.playback.aspect.label')} value={s.playback.aspect} options={ASPECTS} onchange={(v) => set({ playback: { aspect: v } })} />
    </div>
    <!-- The web TV app (lib/platform.ts): no mpv, no display-mode switching. -->
    {#if !web}
      <div class="row">
        <div class="txt">
          <div class="lbl">
            {t('settings.playback.smooth.label')}
            <button type="button" class="why" aria-label={t('settings.playback.smooth.why')} title={t('settings.playback.smooth.why')}><Icon name="info" size={13} /></button>
          </div>
          <div class="desc">{t('settings.playback.smooth.desc')}</div>
        </div>
        <Toggle label={t('settings.playback.smooth.label')} checked={s.playback.smoothMotion} onchange={(v) => set({ playback: { smoothMotion: v } })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.playback.matchRefresh.label')}</div>
          <div class="desc">{t(refreshOk ? 'settings.playback.matchRefresh.desc' : 'settings.playback.matchRefresh.unavailable')}</div>
        </div>
        <Toggle label={t('settings.playback.matchRefresh.label')} checked={refreshOk && s.playback.matchRefreshRate} disabled={!refreshOk} onchange={(v) => set({ playback: { matchRefreshRate: v } })} />
      </div>
    {/if}
  </div>

  {#if !web}
    <h3 class="gh">{t('settings.video.decoding')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.playback.hwdec.label')}</div>
          <div class="desc">{t(linux ? 'settings.playback.hwdec.descLinux' : 'settings.playback.hwdec.desc')}</div>
        </div>
        <Picker label={t('settings.playback.hwdec.label')} value={s.playback.hwdec} options={HWDEC} onchange={(v) => set({ playback: { hwdec: v } })} />
      </div>
      <!-- Linux plays SDR only (X11 has no HDR output), so both HDR switches are Windows-only. -->
      {#if !linux}
        <div class="row">
          <div class="txt">
            <div class="lbl">{t('settings.playback.hdrPassthrough.label')}</div>
            <div class="desc">{t('settings.playback.hdrPassthrough.desc')}</div>
          </div>
          <Toggle label={t('settings.playback.hdrPassthrough.label')} checked={s.playback.hdrPassthrough} onchange={(v) => set({ playback: { hdrPassthrough: v } })} />
        </div>
        <div class="row">
          <div class="txt">
            <div class="lbl">{t('settings.playback.hdrAuto.label')}</div>
            <div class="desc">{t('settings.playback.hdrAuto.desc')}</div>
          </div>
          <Toggle label={t('settings.playback.hdrAuto.label')} checked={s.playback.hdrAutoSwitch} onchange={(v) => set({ playback: { hdrAutoSwitch: v } })} />
        </div>
      {/if}
    </div>

    <h3 class="gh">{t('settings.playback.mpv.title')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">
            mpv
            {#if info}
              {#if info.mpvPath}
                <span class="meta-val">{info.mpvVersion ?? t('settings.playback.mpv.unknownVersion')}</span>
              {:else}
                <span class="meta-val warn">{t('settings.playback.mpv.notFound')}</span>
              {/if}
            {/if}
          </div>
          {#if info?.mpvPath}
            <button type="button" class="path mono" title={t('settings.playback.mpv.copyPath')} onclick={() => copy(info!.mpvPath!)}>{info.mpvPath}</button>
          {:else}
            <div class="desc">
              {#if linux}{t('settings.playback.mpv.missingLinux')}{:else}{#each tParts('settings.playback.mpv.missing') as part, i (i)}{#if part.slot === 'command'}<span class="mono">npm run fetch-mpv</span>{:else}{part.text}{/if}{/each}{/if}
            </div>
          {/if}
        </div>
        <div class="actions">
          {#if s.playback.mpvPath}
            <button type="button" class="push ghost" onclick={resetMpv}>{t('settings.playback.mpv.autoDetect')}</button>
          {/if}
          <button type="button" class="push" onclick={pickMpv}>{t('settings.playback.mpv.choose')}</button>
        </div>
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.playback.mpvConf.label')}</div>
          <div class="desc">{t('settings.playback.mpvConf.desc')}</div>
        </div>
        <div class="actions">
          <button type="button" class="push ghost" onclick={() => w.app.openPath('mpv-config')}>{t('settings.playback.mpvConf.openFolder')}</button>
          <Toggle label={t('settings.playback.mpvConf.label')} checked={s.playback.useMpvConfig} onchange={(v) => set({ playback: { useMpvConfig: v } })} />
        </div>
      </div>
      <div class="row stack">
        <div class="txt">
          <div class="lbl">{t('settings.advanced.mpvArgs.label')}</div>
          <div class="desc">
            {#each tParts('settings.advanced.mpvArgs.desc') as part, i (i)}{#if part.slot === 'example'}<span class="mono">--deband=yes</span>{:else}{part.text}{/if}{/each}
          </div>
        </div>
        <input
          class="field mono"
          type="text"
          spellcheck="false"
          placeholder={t('settings.advanced.mpvArgs.placeholder')}
          aria-label={t('settings.advanced.mpvArgs.aria')}
          value={mpvArgsText}
          oninput={(e) => (mpvArgsDraft = e.currentTarget.value)}
          onblur={saveMpvArgs}
          onkeydown={(e) => {
            if (e.key === 'Enter') saveMpvArgs();
          }}
        />
        {#if mpvArgsRejected.length > 0}
          <div class="desc warn">{t('settings.advanced.mpvArgs.rejected', { args: mpvArgsRejected.join(' ') })}</div>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .why {
    display: inline-grid;
    place-items: center;
    vertical-align: -2px;
    margin-left: 4px;
    color: var(--label-3);
    cursor: help;
  }
  .why:is(:hover, :focus-visible) {
    color: var(--label);
  }
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
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
  .desc.warn {
    color: var(--warning);
  }
  .meta-val {
    font-size: var(--fs-footnote);
    font-weight: 400;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .meta-val.warn {
    color: var(--warning);
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
  .path {
    display: block;
    max-width: 100%;
    margin-top: 3px;
    font-size: var(--fs-caption);
    color: var(--label-3);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  button.path:hover {
    color: var(--label-2);
  }
  .row.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .field {
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-footnote);
    color: var(--label);
    outline: none;
  }
  .field:focus {
    background: var(--fill-2);
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
