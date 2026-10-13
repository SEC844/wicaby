<script lang="ts">
  import { t } from '../../lib/i18n.svelte';
  import Icon from '../../components/Icon.svelte';

  // Editable list of names (genres, studios, tags): Enter or comma adds, × removes,
  // Backspace in the empty field takes the last chip back for editing.
  let { values = $bindable(), label, placeholder = '', disabled = false }: { values: string[]; label: string; placeholder?: string; disabled?: boolean } = $props();

  let draft = $state('');

  function add(): void {
    const parts = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const have = new Set(values.map((v) => v.toLowerCase()));
    const next = parts.filter((p) => !have.has(p.toLowerCase()) && have.add(p.toLowerCase()));
    if (next.length) values = [...values, ...next];
    draft = '';
  }

  function key(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !draft && values.length) {
      e.preventDefault();
      e.stopPropagation();
      draft = values[values.length - 1];
      values = values.slice(0, -1);
    }
  }
</script>

<div class="chips field" class:disabled role="group" aria-label={label}>
  {#each values as v, i (v)}
    <span class="tag">
      {v}
      <button type="button" aria-label={t('adminMetadata.common.removeNamed', { name: v })} {disabled} onclick={() => (values = values.filter((_, j) => j !== i))}>
        <Icon name="close" size={12} />
      </button>
    </span>
  {/each}
  <input bind:value={draft} onkeydown={key} onblur={add} {placeholder} {disabled} aria-label={label} maxlength="120" />
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    height: auto;
    min-height: 36px;
    padding: 5px 8px;
  }
  .chips:focus-within {
    background: var(--fill-3);
    border-color: var(--hairline);
  }
  .disabled {
    opacity: 0.55;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 24px;
    padding: 0 4px 0 9px;
    border-radius: 999px;
    background: var(--fill-3);
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .tag button {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-2);
  }
  .tag button:hover,
  .tag button:focus-visible {
    background: var(--fill-4);
    color: var(--label);
  }
  input {
    flex: 1;
    min-width: 120px;
    height: 24px;
    padding: 0 4px;
    border: 0;
    background: none;
    user-select: text;
  }
</style>
