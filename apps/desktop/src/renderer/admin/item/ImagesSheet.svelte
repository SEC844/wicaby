<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import {
    IMAGE_TYPES,
    UPLOAD_MAX,
    UPLOAD_MIMES,
    deleteImage,
    downloadRemoteImage,
    imageSrc,
    itemImages,
    moveBackdrop,
    remoteImageProviders,
    remoteImages,
    remoteSrc,
    uploadImage,
    type ImageInfo,
    type ImageType,
    type RemoteImage,
  } from './metadata';

  // Artwork of one item: what the server has (by type, backdrops in order), local
  // upload, delete, and a browser of the providers' artwork to download.
  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  let tab = $state<'current' | 'remote'>('current');
  let images = $state<ImageInfo[] | null>(null);
  let busy = $state('');
  let error = $state('');
  let fileInput = $state<HTMLInputElement>();
  let uploadType: ImageType = 'Primary';

  // Remote browser.
  let rType = $state<ImageType>('Primary');
  let rProvider = $state('');
  let rAllLanguages = $state(false);
  let rLanguage = $state('*');
  let providers = $state<{ Name: string; SupportedImages?: string[] }[]>([]);
  let remote = $state<RemoteImage[] | null>(null);
  let rError = $state('');

  const byType = $derived(
    IMAGE_TYPES.map((type) => ({
      type,
      list: (images ?? []).filter((i) => i.ImageType === type).sort((a, b) => (a.ImageIndex ?? 0) - (b.ImageIndex ?? 0)),
    })),
  );
  const languages = $derived([...new Set((remote ?? []).map((r) => r.Language ?? ''))].sort());
  const shown = $derived((remote ?? []).filter((r) => rLanguage === '*' || (r.Language ?? '') === rLanguage));
  const typeOptions = $derived(IMAGE_TYPES.map((v) => ({ value: v, label: t(`adminMetadata.imageTypes.${v}`) })));

  function reload(): void {
    itemImages(item)
      .then((r) => (images = r))
      .catch((err) => {
        images = [];
        error = errorMessage(err);
      });
  }

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      tab = 'current';
      images = null;
      remote = null;
      error = '';
      reload();
      void remoteImageProviders(item).then((p) => (providers = p));
    });
  });

  // Remote list follows the type / provider / language switches while that tab is shown.
  $effect(() => {
    if (!open || tab !== 'remote') return;
    void itemId;
    const q = { type: rType, provider: rProvider, allLanguages: rAllLanguages };
    remote = null;
    rError = '';
    rLanguage = '*';
    untrack(() => remoteImages(item, q))
      .then((r) => {
        if (q.type === rType && q.provider === rProvider && q.allLanguages === rAllLanguages) remote = r.Images ?? [];
      })
      .catch((err) => {
        rError = errorMessage(err);
        remote = [];
      });
  });

  async function run(key: string, fn: () => Promise<unknown>, done?: string): Promise<void> {
    if (busy) return;
    busy = key;
    error = '';
    try {
      await fn();
      if (done) toast('success', done);
      reload();
    } catch (err) {
      error = errorMessage(err);
      toast('error', error);
    } finally {
      busy = '';
    }
  }

  function pickFile(type: ImageType): void {
    uploadType = type;
    fileInput?.click();
  }

  function fileChosen(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!UPLOAD_MIMES.includes(file.type)) return void toast('error', t('adminMetadata.images.badType'));
    if (file.size > UPLOAD_MAX) return void toast('error', t('adminMetadata.images.tooLarge'));
    void run(`up-${uploadType}`, () => uploadImage(item, uploadType, file), t('adminMetadata.images.uploaded'));
  }

  function browse(type: ImageType): void {
    rType = type;
    tab = 'remote';
  }

  const key = (i: ImageInfo) => `${i.ImageType}-${i.ImageIndex ?? 0}`;
  const aspect = (type: string) => (type === 'Primary' ? '2 / 3' : type === 'Logo' || type === 'Banner' ? '3 / 1' : type === 'Disc' ? '1 / 1' : '16 / 9');
</script>

<AdminSheet {open} {onclose} title={t('adminMetadata.images.title')} subtitle={item.Name} width={820}>
  <div class="tabs">
    <Segmented
      value={tab}
      label={t('adminMetadata.images.title')}
      options={[
        { value: 'current', label: t('adminMetadata.images.current') },
        { value: 'remote', label: t('adminMetadata.images.remote') },
      ]}
      onchange={(v) => (tab = v)}
    />
  </div>
  <input type="file" accept={UPLOAD_MIMES.join(',')} bind:this={fileInput} onchange={fileChosen} hidden />

  {#if tab === 'current'}
    {#if images === null}
      <div class="sk skeleton"></div>
    {:else}
      {#each byType as g (g.type)}
        <section>
          <div class="sec-h">
            <h3 class="a-gh">{t(`adminMetadata.imageTypes.${g.type}`)}{#if g.list.length > 1}<span class="n">&nbsp;· {g.list.length}</span>{/if}</h3>
            <div class="a-actions">
              <button type="button" class="a-push ghost" onclick={() => browse(g.type)}><Icon name="search" size={14} /> {t('adminMetadata.images.browse')}</button>
              <button type="button" class="a-push" disabled={busy !== ''} onclick={() => pickFile(g.type)}>
                <Icon name="upload" size={14} />
                {busy === `up-${g.type}` ? t('adminMetadata.images.uploading') : t('adminMetadata.images.upload')}
              </button>
            </div>
          </div>
          {#if g.list.length === 0}
            <p class="none caption">{t('adminMetadata.images.empty')}</p>
          {:else}
            <ul class="grid" class:wide={g.type !== 'Primary' && g.type !== 'Disc'}>
              {#each g.list as img, i (key(img))}
                <li>
                  <div class="frame" style:aspect-ratio={aspect(g.type)} class:logo={g.type === 'Logo'}>
                    <img src={imageSrc(item, img, g.type === 'Primary' ? 180 : 300)} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add('in')} />
                  </div>
                  <div class="meta">
                    <span class="caption mono">{img.Width && img.Height ? `${img.Width}×${img.Height}` : ''}</span>
                    <span class="a-actions">
                      {#if g.type === 'Backdrop' && g.list.length > 1}
                        <button type="button" class="a-push icon" disabled={busy !== '' || i === 0} title={t('adminMetadata.common.moveLeft')} aria-label={t('adminMetadata.common.moveLeft')} onclick={() => run(key(img), () => moveBackdrop(item, img.ImageIndex ?? i, (img.ImageIndex ?? i) - 1))}><Icon name="chevronLeft" size={14} /></button>
                        <button type="button" class="a-push icon" disabled={busy !== '' || i === g.list.length - 1} title={t('adminMetadata.common.moveRight')} aria-label={t('adminMetadata.common.moveRight')} onclick={() => run(key(img), () => moveBackdrop(item, img.ImageIndex ?? i, (img.ImageIndex ?? i) + 1))}><Icon name="chevronRight" size={14} /></button>
                      {/if}
                      <button type="button" class="a-push icon" disabled={busy !== ''} title={t('adminMetadata.images.delete')} aria-label={t('adminMetadata.images.delete')} onclick={() => run(key(img), () => deleteImage(item, img), t('adminMetadata.images.deleted'))}><Icon name="trash" size={14} /></button>
                    </span>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
      {#if error}<p class="am-error">{error}</p>{/if}
    {/if}
  {:else}
    <div class="filters">
      <Picker label={t('adminMetadata.images.type')} value={rType} options={typeOptions} onchange={(v) => (rType = v)} />
      <Picker
        label={t('adminMetadata.images.provider')}
        value={rProvider}
        options={[{ value: '', label: t('adminMetadata.images.allProviders') }, ...providers.filter((p) => !p.SupportedImages || p.SupportedImages.includes(rType)).map((p) => ({ value: p.Name, label: p.Name }))]}
        onchange={(v) => (rProvider = v)}
      />
      <Picker
        label={t('adminMetadata.images.language')}
        value={rLanguage}
        options={[{ value: '*', label: t('adminMetadata.images.allLanguagesShown') }, ...languages.map((l) => ({ value: l, label: l ? fmt.language(l) : t('adminMetadata.images.noLanguage') }))]}
        onchange={(v) => (rLanguage = v)}
      />
      <label class="am-check opt">
        <span class="callout">{t('adminMetadata.images.includeAllLanguages')}</span>
        <Toggle checked={rAllLanguages} label={t('adminMetadata.images.includeAllLanguages')} onchange={(v) => (rAllLanguages = v)} />
      </label>
    </div>
    {#if rError}<p class="am-error">{rError}</p>{/if}
    {#if remote === null}
      <div class="sk skeleton"></div>
    {:else if shown.length === 0}
      <p class="am-empty">{t('adminMetadata.images.remoteEmpty')}</p>
    {:else}
      <ul class="grid remote" class:wide={rType !== 'Primary' && rType !== 'Disc'}>
        {#each shown as r, i (r.Url + i)}
          {@const src = remoteSrc(r.ThumbnailUrl ?? r.Url)}
          <li>
            <button type="button" class="pick" disabled={busy !== ''} title={t('adminMetadata.images.download')} onclick={() => run(`dl-${i}`, () => downloadRemoteImage(item, $state.snapshot(r) as RemoteImage), t('adminMetadata.images.downloaded'))}>
              <span class="frame" style:aspect-ratio={aspect(rType)} class:logo={rType === 'Logo'}>
                {#if src}<img {src} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add('in')} />{/if}
                {#if busy === `dl-${i}`}<span class="dl footnote">{t('adminMetadata.images.downloading')}</span>{/if}
              </span>
            </button>
            <div class="info">
              <span class="caption">{r.ProviderName ?? ''}{r.Language ? ` · ${fmt.language(r.Language)}` : ''}</span>
              <span class="caption mono">
                {r.Width && r.Height ? `${r.Width}×${r.Height}` : ''}{#if r.CommunityRating}&nbsp;· ★ {fmt.number(r.CommunityRating, { maximumFractionDigits: 1 })}{#if r.VoteCount}&nbsp;({r.VoteCount}){/if}{/if}
              </span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('adminMetadata.common.done')}</button>
  {/snippet}
</AdminSheet>

<style>
  .tabs {
    max-width: 360px;
    margin: 4px 0 6px;
  }
  .sk {
    height: 320px;
    margin-top: 16px;
    border-radius: var(--r-md);
  }
  section {
    margin-top: 6px;
  }
  .sec-h {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    margin-top: 22px;
  }
  .sec-h .a-gh {
    margin: 0 0 0 2px;
  }
  .n {
    font-variant-numeric: tabular-nums;
  }
  .none {
    margin: 8px 2px 0;
  }
  .grid {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 14px;
  }
  .grid.wide {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
  .frame {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .frame.logo img {
    object-fit: contain;
    padding: 8px;
  }
  .frame img:global(.in) {
    opacity: 1;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 32px;
    margin-top: 4px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
    margin: 10px 0 4px;
  }
  .opt {
    gap: 10px;
    margin-left: auto;
  }
  .remote {
    margin-top: 14px;
  }
  .pick {
    display: block;
    width: 100%;
    border-radius: var(--r-sm);
    transition: transform var(--t-med) var(--spring);
  }
  .pick:hover,
  .pick:focus-visible {
    transform: scale(1.04);
    will-change: transform;
  }
  .pick:active {
    transform: scale(0.97);
  }
  .dl {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--scrim);
    color: var(--label);
  }
  .info {
    display: flex;
    flex-direction: column;
    margin-top: 6px;
  }
</style>
