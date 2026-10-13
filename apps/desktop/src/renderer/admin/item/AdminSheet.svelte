<script lang="ts">
  import type { Snippet } from 'svelte';
  import '../../admin/admin.css';
  import Sheet from '../../components/Sheet.svelte';

  // Frame shared by the item admin sheets: sticky title, scrolling body, sticky
  // action bar. Form helpers (.am-*) are global under .am so every sheet shares them.
  let {
    open,
    onclose,
    title,
    subtitle,
    width = 560,
    children,
    footer,
  }: { open: boolean; onclose: () => void; title: string; subtitle?: string; width?: number; children: Snippet; footer?: Snippet } = $props();
</script>

<Sheet {open} {onclose} label={title} {width}>
  <div class="am">
    <header>
      <h2 class="title-3">{title}</h2>
      {#if subtitle}<p class="footnote">{subtitle}</p>{/if}
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</Sheet>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 22px 64px 12px 24px;
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  h2 {
    margin: 0;
  }
  header .footnote {
    margin: 2px 0 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    padding: 6px 24px 20px;
  }
  footer {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 24px 16px;
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }

  /* ---- Form helpers shared by the item admin sheets ---- */
  :global(.am .am-grid) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 14px;
  }
  :global(.am .am-grid.three) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  :global(.am .am-grid .wide) {
    grid-column: 1 / -1;
  }
  :global(.am .am-f) {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  :global(.am .am-l) {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 20px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-2);
  }
  :global(.am .am-f .field) {
    height: 36px;
    padding: 0 12px;
  }
  :global(.am textarea.field) {
    height: auto;
    min-height: 96px;
    padding: 9px 12px;
    resize: vertical;
    line-height: 1.5;
  }
  :global(.am .am-empty) {
    padding: 28px 0;
    text-align: center;
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
  :global(.am .am-error) {
    margin: 10px 0 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  :global(.am .am-check) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
</style>
