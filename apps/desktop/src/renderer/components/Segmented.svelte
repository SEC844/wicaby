<script lang="ts" generics="T extends string">
  // Segmented control: equal-width segments and an accent thumb that slides
  // between them (transform only, no overshoot).
  let {
    value,
    options,
    onchange,
    label,
  }: { value: T; options: { value: T; label: string }[]; onchange: (value: T) => void; label?: string } = $props();

  const index = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
</script>

<div class="seg" role="radiogroup" aria-label={label} style:--n={options.length} style:--i={index}>
  <span class="thumb" aria-hidden="true"></span>
  {#each options as opt (opt.value)}
    <button type="button" role="radio" aria-checked={value === opt.value} class:on={value === opt.value} onclick={() => onchange(opt.value)}>
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    flex: none;
    min-width: calc(var(--n) * 72px);
    padding: 2px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    isolation: isolate;
  }
  /* High Contrast: a 3:1 outline on the control's edge (docs/design.md). */
  :global(html[data-theme='contrast']) .seg {
    outline: 1px solid var(--separator);
    outline-offset: -1px;
  }
  .thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc((100% - 4px) / var(--n));
    border-radius: 4px;
    background: var(--accent);
    transform: translateX(calc(var(--i) * 100%));
    transition: transform var(--t-fast) var(--ease);
    z-index: -1;
  }
  button {
    height: 24px;
    padding: 0 12px;
    border-radius: 4px;
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label-2);
    white-space: nowrap;
  }
  button:hover,
  button:focus-visible {
    color: var(--label);
  }
  button:focus-visible:not(.on) {
    background: var(--fill-2);
  }
  button.on {
    color: var(--accent-fg);
  }
</style>
