<script lang="ts">
  import { tick } from 'svelte';
  import type { CastSection, CastTarget } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { cast, castTo, closeCastPicker } from '../lib/cast.svelte';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // "Lire sur…" (cast-spec §2.2): one list, three sections, "This computer" first while casting. Main discovers
  // only while this is open; Sessions-API rows today, DLNA (CA-07) and Chromecast (CA-09) rows later.
  const SECTIONS: CastSection[] = ['apps', 'dlna', 'chromecast'];
  const ICON = { apps: 'tv', dlna: 'tv', chromecast: 'cast' } as const;
  // Speakers and speaker groups say so, by icon and words (their model is often a bare "Google Cast Group").
  const icon = (r: CastTarget, s: CastSection) => (r.device === 'group' ? 'speakerGroup' : r.device === 'speaker' ? 'speaker' : ICON[s]);
  const detailOf = (r: CastTarget) => (r.via ? t('cast.picker.viaServer', { server: r.via }) : r.device === 'group' ? t('cast.picker.group') : r.detail || (r.device === 'speaker' ? t('cast.picker.speaker') : ''));

  let rows = $state<CastTarget[]>([]);
  let searching = $state(false);
  let body = $state<HTMLDivElement>();
  const req = $derived(cast.picker);
  const groups = $derived(SECTIONS.map((s) => ({ s, list: rows.filter((r) => r.section === s) })).filter((g) => g.list.length));

  $effect(() => {
    const r = cast.picker;
    if (!r) return;
    rows = [];
    searching = true;
    let live = true;
    // Braces: an IPC listener must return nothing (`rows = list` evaluates to the $state proxy, which the bridge cannot clone).
    const off = w.cast.onTargets((list) => {
      if (live) rows = list;
    });
    w.cast
      .targets(r.itemId, r.serverId)
      .then((list) => live && (rows = list), () => undefined)
      .finally(() => live && (searching = false));
    return () => {
      live = false;
      off();
    };
  });

  // Rows arrive after the sheet took focus (on its close button): the first row gets it.
  $effect(() => {
    if (!rows.length) return;
    void tick().then(() => {
      if (body && !body.contains(document.activeElement)) body.querySelector<HTMLElement>('.row')?.focus({ preventScroll: true });
    });
  });

  // Up/Down move between rows; Enter casts (the row is a button); Escape is the sheet's.
  function arrows(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...(body?.querySelectorAll<HTMLElement>('.row') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  }

  function playHere(): void {
    closeCastPicker();
    void w.cast.takeBack();
  }
</script>

<Sheet open={Boolean(req)} onclose={closeCastPicker} label={t('cast.picker.title')} width={440}>
  <div class="body" bind:this={body} onkeydown={arrows} role="presentation">
    <h2 class="title-3">{t('cast.picker.title')}</h2>
    {#if cast.state}
      <button class="row" onclick={playHere}>
        <Icon name="laptop" size={18} />
        <span class="lbl"><span class="name">{t('cast.picker.thisDevice')}</span><span class="detail">{t('cast.remote.playHere')}</span></span>
      </button>
    {/if}
    {#each groups as g (g.s)}
      <section aria-labelledby="cast-section-{g.s}">
        <h3 class="col-h" id="cast-section-{g.s}">{t(`cast.picker.section.${g.s}`)}</h3>
        <ul class="rows">
          {#each g.list as r (r.key)}
            {@const detail = detailOf(r)}
            <li>
              <!-- The accessible name carries the transport too (the section), not only the icon. -->
              <button class="row" aria-label="{r.name}, {t(`cast.picker.section.${g.s}`)}{detail ? `, ${detail}` : ''}" aria-current={cast.state?.target.key === r.key || undefined} onclick={() => void castTo(r.key)}>
                <Icon name={icon(r, g.s)} size={18} />
                <span class="lbl"><span class="name">{r.name}</span>{#if detail}<span class="detail">{detail}</span>{/if}</span>
                {#if cast.state?.target.key === r.key}<Icon name="check" size={14} stroke={2.4} />{/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    {#if searching}
      <p class="note" role="status"><span class="spin" aria-hidden="true"></span>{t('cast.picker.searching')}</p>
    {:else if rows.length === 0}
      <div class="note empty" role="status">
        <p>{t('cast.picker.empty')}</p>
        <p class="hint">{t('cast.picker.emptyHint')}</p>
      </div>
    {/if}
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0 0 10px;
    padding-right: 40px;
  }
  section {
    margin-top: 10px;
  }
  .col-h {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--label-2);
  }
  .rows {
    list-style: none;
    margin: 0 -8px;
    padding: 0;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
  }
  .body > .row {
    margin: 0 -8px;
    width: calc(100% + 16px);
  }
  .row:hover,
  .row:focus-visible {
    background: var(--fill-2);
  }
  .lbl {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font-size: 12px;
    color: var(--label-2);
  }
  .note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 14px 0 0;
    color: var(--label-2);
  }
  .empty {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .empty p {
    margin: 0;
  }
  .hint {
    font-size: 12px;
    color: var(--label-3);
  }
  .spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
