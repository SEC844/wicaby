<script lang="ts">
  // Android TV TvTextField: a text field the remote can reach. Focusing it gives it the DOM focus (lib/focus.ts), so
  // OK opens the TV's on-screen keyboard; Enter (the keyboard's Go/Done) calls onsubmit.
  // The field's look sits on the <input> itself: Chromium 53 has no :focus-within to style a wrapper.
  import { focusable } from '../lib/focus';
  import Icon from './Icon.svelte';

  let {
    value = $bindable(''),
    placeholder,
    password = false,
    autofocus = false,
    onsubmit,
  }: { value?: string; placeholder: string; password?: boolean; autofocus?: boolean; onsubmit?: () => void } = $props();

  function onkeydown(e: KeyboardEvent): void {
    if (e.keyCode === 13) {
      e.preventDefault();
      onsubmit?.();
    }
  }
</script>

<label class="field">
  <span class="icon"><Icon name="Keyboard" size={22} /></span>
  <input
    type={password ? 'password' : 'text'}
    bind:value
    {placeholder}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    use:focusable={autofocus}
    {onkeydown}
  />
</label>

<style>
  .field {
    position: relative;
    display: block;
  }
  .icon {
    position: absolute;
    left: 18rem;
    top: 15rem;
    color: var(--label-2);
    pointer-events: none;
  }
  input {
    display: block;
    width: 100%;
    height: 52rem;
    padding: 0 18rem 0 54rem;
    border-radius: var(--r-md);
    background: var(--fill-2);
    border: 1rem solid var(--fill-3);
    outline: none;
    color: var(--label);
    font: inherit;
    font-size: 17rem;
  }
  input:global(.focused) {
    background: var(--fill-4);
    border-color: rgba(255, 255, 255, 0.6);
  }
  input::-webkit-input-placeholder {
    color: var(--label-3);
  }
  input::placeholder {
    color: var(--label-3);
  }
</style>
