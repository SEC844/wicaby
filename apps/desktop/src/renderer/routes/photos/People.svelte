<script lang="ts">
  // People tab of an Immich source (photos spec F5, PH-12): the people the server recognised and the user named,
  // read-only (no naming or merging here). Opening one shows the timeline of their photos (personId).
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { immichUrl } from '../../lib/images';
  import { reveal } from '../../lib/motion';
  import { immichError, immichPeople, type ImmichPerson } from '../../lib/photos/immich.svelte';

  let { source, onopen }: { source: string; onopen: (person: ImmichPerson) => void } = $props();

  let people = $state<ImmichPerson[] | null>(null);
  let error = $state('');

  $effect(() => {
    immichPeople(source)
      .then((r) => (people = r))
      .catch((err) => (error = immichError(err, 'person.read')));
  });
</script>

{#if error}
  <div class="note"><Icon name="exclamation" size={16} /> {error}</div>
{:else if people && people.length === 0}
  <div class="note">{t('photos.people.empty')}</div>
{:else if people}
  <div class="people">
    {#each people as p (p.id)}
      <button class="person" onclick={() => onopen(p)}>
        <span class="face"><img class="reveal" use:reveal src={immichUrl(source, `people/${p.id}/thumbnail`)} alt="" loading="lazy" decoding="async" draggable="false" /></span>
        <span class="name headline">{p.name}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .people {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 10vw, 160px), 1fr));
    gap: 24px clamp(14px, 1.3vw, 22px);
    padding: 8px var(--gutter) 0;
  }
  .person {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 0;
    border-radius: var(--r-md);
  }
  .face {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 50%;
    background: var(--fill-1);
    transition:
      scale var(--t-med) var(--spring),
      box-shadow var(--t-med) var(--ease);
  }
  .person:is(:hover, :focus-visible) .face {
    scale: 1.04;
    box-shadow: var(--shadow-3);
  }
  .face img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 48px var(--gutter);
    color: var(--label-3);
  }
</style>
