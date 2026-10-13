<script lang="ts">
  let {
    checked,
    onchange,
    disabled = false,
    label,
  }: { checked: boolean; onchange: (value: boolean) => void; disabled?: boolean; label?: string } = $props();
</script>

<button
  type="button"
  class="toggle"
  class:on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onchange(!checked)}
>
  <span class="knob"></span>
</button>

<style>
  /* Switch. The accent fill is a pseudo-element that fades in, and the knob
     slides: only opacity and transform animate, no overshoot. */
  .toggle {
    --w: 38px;
    --h: 22px;
    --k: 18px;
    position: relative;
    flex: none;
    width: var(--w);
    height: var(--h);
    border-radius: 999px;
    background: var(--fill-3);
    isolation: isolate;
    transition: opacity var(--t-fast) var(--ease);
  }
  .toggle::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--accent);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
    z-index: -1;
  }
  .toggle:not(:disabled):hover {
    background: var(--fill-4);
  }
  .toggle.on::before {
    opacity: 1;
  }
  .toggle:disabled {
    opacity: 0.4;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: var(--k);
    height: var(--k);
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: transform var(--t-fast) var(--ease);
  }
  .toggle.on .knob {
    transform: translateX(calc(var(--w) - var(--k) - 4px));
  }
</style>
