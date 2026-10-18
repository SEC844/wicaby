<script lang="ts">
  // Step 3: where the server is. Each card opens one part of the server page (Servers.svelte `section`),
  // which reports the server it added instead of navigating.
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { ServerInfo, ServerSession } from '../../../shared/contract';
  import Icon, { type IconName } from '../../components/Icon.svelte';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { onlineSessions } from '../../lib/stores.svelte';
  import Servers from '../Servers.svelte';
  import { dur } from '../../lib/motion';

  let { onready }: { onready: (server: ServerInfo, status: ServerSession['status']) => void } = $props();

  type Section = 'lan' | 'vpn' | 'public';
  const CARDS: { id: Section; icon: IconName }[] = [
    { id: 'lan', icon: 'wifi' },
    { id: 'vpn', icon: 'network' },
    { id: 'public', icon: 'globe' },
  ];
  let section = $state<Section | null>(null);
  const signed = $derived(onlineSessions());

  onMount(() => {
    // A server found on the first scan preselects "On This Network".
    w.servers
      .discover()
      .then((list) => {
        if (list.length && section === null) section = 'lan';
      })
      .catch(() => undefined);
  });
</script>

<h1>{t('welcome.where.title')}</h1>
{#if signed.length}
  <p class="lead"><Icon name="check" size={15} stroke={2} /> {t('welcome.where.yours', { servers: fmt.list(signed.map((s) => s.server.name)) })}</p>
{/if}

<div class="cards" role="radiogroup" aria-label={t('welcome.where.title')}>
  {#each CARDS as c (c.id)}
    <button type="button" class="where" role="radio" data-where={c.id} aria-checked={section === c.id} class:on={section === c.id} onclick={() => (section = c.id)}>
      <span class="glyph"><Icon name={c.icon} size={20} /></span>
      <span class="title">{t(`welcome.where.${c.id}.title`)}</span>
      <span class="sub">{t(`welcome.where.${c.id}.body`)}</span>
    </button>
  {/each}
</div>

{#if section}
  {#key section}
    <div class="panel" in:fly={{ y: 8, duration: dur('med'), easing: cubicOut }}>
      <Servers {section} {onready} onbyaddress={() => (section = 'public')} />
    </div>
  {/key}
{/if}

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .where {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-height: 132px;
    padding: 16px 16px 14px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    text-align: left;
    transition:
      transform var(--t-med) var(--spring);
  }
  .where:is(:hover, :focus-visible) {
    background: var(--fill-2);
  }
  .where:active {
    transform: scale(0.98);
  }
  .where.on {
    background: var(--fill-2);
    box-shadow: inset 0 0 0 1.5px var(--label);
  }
  .glyph {
    margin-bottom: 8px;
    color: var(--label-2);
  }
  .where.on .glyph {
    color: var(--accent);
  }
  .title {
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .sub {
    font-size: var(--fs-footnote);
    line-height: 1.4;
    color: var(--label-3);
  }
  .lead :global(.wi-icon) {
    vertical-align: -2px;
    color: var(--success);
  }
  @media (max-width: 620px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
