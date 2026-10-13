<script lang="ts">
  import { dayKey } from '../../../shared/livetv/anchor';
  import { nameKey } from '../../../shared/livetv/channel-order';
  import { searchPrograms } from '../../../shared/livetv/dialect';
  import { searchChannels } from '../../../shared/livetv/lens';
  import { normalizeProgram } from '../../../shared/livetv/model';
  import type { ChannelRow, ProgramLite } from '../../../shared/livetv/model';
  import type { PendingJump } from '../../../shared/livetv/nav';
  import { fmt, t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import Sheet from '../Sheet.svelte';
  import { channelLogoUrl, logoPlate } from '../Guide.svelte';

  // Guide search (§6.8, LT-10): channels first (in memory: name, number prefix, Emby tag; at most 8),
  // then programmes from 2 characters after 300 ms. Emby asks the server; Jellyfin probes /Items and
  // falls back to the loaded tiles when the server finds nothing the cache has (programSearch=memory).
  let { store, open, onclose, onpick }: { store: LiveTvStore; open: boolean; onclose: () => void; onpick: (j: PendingJump) => void } = $props();

  let query = $state('');
  let programs = $state.raw<ProgramLite[]>([]);
  let searching = $state(false);
  let seq = 0;

  const hidden = $derived(new Set(store.prefs.hidden));
  const channels = $derived(query.trim() ? searchChannels(store.channels.filter((r) => !hidden.has(r.id)), query) : []);
  const byId = $derived(new Map(store.channels.map((r) => [r.id, r])));

  function memory(q: string): ProgramLite[] {
    const k = nameKey(q);
    const from = store.now() - 3_600_000;
    const out: ProgramLite[] = [];
    for (const r of store.channels) for (const p of store.loader.cache.programs(r.id)) if (p.end > from && nameKey(p.title).includes(k)) out.push(p);
    return out.sort((a, b) => a.start - b.start).slice(0, 30);
  }

  async function server(q: string): Promise<ProgramLite[]> {
    if (store.caps.programSearch === 'memory') return memory(q);
    const now = store.now();
    const req = searchPrograms(store.kind, { userId: store.userId, query: q, now, guideEnd: store.guideEnd ?? now + 7 * 86_400_000 });
    try {
      const r = await store.api.run<{ Items?: Record<string, unknown>[] }>(req);
      const list = (r.data?.Items ?? []).map((d) => normalizeProgram(d, { kind: store.kind, categorySource: store.caps.categorySource })).filter((p): p is ProgramLite => !!p && p.end > now - 3_600_000);
      if (!list.length && store.kind === 'jellyfin') {
        const m = memory(q);
        if (m.length) store.caps.programSearch = 'memory';
        return m;
      }
      return list.sort((a, b) => a.start - b.start).slice(0, 30);
    } catch {
      return memory(q);
    }
  }

  $effect(() => {
    const q = query.trim();
    const id = ++seq;
    if (q.length < 2) {
      programs = [];
      searching = false;
      return;
    }
    searching = true;
    const timer = setTimeout(() => {
      void server(q).then((list) => {
        if (id !== seq) return;
        programs = list;
        searching = false;
      });
    }, 300);
    return () => clearTimeout(timer);
  });

  const groups = $derived.by(() => {
    const out: { key: string; label: string; items: ProgramLite[] }[] = [];
    for (const p of programs) {
      const key = dayKey(p.start);
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, label: fmt.date(p.start, { weekday: 'long', day: 'numeric', month: 'long' }), items: [] }));
      g.items.push(p);
    }
    return out;
  });

  function pickChannel(r: ChannelRow): void {
    onpick({ channelId: r.id, time: store.now() });
    close();
  }

  function pickProgram(p: ProgramLite): void {
    onpick({ channelId: p.channelId, programId: p.id, time: p.start });
    close();
  }

  function close(): void {
    query = '';
    onclose();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (channels[0]) pickChannel(channels[0]);
    else if (programs[0]) pickProgram(programs[0]);
  }
</script>

<Sheet {open} onclose={close} label={t('livetv.actions.search')} width={560}>
  <div class="search">
    <input class="field" type="search" bind:value={query} placeholder={t('livetv.search.placeholder')} aria-label={t('livetv.search.placeholder')} onkeydown={onKey} data-autofocus />

    {#if channels.length}
      <h3 class="caption">{t('livetv.search.channels')}</h3>
      <ul>
        {#each channels as r (r.id)}
          <li>
            <button class="hit" onclick={() => pickChannel(r)}>
              <span class="num mono">{r.number}</span>
              {#if r.logoTag}<img class="logo" src={channelLogoUrl(r, 28)} alt="" crossorigin="anonymous" loading="lazy" use:logoPlate />{/if}
              <span class="name">{r.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if query.trim().length > 0 && query.trim().length < 2 && !channels.length}
      <p class="footnote">{t('livetv.search.minChars')}</p>
    {:else if groups.length}
      <h3 class="caption">{t('livetv.search.programs')}</h3>
      {#each groups as g (g.key)}
        <div class="day caption">{g.label}</div>
        <ul>
          {#each g.items as p (p.id)}
            {@const on = p.start <= store.clock && p.end > store.clock}
            <li>
              <button class="hit" onclick={() => pickProgram(p)}>
                <span class="time mono">{fmt.time(p.start)} – {fmt.time(p.end)}</span>
                <span class="name">{p.title}</span>
                <span class="chan">{byId.get(p.channelId)?.name ?? ''}</span>
                {#if on}<span class="badge">{t('livetv.program.onNow')}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
    {:else if query.trim().length >= 2 && !searching && !channels.length}
      <p class="footnote">{t('livetv.search.empty', { query: query.trim() })}</p>
    {/if}
  </div>
</Sheet>

<style>
  .search {
    display: grid;
    gap: 8px;
    padding: 56px 24px 20px; /* the sheet's close button sits top right */
    max-height: min(70vh, 640px);
    overflow-y: auto;
  }
  .field {
    width: 100%;
  }
  h3 {
    margin: 10px 0 0;
  }
  .day {
    margin-top: 6px;
    text-transform: capitalize;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .hit {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label-2);
  }
  .hit:is(:hover, :focus-visible) {
    background: var(--fill-4);
    color: var(--label);
  }
  .num {
    width: 40px;
    flex: none;
    color: var(--label-3);
  }
  .time {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .logo {
    width: 56px;
    height: 28px;
    flex: none;
    object-fit: contain;
    object-position: left center;
    border-radius: var(--r-xs);
  }
  .logo:global([data-plate]) {
    padding: 2px 4px;
    background: color-mix(in srgb, var(--label) 85%, transparent);
  }
  .name {
    flex: 1;
    min-width: 0;
    font-weight: 560;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chan {
    flex: none;
    max-width: 30%;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    flex: none;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--fill-3);
    font-size: var(--fs-caption);
  }
</style>
