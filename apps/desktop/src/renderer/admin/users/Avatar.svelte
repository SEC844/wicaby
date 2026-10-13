<script lang="ts">
  import { userImageUrl } from '../../lib/images';

  // Neutral monogram, with the server avatar faded in over it when there is one.
  let { userId, name, tag, serverId, large = false }: { userId: string; name: string; tag?: string; serverId: string; large?: boolean } = $props();
  let loaded = $state(false);
  let failed = $state(false);
  const src = $derived(tag ? userImageUrl(userId, tag, large ? 56 : 34, serverId) : null);
</script>

<span class="avatar" class:lg={large} aria-hidden="true">
  {name.slice(0, 1).toUpperCase()}
  {#if src && !failed}
    {#key src}
      <img {src} alt="" class:loaded decoding="async" onload={() => (loaded = true)} onerror={() => (failed = true)} />
    {/key}
  {/if}
</span>
