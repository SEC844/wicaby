<script lang="ts">
  // A monochrome glyph from the Android TV icon set (virtual:icons), drawn in the current text colour.
  import icons from 'virtual:icons';

  let { name, size = 20 }: { name: string; size?: number } = $props();
  $effect(() => {
    if (import.meta.env.DEV && !icons[name]) console.warn(`Icon: unknown icon ${name}`);
  });
</script>

<svg viewBox="0 0 24 24" style="width:{size}rem;height:{size}rem" aria-hidden="true"><path d={icons[name]} fill="currentColor" /></svg>

<style>
  svg {
    display: block;
    flex-shrink: 0;
  }
</style>
