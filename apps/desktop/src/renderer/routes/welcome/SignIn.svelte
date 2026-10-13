<script lang="ts">
  // Step 4: sign in to the server step 3 added, with the sign-in page itself (Login.svelte `onsignedin`).
  import Login from '../Login.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { sessionFor, toast } from '../../lib/stores.svelte';

  let {
    serverId,
    onsignedin,
    onaddanother,
    onoffline,
  }: { serverId: string; onsignedin: () => void; onaddanother: () => void; onoffline: () => void } = $props();

  const server = $derived(sessionFor(serverId)?.server);

  // The server went away meanwhile: back to step 3, which can reach it another way.
  $effect(() => {
    const s = sessionFor(serverId);
    if (s?.status !== 'offline') return;
    toast('error', t('onboarding.servers.unreachable.title', { name: s.server.name }));
    onoffline();
  });
</script>

<h1>{t('welcome.signin.title', { server: server?.name ?? '' })}</h1>
{#key serverId}<Login {serverId} {onsignedin} />{/key}
<button type="button" class="quiet-link" data-action="add-another" onclick={onaddanother}>{t('welcome.signin.addAnother')}</button>
