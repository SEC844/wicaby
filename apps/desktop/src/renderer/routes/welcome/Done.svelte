<script lang="ts">
  // Step 6: what is now connected, with the status popover's own list (ConnectionList, rows inert here).
  import { onMount } from 'svelte';
  import type { VpnStatus } from '../../../shared/contract';
  import ConnectionList, { listedServers } from '../../components/ConnectionList.svelte';
  import Icon from '../../components/Icon.svelte';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';

  let { onremote }: { onremote: () => void } = $props();

  let vpn = $state<VpnStatus[]>([]);
  const none = $derived(listedServers().length === 0);

  onMount(() => {
    w.vpn
      .status()
      .then((v) => (vpn = v))
      .catch(() => undefined);
  });
</script>

<div class="head">
  <span class="check"><Icon name="check" size={26} stroke={2.4} /></span>
  <h1>{t('welcome.done.title')}</h1>
</div>

<div class="list">
  {#if none}<p class="none">{t('welcome.done.none')}</p>{/if}
  <ConnectionList {vpn} interactive={false} />
</div>

<button type="button" class="quiet-link" data-action="remote" onclick={onremote}>{t('welcome.done.remote')}</button>

<style>
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .check {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    color: var(--accent-fg);
    background: var(--accent);
    animation: pop var(--t-slow) var(--spring) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  .list {
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
  }
  .none {
    margin: 0;
    padding: 10px 12px;
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
</style>
