<script lang="ts">
  import { w } from '../lib/bridge';
  import { bytes } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Picker from './Picker.svelte';
  import Sheet from './Sheet.svelte';
  import Toggle from './Toggle.svelte';
  import { MAGNET_RE, magnetName, torrents } from '../lib/torrents.svelte';

  // Add by magnet link or .torrent files. `external` is a link handed over by
  // Windows (magnet: handler): the sheet then asks for confirmation first.
  let {
    open,
    onclose,
    files = $bindable([]),
    magnet = $bindable(''),
    external = false,
  }: { open: boolean; onclose: () => void; files?: File[]; magnet?: string; external?: boolean } = $props();

  let category = $state('');
  let savePath = $state('');
  let paused = $state(false);
  let sequential = $state(false);
  let busy = $state(false);
  let fromClipboard = $state(false);
  let picker = $state<HTMLInputElement>();

  const categories = $derived(torrents.value?.categories ?? []);
  const catPath = $derived(categories.find((c) => c.name === category)?.savePath ?? '');
  const links = $derived(
    magnet
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const badLink = $derived(links.some((l) => !MAGNET_RE.test(l)));
  const canAdd = $derived(!busy && !badLink && links.length + files.length > 0);

  // Prefill from the clipboard when the sheet opens empty.
  $effect(() => {
    if (!open || external || magnet || files.length) return;
    void w.torrents.clipboardMagnet().then((m) => {
      if (m && !magnet) {
        magnet = m;
        fromClipboard = true;
      }
    });
  });

  function close(): void {
    magnet = '';
    files = [];
    fromClipboard = false;
    onclose();
  }

  function pick(list: FileList | null): void {
    const add = [...(list ?? [])].filter((f) => /\.torrent$/i.test(f.name));
    files = [...files, ...add.filter((f) => !files.some((x) => x.name === f.name && x.size === f.size))];
  }

  async function submit(): Promise<void> {
    busy = true;
    try {
      await w.torrents.add({
        magnets: links,
        files: await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))),
        category,
        savePath: savePath.trim(),
        paused,
        sequential,
      });
      const n = links.length + files.length;
      toast('success', t('torrents.add.added', { count: n }));
      close();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }
</script>

<Sheet {open} onclose={close} label={t('torrents.add.label')} width={540}>
  <div class="body">
    <h2 class="title-3">{external ? t('torrents.add.titleExternal') : t('torrents.add.label')}</h2>
    {#if external}
      <p class="lead">{t('torrents.add.lead')}</p>
      <div class="external">
        <Icon name="download" size={18} />
        <span class="name">{magnetName(magnet)}</span>
      </div>
    {:else}
      <label class="block">
        <span class="label">{t('torrents.add.magnet')}</span>
        <input class="field" type="text" placeholder="magnet:?xt=urn:btih:…" spellcheck="false" autocomplete="off" bind:value={magnet} oninput={() => (fromClipboard = false)} />
        {#if badLink}
          <span class="hint bad">{t('torrents.add.invalidMagnet')}</span>
        {:else if fromClipboard}
          <span class="hint">{t('torrents.add.pasted')}</span>
        {/if}
      </label>

      <div class="block">
        <span class="label">{t('torrents.add.files')}</span>
        {#if files.length}
          <ul class="files">
            {#each files as f, i (f.name + f.size)}
              <li>
                <span class="fname">{f.name}</span>
                <span class="caption">{bytes(f.size)}</span>
                <button type="button" class="btn icon ghost xs" aria-label={t('torrents.add.removeFile', { name: f.name })} onclick={() => (files = files.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
              </li>
            {/each}
          </ul>
        {/if}
        <button type="button" class="btn sm" onclick={() => picker?.click()}><Icon name="folderOpen" size={14} /> {t('torrents.add.chooseFiles')}</button>
        <span class="hint">{t('torrents.add.dropHint')}</span>
        <input bind:this={picker} type="file" accept=".torrent,application/x-bittorrent" multiple hidden onchange={(e) => pick(e.currentTarget.files)} />
      </div>
    {/if}

    <div class="group">
      <div class="row">
        <span class="lbl">{t('torrents.add.category')}</span>
        <Picker label={t('torrents.add.category')} value={category} options={[{ value: '', label: t('torrents.add.noCategory') }, ...categories.map((c) => ({ value: c.name, label: c.name }))]} onchange={(v) => (category = v)} />
      </div>
      <label class="row">
        <span class="lbl">{t('torrents.add.folder')}</span>
        <input class="field" type="text" placeholder={catPath || t('torrents.add.defaultFolder')} spellcheck="false" bind:value={savePath} />
      </label>
      <div class="row">
        <span class="lbl">{t('torrents.add.startPaused')}</span>
        <Toggle label={t('torrents.add.startPaused')} checked={paused} onchange={(v) => (paused = v)} />
      </div>
      <div class="row">
        <span class="lbl">{t('torrents.add.sequential')}</span>
        <Toggle label={t('torrents.add.sequential')} checked={sequential} onchange={(v) => (sequential = v)} />
      </div>
    </div>

    <div class="actions">
      <button type="button" class="btn" onclick={close}>{t('common.actions.cancel')}</button>
      <button type="button" class="btn primary" disabled={!canAdd} data-autofocus={external || undefined} onclick={submit}>{busy ? t('torrents.add.adding') : t('common.actions.add')}</button>
    </div>
  </div>
</Sheet>

<style>
  .body {
    padding: 26px 28px 24px;
  }
  h2 {
    margin: 0 40px 16px 0;
  }
  .lead {
    margin: -6px 0 14px;
    color: var(--label-2);
    font-size: var(--fs-callout);
    line-height: 1.5;
  }
  .external {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    margin-bottom: 18px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    color: var(--label-2);
  }
  .external .name {
    color: var(--label);
    font-weight: 500;
    word-break: break-word;
  }
  .block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 18px;
  }
  .label {
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .hint {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .hint.bad {
    color: var(--danger);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 10px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
  }
  .files li + li {
    margin-top: 4px;
  }
  .fname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--fill-1);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 7px 14px;
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 14px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .lbl {
    flex: 1;
    font-weight: 500;
  }
  .row .field {
    flex: 0 1 300px;
    height: 32px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 22px;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: var(--fs-footnote);
  }
  .btn.xs {
    width: 26px;
    height: 26px;
  }
</style>
