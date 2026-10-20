<script lang="ts">
  // ClockText (Chrome.kt): the time in the locale's 12/24 h format, refreshed on the minute.
  import { onMount } from 'svelte';
  import { locale } from '../lib/i18n.svelte';

  let { style = '' }: { style?: string } = $props();
  let now = $state(new Date());
  onMount(() => {
    let timer = 0;
    const next = () => {
      now = new Date();
      timer = window.setTimeout(next, 60_000 - (Date.now() % 60_000) + 50);
    };
    next();
    return () => clearTimeout(timer);
  });
</script>

<span class="t-headline clock" {style}>{now.toLocaleTimeString(locale.current, { hour: 'numeric', minute: '2-digit' })}</span>

<style>
  .clock {
    color: var(--label);
  }
</style>
