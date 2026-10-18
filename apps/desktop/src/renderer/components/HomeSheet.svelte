<script lang="ts">
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import Toggle from './Toggle.svelte';

  // "Personnaliser l'accueil": show/hide and reorder the home rows. Every
  // change applies at once (the home re-renders behind the sheet).
  let {
    open,
    rows,
    hidden,
    mergeContinue,
    onmerge,
    onchange,
    onreset,
    onclose,
  }: {
    open: boolean;
    rows: { id: string; label: string; server?: string }[];
    hidden: Set<string>;
    // X-01: "Continuer" and "À suivre" as one row.
    mergeContinue: boolean;
    onmerge: (value: boolean) => void;
    onchange: (order: string[], hidden: string[]) => void;
    onreset: () => void;
    onclose: () => void;
  } = $props();

  let dragging = $state<number | null>(null);
  let over = $state<number | null>(null);

  function moveRow(from: number, to: number): void {
    if (to < 0 || to >= rows.length || from === to) return;
    const ids = rows.map((r) => r.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    onchange(ids, [...hidden]);
  }

  function setVisible(id: string, visible: boolean): void {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onchange(
      rows.map((r) => r.id),
      [...next],
    );
  }
</script>

<Sheet {open} {onclose} label={t('browse.home.customize')} width={480}>
  <div class="body">
    <h2 class="title-3">{t('browse.home.customize')}</h2>
    <p class="footnote">{t('browse.homeSheet.intro')}</p>
    <div class="merge">
      <span class="label">{t('browse.home.sheet.mergeContinue')}</span>
      <Toggle label={t('browse.home.sheet.mergeContinue')} checked={mergeContinue} onchange={onmerge} />
    </div>
    <ul class="rows">
      {#each rows as r, i (r.id)}
        <li
          class:dragging={dragging === i}
          class:over={over === i && dragging !== null && dragging !== i}
          class:off={hidden.has(r.id)}
          draggable="true"
          ondragstart={(e) => {
            dragging = i;
            e.dataTransfer?.setData('text/plain', r.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragover={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            over = i;
          }}
          ondrop={(e) => {
            e.preventDefault();
            if (dragging !== null) moveRow(dragging, i);
            dragging = over = null;
          }}
          ondragend={() => (dragging = over = null)}
        >
          <span class="grip" aria-hidden="true"><Icon name="grip" size={16} /></span>
          <span class="label">{r.label}{#if r.server}<span class="server">{r.server}</span>{/if}</span>
          <button class="arrow" onclick={() => moveRow(i, i - 1)} disabled={i === 0} aria-label={t('browse.homeSheet.moveUp', { row: r.label })}><Icon name="arrowUp" size={15} /></button>
          <button class="arrow" onclick={() => moveRow(i, i + 1)} disabled={i === rows.length - 1} aria-label={t('browse.homeSheet.moveDown', { row: r.label })}><Icon name="arrowDown" size={15} /></button>
          <Toggle label={t('browse.homeSheet.show', { row: r.label })} checked={!hidden.has(r.id)} onchange={(v) => setVisible(r.id, v)} />
        </li>
      {/each}
    </ul>
    <div class="foot">
      <button class="btn ghost" onclick={onreset}>{t('common.actions.reset')}</button>
      <button class="btn primary" onclick={onclose}>{t('common.actions.ok')}</button>
    </div>
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0;
    padding-right: 40px;
  }
  .footnote {
    margin: 4px 0 16px;
  }
  .merge {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 46px;
    margin-bottom: 12px;
    padding: 0 12px;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 4px;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 46px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-sm);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  li + li {
    box-shadow: 0 -1px 0 var(--separator);
  }
  li.dragging {
    opacity: 0.4;
  }
  li.over {
    background: var(--fill-2);
    transform: translate3d(0, 2px, 0);
  }
  .grip {
    display: grid;
    place-items: center;
    width: 26px;
    color: var(--label-3);
    cursor: grab;
  }
  .label {
    flex: 1;
    min-width: 0;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .server {
    margin-left: 8px;
    font-size: var(--fs-footnote);
    font-weight: 400;
    color: var(--label-3);
  }
  .off .label {
    color: var(--label-3);
  }
  .arrow {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label-2);
  }
  .arrow:hover,
  .arrow:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .arrow:disabled {
    opacity: 0.25;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
</style>
