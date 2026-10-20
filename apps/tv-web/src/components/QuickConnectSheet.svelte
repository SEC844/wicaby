<script lang="ts">
  // Android TV QuickConnectSheet (Setup.kt): the Quick Connect code to approve from a device already signed in,
  // renewed when it expires; signs in once approved. Closing it stops the wait.
  import type { AuthenticationResult } from '$shared/models';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import Sheet from './Sheet.svelte';
  import SheetButton from './SheetButton.svelte';
  import Spinner from './Spinner.svelte';

  let { api, onclose, onsignedin }: { api: Api; onclose: () => void; onsignedin: (r: AuthenticationResult) => void } = $props();

  let code = $state<string | null>(null);
  let message = $state<string | null>(null);

  onMount(() => {
    let stopped = false;
    api.quickConnect((c) => (code = c), () => stopped).then(
      (r) => !stopped && onsignedin(r),
      (e) => {
        if (stopped) return;
        message = e instanceof ApiError && e.status ? e.message : t('server_unreachable');
      },
    );
    return () => (stopped = true);
  });
</script>

<Sheet width={460} {onclose}>
  <p class="t-title2 center">{t('quick_connect_title')}</p>
  <p class="t-callout label-2 center body">{t('quick_connect_body')}</p>
  {#if code}
    <p class="t-large-title center code">{code}</p>
  {:else if !message}
    <div class="center spin"><Spinner /></div>
  {/if}
  {#if message}<p class="t-callout center error">{message}</p>{/if}
  <div class="close"><SheetButton text={t('close')} autofocus onclick={onclose} /></div>
</Sheet>

<style>
  p {
    margin: 0;
  }
  .center {
    text-align: center;
  }
  .body {
    margin: 8rem 0 18rem;
  }
  .code {
    letter-spacing: 0.08em;
  }
  .spin {
    display: flex;
    justify-content: center;
  }
  .error {
    margin-top: 12rem;
    color: var(--red);
  }
  .close {
    margin-top: 18rem;
  }
</style>
