<script lang="ts">
  // Confirmation sheet for admin actions that cannot be undone or may cut access.
  import type { Snippet } from 'svelte';
  import Sheet from '../../components/Sheet.svelte';
  import { t } from '../../lib/i18n.svelte';

  let {
    open,
    title,
    message,
    confirmLabel,
    danger = false,
    busy = false,
    onconfirm,
    onclose,
    children,
  }: {
    open: boolean;
    title: string;
    message?: string;
    confirmLabel: string;
    danger?: boolean;
    busy?: boolean;
    onconfirm: () => void;
    onclose: () => void;
    children?: Snippet;
  } = $props();

  // A key still held from the button that opened the sheet must not confirm it.
  function ignoreRepeat(e: KeyboardEvent): void {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

<Sheet {open} {onclose} label={title} width={460}>
  <div class="a-sheet" role="presentation" onkeydowncapture={ignoreRepeat}>
    <h2>{title}</h2>
    {#if message}<p>{message}</p>{/if}
    {@render children?.()}
    <div class="a-sheet-actions">
      <!-- Every confirmation starts on Cancel: confirming takes a deliberate move. -->
      <button type="button" class="a-push ghost" data-autofocus onclick={onclose}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push" class:danger class:primary={!danger} disabled={busy} onclick={onconfirm}>{confirmLabel}</button>
    </div>
  </div>
</Sheet>
