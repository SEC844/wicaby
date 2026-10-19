<script lang="ts">
  // A music cover (Android music/Covers.kt CoverPlaceholder): the art, or, without one (or when it fails), the name's
  // initials on a tile tinted by the name (desktop shared/music-art.ts nameHue, the same colour on every app).
  import { hslRgb, nameHue } from '$shared/music-art';

  let { src, name, size, round = false, font = 88 }: { src?: string; name: string; size: number; round?: boolean; font?: number } = $props();

  let failed = $state<string | undefined>(undefined);
  // Up to two initials, first and last word; Chromium 53 has no Unicode property escapes, so letters are any non-space.
  const initials = $derived.by(() => {
    const words = name.trim().split(/\s+/).filter((w) => /^[^\s!-/:-@[-`{-~]/.test(w));
    return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0]?.[0] ?? '')).toUpperCase();
  });
  const tile = $derived(`rgb(${hslRgb(nameHue(name)).join(',')})`);
</script>

<span class="cover" class:round style="width:{size}rem;height:{size}rem;background:{tile}">
  {#if src && failed !== src}
    <img {src} alt={name} onerror={() => (failed = src)} />
  {:else}
    <span class="initials" style="font-size:{font}rem">{initials}</span>
  {/if}
</span>

<style>
  .cover {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--r-lg);
  }
  .round {
    border-radius: 50%;
  }
  img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .initials {
    color: #fff;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
</style>
