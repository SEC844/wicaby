<script lang="ts">
  // A QR code (lib/qr.ts) as one SVG path: dark modules on white with the four-module quiet zone, crisp at any size.
  import { encodeQr, qrPath } from '../lib/qr';

  let { text, size = 200 }: { text: string; size?: number } = $props();

  const q = $derived(encodeQr(text, 'M'));
  const path = $derived(qrPath(q));
</script>

<svg class="qr" viewBox="-4 -4 {q.size + 8} {q.size + 8}" style="width:{size}rem;height:{size}rem" shape-rendering="crispEdges" role="img" aria-label={text}>
  <rect x="-4" y="-4" width={q.size + 8} height={q.size + 8} fill="#fff" />
  <path d={path} fill="#000" />
</svg>

<style>
  .qr {
    display: block;
    border-radius: var(--r-sm);
  }
</style>
