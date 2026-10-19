<script lang="ts">
  import { parseCombo, rowsFor } from '../../shared/livetv/keys';
  import { applyOverrides, comboFromEvent, conflictWith, editable, validateImport, type ShortcutOverrides } from '../../shared/shortcuts';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage, settings, toast, updateSettings } from '../lib/stores.svelte';

  // X-04 Settings > Général > Raccourcis: the player's actions can be recorded, reset or disabled;
  // a conflict inside a context is refused and saves nothing. The Live TV rows are listed read-only.
  const overrides = $derived<ShortcutOverrides>(settings.value?.ui.shortcuts ?? {});
  const rows = $derived(applyOverrides(overrides));
  const editRows = $derived(rows.filter((r) => editable(r) && r.context === 'vod'));
  const musicRows = $derived(rows.filter((r) => editable(r) && r.context === 'music'));
  const liveRows = rowsFor('live');

  let recording = $state<string | null>(null);
  let error = $state<{ id: string; text: string } | null>(null);
  let status = $state('');
  let fileInput = $state<HTMLInputElement>();

  const KEY_GLYPHS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Enter: '↵', PageUp: 'PgUp', PageDown: 'PgDn' };
  function comboLabel(combo: string): string {
    const c = parseCombo(combo);
    const key = c.key === 'Space' ? t('settings.general.shortcuts.space') : c.key === 'Escape' ? t('settings.general.shortcuts.esc') : (KEY_GLYPHS[c.key] ?? c.key);
    return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && '⇧', key].filter(Boolean).join(' ');
  }
  const labelOf = (id: string): string => t(rows.find((r) => r.id === id)?.labelKey ?? id);

  async function save(next: ShortcutOverrides): Promise<void> {
    try {
      await updateSettings({ ui: { shortcuts: next } });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function setRow(id: string, keys: string[] | null | undefined): void {
    const next = { ...overrides };
    if (keys === undefined) delete next[id];
    else next[id] = keys;
    void save(next);
  }

  function startRecording(id: string): void {
    error = null;
    recording = recording === id ? null : id;
    status = recording ? t('settings.general.shortcuts.record') : '';
  }

  // Captured before anything else on the page; Escape cancels, Tab still moves focus.
  function onKeyCapture(e: KeyboardEvent): void {
    const id = recording;
    if (!id || e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      recording = null;
      status = '';
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    recording = null;
    const taken = conflictWith(rows, id, combo);
    if (taken) {
      error = { id, text: t('settings.general.shortcuts.conflict', { action: labelOf(taken.id) }) };
      status = error.text;
      return;
    }
    status = t('settings.general.shortcuts.captured', { combo: comboLabel(combo) });
    setRow(id, [combo]);
  }

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(overrides, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wicaby-shortcuts.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let doc: unknown = null;
    try {
      doc = file.size <= 64 * 1024 ? JSON.parse(await file.text()) : null;
    } catch {
      doc = null;
    }
    // The whole file or nothing.
    const valid = validateImport(doc);
    if (!valid) return toast('error', t('settings.general.shortcuts.invalidFile'));
    await save(valid);
    toast('success', t('settings.general.shortcuts.imported'));
  }
</script>

<svelte:window onkeydowncapture={onKeyCapture} />

{#snippet editRow(r: (typeof rows)[number])}
  {@const label = t(r.labelKey)}
  <div class="row compact">
    <div class="txt">
      <div class="lbl soft">{label}</div>
      {#if error?.id === r.id}<div class="err" role="alert">{error.text}</div>{/if}
    </div>
    <span class="keys">
      {#if recording === r.id}
        <kbd class="rec">{t('settings.general.shortcuts.record')}</kbd>
      {:else if r.keys.length}
        {#each r.keys as k (k)}<kbd>{comboLabel(k)}</kbd>{/each}
      {:else}
        <span class="off">{t('settings.general.shortcuts.disabled')}</span>
      {/if}
    </span>
    <span class="acts">
      <button type="button" class="push" aria-pressed={recording === r.id} aria-label={t('settings.general.shortcuts.recordHint', { action: label })} onclick={() => startRecording(r.id)}>
        {recording === r.id ? t('common.actions.cancel') : t('settings.general.shortcuts.record')}
      </button>
      <button type="button" class="push ghost" disabled={!Object.hasOwn(overrides, r.id)} onclick={() => setRow(r.id, undefined)}>{t('settings.general.shortcuts.reset')}</button>
      <button type="button" class="push ghost" disabled={!r.keys.length} onclick={() => setRow(r.id, null)}>{t('settings.general.shortcuts.disable')}</button>
    </span>
  </div>
{/snippet}

<!-- Settings › Keyboard. Each heading sits right before its group, which the settings search relies on. -->
<h3 class="gh">{t('settings.general.shortcuts.player')}</h3>
<div class="group">
  {#each editRows as r (r.id)}{@render editRow(r)}{/each}
  <div class="row compact">
    <span class="acts">
      <button type="button" class="push" onclick={() => fileInput?.click()}>{t('settings.general.shortcuts.import')}</button>
      <button type="button" class="push" onclick={exportFile}>{t('settings.general.shortcuts.export')}</button>
    </span>
    <button type="button" class="push ghost" disabled={!Object.keys(overrides).length} onclick={() => void save({})}>{t('settings.general.shortcuts.resetAll')}</button>
    <input bind:this={fileInput} type="file" accept="application/json,.json" hidden onchange={importFile} />
  </div>
</div>

<h3 class="gh">{t('settings.general.shortcuts.context.music')}</h3>
<div class="group">
  {#each musicRows as r (r.id)}{@render editRow(r)}{/each}
</div>

<h3 class="gh">{t('settings.general.shortcuts.live')}</h3>
<div class="group">
  {#each liveRows as r (r.id)}
    {@const keys = r.keys.some((k) => k.startsWith('code:Digit')) ? ['0', '9'] : r.keys.filter((k) => !k.startsWith('code:') && !k.startsWith('Media')).map(comboLabel)}
    <div class="row compact">
      <div class="lbl soft">{t(r.labelKey)}</div>
      <span class="keys">{#each [...new Set(keys)] as k (k)}<kbd>{k}</kbd>{/each}</span>
    </div>
  {/each}
</div>

<div class="sr" role="status" aria-live="polite">{status}</div>

<style>
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
    gap: 12px;
    min-height: 42px;
    padding: 9px 18px;
  }
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
  }
  .lbl {
    font-size: var(--fs-body);
    color: var(--label-2);
  }
  .err {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label);
  }
  .keys,
  .acts {
    display: flex;
    gap: 4px;
    flex: none;
    align-items: center;
  }
  .row > .lbl {
    flex: 1;
  }
  .acts:first-child {
    flex: 1;
  }
  kbd {
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--r-xs);
    box-shadow: inset 0 0 0 1px var(--hairline);
    font-family: var(--font-sans);
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--label-2);
  }
  kbd.rec {
    color: var(--label);
    background: var(--fill-2);
  }
  .off {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .push {
    height: 26px;
    padding: 0 10px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
  }
  .push:hover:not(:disabled),
  .push:focus-visible {
    background: var(--fill-3);
  }
  .push.ghost {
    background: transparent;
    color: var(--label-2);
  }
  .push:disabled {
    opacity: 0.4;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
