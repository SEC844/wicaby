<script lang="ts">
  // Android TV ProfileMenu (Main.kt): a sheet under the top bar's avatar with who is signed in, then Switch User,
  // Switch Server, History (TP-08), Settings and Sign Out.
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n.svelte';
  import Sheet from './Sheet.svelte';
  import SheetButton from './SheetButton.svelte';

  let {
    name,
    server,
    image,
    onclose,
    onswitchuser,
    onswitchserver,
    onhistory,
    onsettings,
    onsignout,
    extra,
  }: {
    name: string;
    server: string;
    image?: string;
    onclose: () => void;
    onswitchuser: () => void;
    onswitchserver: () => void;
    onhistory: () => void;
    onsettings: () => void;
    onsignout: () => void;
    // Rows of the account's own, after History (Quick Connect on Jellyfin).
    extra?: Snippet;
  } = $props();

  const run = (action: () => void) => () => {
    onclose();
    action();
  };
</script>

<Sheet width={340} corner {onclose}>
  <div class="who">
    <span class="disc">{#if image}<img src={image} alt="" />{:else}<span class="t-title3">{name.slice(0, 1).toUpperCase()}</span>{/if}</span>
    <div class="text">
      <p class="t-title3 ellipsis">{name}</p>
      <p class="t-footnote label-3 ellipsis">{server}</p>
    </div>
  </div>
  <SheetButton text={t('switch_user')} icon="Person" onclick={run(onswitchuser)} />
  <SheetButton text={t('switch_server')} icon="Server" onclick={run(onswitchserver)} />
  <SheetButton text={t('history')} icon="History" onclick={run(onhistory)} />
  {@render extra?.()}
  <SheetButton text={t('tab_settings')} icon="Gear" onclick={run(onsettings)} />
  <SheetButton text={t('sign_out')} icon="Logout" onclick={run(onsignout)} />
</Sheet>

<style>
  .who {
    display: flex;
    align-items: center;
    margin-bottom: 20rem;
  }
  .disc {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 52rem;
    height: 52rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--fill-2);
  }
  .disc img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    min-width: 0;
    margin-left: 14rem;
  }
  .text p {
    margin: 0;
  }
</style>
