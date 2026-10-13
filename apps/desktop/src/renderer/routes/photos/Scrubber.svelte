<script lang="ts">
  // Date scrubber (photos spec PH-02): a rail on the scroller's right edge, proportional to the laid-out height.
  // Year ticks sit at their first month; years not loaded yet share the estimated tail. Dragging jumps (no smooth
  // scroll) and names the month under the pointer; PageUp/PageDown move one month, Home/End go to the ends.
  import { onMount } from 'svelte';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { monthAt, type Month } from '../../lib/photos/grid';

  let {
    months,
    height,
    loaded,
    years,
    viewTop,
    vh,
    sticky,
    onseek,
  }: { months: Month[]; height: number; loaded: number; years: number[]; viewTop: number; vh: number; sticky: number; onseek: (y: number) => void } = $props();

  const scroller = document.getElementById('main-scroller');
  let rect = $state({ top: 0, height: 0, right: 0 });
  let drag = $state<{ y: number; label: string } | null>(null);

  function place(): void {
    const r = scroller?.getBoundingClientRect();
    if (r) rect = { top: r.top + sticky + 8, height: Math.max(0, r.height - sticky - 24), right: window.innerWidth - r.right + 6 };
  }
  onMount(() => {
    place();
    const ro = new ResizeObserver(place);
    if (scroller) ro.observe(scroller);
    return () => ro.disconnect();
  });

  const ticks = $derived.by(() => {
    const out: { year: string; at: number }[] = [];
    const seen = new Set<string>();
    for (const m of months) {
      const y = m.key.slice(0, 4);
      if (!seen.has(y)) (seen.add(y), out.push({ year: y, at: m.top / height }));
    }
    const rest = years.map(String).filter((y) => !seen.has(y));
    const from = loaded / height;
    rest.forEach((y, i) => out.push({ year: y, at: from + ((1 - from) * (i + 0.5)) / rest.length }));
    // Labels closer than 16 px would overlap: keep the first of each cluster.
    let last = -Infinity;
    return out.map((tk) => {
      const px = tk.at * rect.height;
      const shown = px - last >= 16;
      if (shown) last = px;
      return { ...tk, shown };
    });
  });

  const monthLabel = (key: string) => fmt.date(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1), { month: 'long', year: 'numeric' });
  const current = $derived(monthAt(months, viewTop + sticky + 1));
  const thumb = $derived(height > 0 ? Math.min(1, Math.max(0, (viewTop + sticky) / height)) : 0);

  // Grid y and label at a rail position: the month there, or its year in the not-yet-loaded tail.
  function at(clientY: number): { y: number; label: string } {
    const p = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
    const y = p * height;
    if (y < loaded || !ticks.length) {
      // The nearest month start, so a year tick lands on that year's first month, not the month before it.
      let i = monthAt(months, y);
      if (months[i + 1] && months[i + 1].top - y < y - months[i].top) i++;
      const m = months[i];
      return { y: m?.top ?? y, label: m ? monthLabel(m.key) : '' };
    }
    return { y, label: [...ticks].reverse().find((tk) => tk.at <= p)?.year ?? '' };
  }

  function down(e: PointerEvent): void {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = at(e.clientY);
    onseek(drag.y);
  }
  function move(e: PointerEvent): void {
    if (!drag) return;
    const next = at(e.clientY);
    if (next.y !== drag.y) onseek(next.y);
    drag = next;
  }

  function key(e: KeyboardEvent): void {
    const go = (i: number) => onseek(months[Math.max(0, Math.min(months.length - 1, i))]?.top ?? 0);
    if (e.key === 'PageDown') go(current + 1);
    else if (e.key === 'PageUp') go(months[current] && months[current].top < viewTop + sticky - 1 ? current : current - 1);
    else if (e.key === 'Home') onseek(0);
    else if (e.key === 'End') onseek(Math.max(0, height - vh + sticky));
    else return;
    e.preventDefault();
  }
</script>

<div
  class="rail"
  class:dragging={drag !== null}
  style:top="{rect.top}px"
  style:height="{rect.height}px"
  style:right="{rect.right}px"
  role="slider"
  tabindex="0"
  aria-label={t('photos.scrubber.label')}
  aria-orientation="vertical"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(thumb * 100)}
  aria-valuetext={months[current] ? monthLabel(months[current].key) : ''}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={() => (drag = null)}
  onpointercancel={() => (drag = null)}
  onkeydown={key}
>
  {#each ticks as tk (tk.year)}
    <span class="tick" data-year={tk.year} class:quiet={!tk.shown} style:top="{tk.at * 100}%"><span class="caption">{tk.shown ? tk.year : ''}</span></span>
  {/each}
  <span class="thumb" style:top="{thumb * 100}%" aria-hidden="true"></span>
  {#if drag?.label}<span class="pill material-thin footnote" style:top="{((drag.y / Math.max(1, height)) * 100).toFixed(2)}%">{drag.label}</span>{/if}
</div>

<style>
  .rail {
    position: fixed;
    z-index: 6;
    width: 24px;
    touch-action: none;
    cursor: ns-resize;
    transition: width var(--t-fast) var(--ease);
  }
  .rail:hover,
  .rail:focus-visible,
  .rail.dragging {
    width: 48px;
  }
  .tick {
    position: absolute;
    right: 4px;
    display: flex;
    align-items: center;
    gap: 4px;
    translate: 0 -50%;
    pointer-events: none;
  }
  .tick::after {
    content: '';
    width: 6px;
    height: 1px;
    background: var(--label-3);
  }
  .tick.quiet::after {
    width: 3px;
  }
  .caption {
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .rail:hover .caption,
  .rail:focus-visible .caption,
  .rail.dragging .caption {
    opacity: 1;
  }
  .thumb {
    position: absolute;
    right: 2px;
    width: 4px;
    height: 28px;
    border-radius: 2px;
    background: var(--label-2);
    translate: 0 -2px;
    pointer-events: none;
  }
  .pill {
    position: absolute;
    right: 56px;
    padding: 6px 12px;
    border-radius: 999px;
    white-space: nowrap;
    color: var(--label);
    translate: 0 -50%;
    pointer-events: none;
    box-shadow: var(--shadow-3);
  }
</style>
