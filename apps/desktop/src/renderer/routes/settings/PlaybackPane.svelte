<script lang="ts">
  import { ASPECT_MODES, type ResumeMode, type Settings, type SkipMode, type TypePlayer } from '../../../shared/contract';
  import { isLanAddress } from '../../../shared/network';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { w } from '../../lib/bridge';
  import { fmt, t, tParts } from '../../lib/i18n.svelte';
  import { errorMessage, session, settings, toast } from '../../lib/stores.svelte';
  import { copy, set, step, type SettingsData } from './shared.svelte';

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
  const BITRATES = [4, 8, 20, 40, 80, 120, 200];
  const RESOLUTIONS = $derived([
    { value: 0, label: t('settings.playback.maxResolution.unlimited') },
    { value: 2160, label: '4K (2160p)' },
    { value: 1440, label: '1440p' },
    { value: 1080, label: '1080p' },
    { value: 720, label: '720p' },
  ]);
  const SPEEDS = $derived([0.75, 1, 1.1, 1.25, 1.5, 2].map((v) => ({ value: v, label: v === 1 ? t('settings.playback.speed.normal') : `${fmt.number(v)}×` })));
  // X-05 "Mémoriser les réglages": one scope per player setting.
  const REMEMBER = $derived([
    { prop: 'speed', label: t('settings.playback.remember.speed') },
    { prop: 'audioDelay', label: t('settings.playback.remember.audioDelay') },
    { prop: 'subtitleDelay', label: t('settings.playback.remember.subtitleDelay') },
    { prop: 'aspect', label: t('settings.playback.remember.aspect') },
  ] as const);
  const SCOPES = $derived([
    { value: 'off' as const, label: t('settings.playback.remember.scope.off') },
    { value: 'global' as const, label: t('settings.playback.remember.scope.global') },
    { value: 'library' as const, label: t('settings.playback.remember.scope.library') },
    { value: 'title' as const, label: t('settings.playback.remember.scope.title') },
  ]);
  const COUNTDOWNS = $derived([5, 10, 15, 20, 30].map((v) => ({ value: v, label: step(v) })));
  const SHORT_STEPS = $derived([5, 10, 15, 20, 30].map((v) => ({ value: v, label: step(v) })));
  const LONG_STEPS = $derived([30, 60, 120, 300, 600].map((v) => ({ value: v, label: step(v) })));
  const RESUME = $derived<{ value: ResumeMode; label: string }[]>([
    { value: 'ask', label: t('settings.playback.resume.ask') },
    { value: 'resume', label: t('settings.playback.resume.resume') },
    { value: 'start', label: t('settings.playback.resume.start') },
  ]);
  const SKIP = $derived<{ value: SkipMode; label: string }[]>([
    { value: 'ask', label: t('settings.playback.skip.ask') },
    { value: 'auto', label: t('settings.playback.skip.auto') },
    { value: 'off', label: t('settings.playback.skip.off') },
  ]);
  const TYPE_PLAYERS = $derived<{ value: TypePlayer; label: string }[]>([
    { value: 'default', label: t('settings.playback.byType.sameAsAbove') },
    { value: 'mpv', label: 'mpv' },
    { value: 'html', label: t('settings.playback.player.builtIn') },
  ]);
  // Labels: settings.playback.byType.<key>.
  const CONTENT_TYPES: (keyof Settings['playback']['playerByType'])[] = ['movie', 'episode', 'music', 'live'];
  const REMINDER_LEADS = $derived(
    ([0, 1, 2, 5, 10] as const).map((v) => ({ value: v as Settings['live']['reminderLeadMin'], label: v ? t('settings.units.minutes', { count: v }) : t('settings.livetv.reminderLead.atStart') })),
  );
  const ASPECTS = $derived(ASPECT_MODES.map((v) => ({ value: v, label: t(`player.aspect.modes.${v}`) })));

  const s = $derived(settings.value);
  const info = $derived(data.info);
  const onLan = $derived(isLanAddress(session.value.address));

  async function forgetPlayerSettings(): Promise<void> {
    try {
      await w.playback.command({ type: 'forget-player-settings' });
      toast('success', t('settings.playback.remember.cleared'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

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
</script>

{#if s}
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.player.label')}</div>
        <div class="desc">{t('settings.playback.player.desc')}</div>
      </div>
      <Segmented
        label={t('settings.playback.player.label')}
        value={s.playback.player}
        options={[
          { value: 'auto', label: t('settings.playback.player.auto') },
          { value: 'mpv', label: 'mpv' },
          { value: 'html', label: t('settings.playback.player.builtIn') },
        ]}
        onchange={(v) => set({ playback: { player: v } })}
      />
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.byType.title')}</h3>
  <div class="group">
    {#each CONTENT_TYPES as type (type)}
      {@const typeLabel = t(`settings.playback.byType.${type}`)}
      <div class="row">
        <div class="txt"><div class="lbl">{typeLabel}</div></div>
        <Picker
          label={t('settings.playback.byType.aria', { type: typeLabel })}
          value={s.playback.playerByType[type]}
          options={TYPE_PLAYERS}
          onchange={(v) => set({ playback: { playerByType: { [type]: v } as Partial<Settings['playback']['playerByType']> } })}
        />
      </div>
    {/each}
  </div>

  <h3 class="gh">{t('settings.playback.quality')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.bitrateLocal.label')}</div>
        <div class="desc">{t('settings.playback.bitrateLocal.desc')}</div>
      </div>
      <Picker
        label={t('settings.playback.bitrateLocal.label')}
        value={s.playback.maxBitrateMbps}
        options={[...new Set([...BITRATES, s.playback.maxBitrateMbps])].sort((a, b) => a - b).map((b) => ({ value: b, label: fmt.bitrate(b) }))}
        onchange={(v) => set({ playback: { maxBitrateMbps: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.bitrateRemote.label')}</div>
        <div class="desc">{t('settings.playback.bitrateRemote.desc')}</div>
      </div>
      <Picker
        label={t('settings.playback.bitrateRemote.label')}
        value={s.playback.maxBitrateRemoteMbps}
        options={[...new Set([...BITRATES, s.playback.maxBitrateRemoteMbps])].sort((a, b) => a - b).map((b) => ({ value: b, label: fmt.bitrate(b) }))}
        onchange={(v) => set({ playback: { maxBitrateRemoteMbps: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.maxResolution.label')}</div>
        <div class="desc">{t('settings.playback.maxResolution.desc')}</div>
      </div>
      <Picker label={t('settings.playback.maxResolution.label')} value={s.playback.maxResolution} options={RESOLUTIONS} onchange={(v) => set({ playback: { maxResolution: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.forceTranscode.label')}</div>
        <div class="desc">{t('settings.playback.forceTranscode.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.forceTranscode.label')} checked={s.playback.forceTranscode} onchange={(v) => set({ playback: { forceTranscode: v } })} />
    </div>
  </div>
  {#if session.value.address}
    <p class="foot">{t('settings.playback.connection', { kind: onLan ? 'lan' : 'remote', address: session.value.address })}</p>
  {/if}

  <h3 class="gh">{t('settings.playback.resumeNav')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.resume.label')}</div>
        <div class="desc">{t('settings.playback.resume.desc')}</div>
      </div>
      <Picker label={t('settings.playback.resume.label')} value={s.playback.resume} options={RESUME} onchange={(v) => set({ playback: { resume: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.speed.label')}</div>
        <div class="desc">{t('settings.playback.speed.desc')}</div>
      </div>
      <Picker label={t('settings.playback.speed.label')} value={s.playback.defaultSpeed} options={SPEEDS} onchange={(v) => set({ playback: { defaultSpeed: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.seekShort.label')}</div>
        <div class="desc">{t('settings.playback.seekShort.desc')}</div>
      </div>
      <Picker label={t('settings.playback.seekShort.label')} value={s.playback.seekShortS} options={SHORT_STEPS} onchange={(v) => set({ playback: { seekShortS: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.seekLong.label')}</div>
        <div class="desc">{t('settings.playback.seekLong.desc')}</div>
      </div>
      <Picker label={t('settings.playback.seekLong.label')} value={s.playback.seekLongS} options={LONG_STEPS} onchange={(v) => set({ playback: { seekLongS: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.pauseOnMinimize.label')}</div>
        <div class="desc">{t('settings.playback.pauseOnMinimize.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.pauseOnMinimize.label')} checked={s.playback.pauseOnMinimize} onchange={(v) => set({ playback: { pauseOnMinimize: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.aspect.label')}</div>
        <div class="desc">{t('settings.playback.aspect.desc')}</div>
      </div>
      <Picker label={t('settings.playback.aspect.label')} value={s.playback.aspect} options={ASPECTS} onchange={(v) => set({ playback: { aspect: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.cinemaMode.label')}</div>
        <div class="desc">{t('settings.playback.cinemaMode.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.cinemaMode.label')} checked={s.playback.cinemaMode} onchange={(v) => set({ playback: { cinemaMode: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.remoteControl')}</div>
        <div class="desc">{t('settings.playback.remoteControlHint')}</div>
      </div>
      <Toggle label={t('settings.playback.remoteControl')} checked={s.remote.allowControl} onchange={(v) => set({ remote: { allowControl: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.cast.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.cast.discovery')}</div>
      </div>
      <Toggle label={t('settings.cast.discovery')} checked={s.cast.discovery} onchange={(v) => set({ cast: { discovery: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.cast.relay')}</div>
        <div class="desc">{t('settings.cast.relayHint')}</div>
      </div>
      <Toggle label={t('settings.cast.relay')} checked={s.cast.relay} onchange={(v) => set({ cast: { relay: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.cast.allowHevc')}</div>
        <div class="desc">{t('settings.cast.allowHevcHint')}</div>
      </div>
      <Toggle label={t('settings.cast.allowHevc')} checked={s.cast.allowHevc} onchange={(v) => set({ cast: { allowHevc: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.cast.dolby')}</div>
      </div>
      <Toggle label={t('settings.cast.dolby')} checked={s.cast.dolby} onchange={(v) => set({ cast: { dolby: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.remember.title')}</h3>
  <div class="group">
    {#each REMEMBER as r (r.prop)}
      <div class="row">
        <div class="txt">
          <div class="lbl">{r.label}</div>
        </div>
        <Picker label={r.label} value={s.playback.rememberScopes[r.prop]} options={SCOPES} onchange={(v) => set({ playback: { rememberScopes: { [r.prop]: v } } })} />
      </div>
    {/each}
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.remember.clear')}</div>
      </div>
      <button type="button" class="push" onclick={forgetPlayerSettings}>{t('settings.privacy.clear')}</button>
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.episodes')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.autoPlayNext.label')}</div>
        <div class="desc">{t('settings.playback.autoPlayNext.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.autoPlayNext.label')} checked={s.playback.autoPlayNext} onchange={(v) => set({ playback: { autoPlayNext: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.countdown.label')}</div>
        <div class="desc">{t('settings.playback.countdown.desc')}</div>
      </div>
      <Picker label={t('settings.playback.countdown.label')} value={s.playback.upNextSeconds} options={COUNTDOWNS} onchange={(v) => set({ playback: { upNextSeconds: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.skipIntro.label')}</div>
        <div class="desc">{t('settings.playback.skipIntro.desc')}</div>
      </div>
      <Segmented label={t('settings.playback.skipIntro.label')} value={s.playback.skipIntro} options={SKIP} onchange={(v) => set({ playback: { skipIntro: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.skipCredits.label')}</div>
        <div class="desc">{t('settings.playback.skipCredits.desc')}</div>
      </div>
      <Segmented label={t('settings.playback.skipCredits.label')} value={s.playback.skipCredits} options={SKIP} onchange={(v) => set({ playback: { skipCredits: v } })} />
    </div>
    {#each ['skipRecap', 'skipPreview', 'skipCommercial'] as const as k (k)}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t(`settings.playback.${k}.label`)}</div>
          <div class="desc">{t(`settings.playback.${k}.desc`)}</div>
        </div>
        <Segmented label={t(`settings.playback.${k}.label`)} value={s.playback[k]} options={SKIP} onchange={(v) => set({ playback: { [k]: v } })} />
      </div>
    {/each}
  </div>

  <h3 class="gh">{t('settings.livetv.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.livetv.reminderLead.label')}</div>
        <div class="desc">{t('settings.livetv.reminderLead.desc')}</div>
      </div>
      <Picker label={t('settings.livetv.reminderLead.label')} value={s.live.reminderLeadMin} options={REMINDER_LEADS} onchange={(v) => set({ live: { reminderLeadMin: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.livetv.reminderAutoTune.label')}</div>
        <div class="desc">{t('settings.livetv.reminderAutoTune.desc')}</div>
      </div>
      <Toggle label={t('settings.livetv.reminderAutoTune.label')} checked={s.live.reminderAutoTune} onchange={(v) => set({ live: { reminderAutoTune: v } })} />
    </div>
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
  </div>

  <h3 class="gh">{t('settings.playback.video')}</h3>
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
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.matchRefresh.label')}</div>
        <div class="desc">{t(refreshOk ? 'settings.playback.matchRefresh.desc' : 'settings.playback.matchRefresh.unavailable')}</div>
      </div>
      <Toggle label={t('settings.playback.matchRefresh.label')} checked={refreshOk && s.playback.matchRefreshRate} disabled={!refreshOk} onchange={(v) => set({ playback: { matchRefreshRate: v } })} />
    </div>
  </div>
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
