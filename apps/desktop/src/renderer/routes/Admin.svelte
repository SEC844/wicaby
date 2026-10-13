<script lang="ts">
  import { kindLabel } from '../../shared/server-caps';
  // Server administration: a quiet section list (like Settings) and the
  // section's own component. Only servers where the signed-in user is an
  // administrator are offered; every admin call goes to the picked server.
  // Routes: /admin, /admin/<section>, /admin/<serverId>/<section>.
  import '../admin/admin.css';
  import { ADMIN_SECTIONS } from '../admin/sections';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import LogoLoader from '../components/LogoLoader.svelte';
  import Picker from '../components/Picker.svelte';
  import { t } from '../lib/i18n.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { onlineSessions } from '../lib/stores.svelte';

  const admins = $derived(onlineSessions().filter((s) => s.user?.isAdmin));
  const params = $derived(router.route.params);
  // One segment is a section; two are server then section.
  const wanted = $derived(params.server ? { server: params.server, section: params.id } : { server: '', section: params.id ?? '' });
  const current = $derived(admins.find((s) => s.server.id === wanted.server) ?? admins[0]);
  const section = $derived(ADMIN_SECTIONS.find((s) => s.id === wanted.section) ?? ADMIN_SECTIONS[0]);

  function go(serverId: string, sectionId: string): void {
    navigate(`/admin/${encodeURIComponent(serverId)}/${sectionId}`, { replace: true });
  }
</script>

<div class="page admin fade-in">
  <div class="title-row">
    <h1 class="page-title">{t('admin.title')}</h1>
    {#if admins.length > 1 && current}
      <Picker
        label={t('admin.serverPicker')}
        value={current.server.id}
        options={admins.map((s) => ({ value: s.server.id, label: s.server.name }))}
        onchange={(id) => section && go(id, section.id)}
      />
    {:else if current}
      <span class="server-name">{current.server.name}</span>
    {/if}
  </div>

  {#if !current}
    <p class="none">{t('admin.noAdminServer')}</p>
  {:else if !section}
    <p class="none">{t('admin.noSections')}</p>
  {:else}
    <div class="layout">
      <nav class="cats" aria-label={t('admin.sectionsLabel')}>
        {#each ADMIN_SECTIONS as s (s.id)}
          <button
            type="button"
            class:active={section.id === s.id}
            aria-current={section.id === s.id ? 'page' : undefined}
            title={t(s.label)}
            onclick={() => go(current.server.id, s.id)}
          >
            <span class="cat-icon"><Icon name={s.icon as IconName} size={16} /></span>
            <span class="cat-label">{t(s.label)}</span>
          </button>
        {/each}
      </nav>

      {#key `${current.server.id}/${section.id}`}
        <div class="pane">
          <header class="pane-head">
            <h2>{t(section.label)}</h2>
            <p>{current.server.name} · {kindLabel(current.server.kind)}</p>
          </header>
          {#await section.load()}
            <div class="loading"><LogoLoader size={64} delay={200} /></div>
          {:then mod}
            <mod.default serverId={current.server.id} kind={current.server.kind} />
          {:catch err}
            <p class="none">{t('admin.loadFailed')} <span class="caption">{String(err)}</span></p>
          {/await}
        </div>
      {/key}
    </div>
  {/if}
</div>

<style>
  .title-row {
    display: flex;
    align-items: center;
    gap: 24px;
    max-width: 1180px;
    margin-bottom: 20px;
  }
  .title-row .page-title {
    margin: 0;
    flex: 1;
  }
  .server-name {
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .none {
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .loading {
    display: grid;
    place-items: center;
    height: 320px;
  }
  .layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 920px);
    gap: 44px;
    align-items: start;
  }

  /* Section list: the same plain, monochrome rows as Settings. */
  .cats {
    position: sticky;
    top: 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .cats button {
    display: flex;
    align-items: center;
    gap: 11px;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body);
    font-weight: 450;
    color: var(--label-2);
    text-align: left;
  }
  .cats button:hover,
  .cats button:focus-visible {
    background: var(--fill-1);
    color: var(--label);
    transition:
      background-color calc(100ms * var(--tempo)) linear,
      color calc(100ms * var(--tempo)) linear;
  }
  .cats button.active {
    background: var(--fill-2);
    color: var(--label);
    font-weight: 500;
    transition: none;
  }
  .cat-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    color: var(--label-3);
  }
  .cats button:hover .cat-icon,
  .cats button:focus-visible .cat-icon {
    color: var(--label-2);
  }
  .cats button.active .cat-icon {
    color: var(--label);
  }
  .cat-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 980px) {
    .layout {
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 28px;
    }
    .cats button {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .cat-label {
      display: none;
    }
  }

  .pane {
    min-width: 0;
    display: flex;
    flex-direction: column;
    animation: pane-in calc(140ms * var(--tempo)) var(--ease-out) both;
  }
  @keyframes pane-in {
    from {
      opacity: 0;
      transform: translate3d(0, 4px, 0);
    }
  }
  .pane-head {
    margin: 2px 0 22px;
  }
  .pane-head h2 {
    margin: 0;
    font-size: var(--fs-title-3);
    font-weight: 600;
    letter-spacing: -0.014em;
    line-height: 1.25;
  }
  .pane-head p {
    margin: 4px 0 0;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
</style>
