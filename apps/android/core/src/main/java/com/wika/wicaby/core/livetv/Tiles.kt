package com.wika.wicaby.core.livetv

import kotlinx.serialization.Serializable

// Live TV guide data windowing (spec §2.2, §6.2, §6.3): slab maths, EPG hygiene, the row lookup
// (binary search) and the tile planner. Mirrors D/shared/livetv/tiles.ts (golden vectors:
// tiles.json). The tuning table and the device class (TUNING, deviceClass in tiles.ts) are in
// DeviceClass.kt (C-5): PlatformTuning, DeviceClass.tuning, classifyDevice.

// ---- Slabs: 3 h aligned to UTC (fetch unit only; days and dayparts are local) ----

const val SLAB_MS = 10_800_000L

fun slabOf(t: Long): Long = Math.floorDiv(t, SLAB_MS)
fun slabStart(k: Long): Long = k * SLAB_MS
fun slabEnd(k: Long): Long = (k + 1) * SLAB_MS

/** Slabs intersecting [from, to). */
fun slabRange(from: Long, to: Long): List<Long> {
    if (to <= from) return emptyList()
    return (slabOf(from)..slabOf(to - 1)).toList()
}

fun coverageKey(channelId: String, slab: Long): String = "$channelId|$slab"

// ---- EPG hygiene (§4.4), on ingest ----

/**
 * De-duplicate by id (the later occurrence wins, so a fresher answer replaces the cache and a
 * programme spanning two slabs merges), drop end <= start, sort by start (then longer first, then
 * id), clip overlaps (prev.end = min(prev.end, next.start)) and drop what clipping emptied.
 */
fun cleanPrograms(list: List<ProgramLite>): List<ProgramLite> {
    val byId = LinkedHashMap<String, ProgramLite>()
    for (p in list) {
        byId.remove(p.id)
        byId[p.id] = p
    }
    val sorted = byId.values.filter { it.end > it.start }.sortedWith { a, b ->
        a.start.compareTo(b.start).takeIf { it != 0 } ?: b.end.compareTo(a.end).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }
    val out = ArrayList<ProgramLite>(sorted.size)
    for (i in sorted.indices) {
        val p = sorted[i]
        val next = sorted.getOrNull(i + 1)
        val end = if (next != null && next.start < p.end) next.start else p.end
        if (end <= p.start) continue
        out.add(if (end == p.end) p else p.copy(end = end))
    }
    return out
}

fun mergePrograms(cached: List<ProgramLite>, incoming: List<ProgramLite>): List<ProgramLite> = cleanPrograms(cached + incoming)

// ---- Row lookup on a clean (start-sorted, non-overlapping) list ----

/** First index whose end > t (list.size when none). */
fun firstEndingAfter(list: List<ProgramLite>, t: Long): Int {
    var lo = 0
    var hi = list.size
    while (lo < hi) {
        val mid = (lo + hi) ushr 1
        if (list[mid].end > t) hi = mid else lo = mid + 1
    }
    return lo
}

/** Programmes intersecting [from, to): binary search, then walk while start < to. */
fun programsInWindow(list: List<ProgramLite>, from: Long, to: Long): List<ProgramLite> {
    val out = ArrayList<ProgramLite>()
    var i = firstEndingAfter(list, from)
    while (i < list.size && list[i].start < to) out.add(list[i++])
    return out
}

fun programAt(list: List<ProgramLite>, t: Long): ProgramLite? {
    val i = firstEndingAfter(list, t)
    return if (i < list.size && list[i].start <= t) list[i] else null
}

// ---- Tile planner (§6.3) ----

/** The visible part of the guide: rows in lens order, visible rows (inclusive) and time span [from, to). */
data class Viewport(
    val rows: List<String>,
    val firstRow: Int,
    val lastRow: Int,
    val from: Long,
    val to: Long,
    val tuning: PlatformTuning,
)

data class PlanInput(
    val view: Viewport,
    /** Horizontal scroll direction: -1, 0 or 1. */
    val dir: Int,
    /** Coverage keys (fresh), plus queued or in-flight keys. */
    val covered: Collection<String>,
    /** P3 runs only when idle. */
    val idle: Boolean = false,
    val now: Long? = null,
    /** Favourites first (then the first rows on desktop), see [idleSet]. */
    val idleIds: List<String> = emptyList(),
)

@Serializable
data class TileRequest(
    /** 0..3 */
    val priority: Int,
    val channelIds: List<String>,
    /** Contiguous. */
    val slabs: List<Long>,
    /** MinEndDate = first slab start. */
    val from: Long,
    /** MaxStartDate = last slab end. */
    val to: Long,
)

/** The P3 idle prefetch set (§2.2): favourites, then (desktop) the first rows of the lens. */
fun idleSet(favorites: List<String>, lensRows: List<String>, tuning: PlatformTuning): List<String> {
    val out = ArrayList<String>()
    val seen = HashSet<String>()
    fun add(id: String) {
        if (out.size < tuning.idleMax && seen.add(id)) out.add(id)
    }
    favorites.forEach(::add)
    if (!tuning.idleFavoritesOnly) lensRows.forEach(::add)
    return out
}

data class PlanWindow(val rowFrom: Int, val rowTo: Int, val slabFrom: Long, val slabTo: Long)

/** Visible rows plus overscan, slabs plus overscan: the window a queued request must still touch. */
fun planWindow(v: Viewport): PlanWindow {
    val t = v.tuning
    val ov = t.timeOverscanMin * 60_000L
    val slabs = slabRange(v.from - ov, v.to + ov)
    return PlanWindow(
        rowFrom = maxOf(0, v.firstRow - t.rowOverscan),
        rowTo = minOf(v.rows.size - 1, v.lastRow + t.rowOverscan + t.tileChannels),
        slabFrom = (slabs.firstOrNull() ?: slabOf(v.from)) - 1,
        slabTo = (slabs.lastOrNull() ?: slabOf(v.to)) + 1,
    )
}

fun planTiles(input: PlanInput): List<TileRequest> {
    val v = input.view
    val t = v.tuning
    val rows = v.rows
    val last = rows.size - 1
    val first = maxOf(0, minOf(v.firstRow, last))
    val lastVis = maxOf(first, minOf(v.lastRow, last))
    if (last < 0 || v.to <= v.from) return emptyList()
    val taken = HashSet<String>(input.covered)
    val ov = t.timeOverscanMin * 60_000L
    val visSlabs = slabRange(v.from, v.to)
    val allSlabs = slabRange(v.from - ov, v.to + ov)
    val ovSlabs = allSlabs.filter { it !in visSlabs }
    fun range(a: Int, b: Int): List<Int> = (maxOf(0, a)..minOf(last, b)).toList()
    val visRows = range(first, lastVis)
    val ovRows = range(first - t.rowOverscan, first - 1) + range(lastVis + 1, lastVis + t.rowOverscan)
    val aheadRows = range(lastVis + t.rowOverscan + 1, lastVis + t.rowOverscan + t.tileChannels)
    val aheadSlab: Long? = when {
        input.dir > 0 -> allSlabs.last() + 1
        input.dir < 0 -> allSlabs.first() - 1
        else -> null
    }
    val tiers: List<List<Pair<List<Int>, List<Long>>>> = listOf(
        listOf(visRows to visSlabs),
        listOf(visRows to ovSlabs, ovRows to visSlabs),
        listOf(visRows to listOfNotNull(aheadSlab), aheadRows to visSlabs),
    )
    val out = ArrayList<TileRequest>()
    tiers.forEachIndexed { priority, parts ->
        val want = HashMap<String, LinkedHashSet<Long>>() // channel → slabs
        val order = ArrayList<Int>()
        for ((rowIdx, slabs) in parts) {
            for (r in rowIdx) {
                val id = rows[r]
                for (k in slabs) {
                    if (!taken.add(coverageKey(id, k))) continue
                    want.getOrPut(id) { order.add(r); LinkedHashSet() }.add(k)
                }
            }
        }
        order.sort()
        out.addAll(batch(order.map { rows[it] to want.getValue(rows[it]) }, t, priority))
    }
    val now = input.now
    if (input.idle && now != null && input.idleIds.isNotEmpty()) {
        val k = slabOf(now)
        val items = ArrayList<Pair<String, Set<Long>>>()
        for (id in input.idleIds) {
            if (!taken.add(coverageKey(id, k))) continue
            items.add(id to setOf(k))
        }
        out.addAll(batch(items, t, 3))
    }
    return out
}

/** Contiguous runs per channel (≤ tileMaxSlabs), then channels sharing a run grouped in order into requests of ≤ tileChannels. */
private fun batch(items: List<Pair<String, Set<Long>>>, t: PlatformTuning, priority: Int): List<TileRequest> {
    class Bucket(val slabs: List<Long>, val ids: MutableList<String>)
    val buckets = LinkedHashMap<String, Bucket>()
    for ((id, set) in items) {
        var run = ArrayList<Long>()
        fun flush() {
            if (run.isEmpty()) return
            val key = "${run.first()}-${run.last()}"
            val b = buckets[key]
            if (b != null) b.ids.add(id) else buckets[key] = Bucket(run, mutableListOf(id))
            run = ArrayList()
        }
        for (k in set.sorted()) {
            if (run.isNotEmpty() && (k != run.last() + 1 || run.size >= t.tileMaxSlabs)) flush()
            run.add(k)
        }
        flush()
    }
    val out = ArrayList<TileRequest>()
    for (b in buckets.values) {
        for (chunk in b.ids.chunked(maxOf(1, t.tileChannels))) {
            out.add(TileRequest(priority, chunk, b.slabs, slabStart(b.slabs.first()), slabEnd(b.slabs.last())))
        }
    }
    return out
}

data class StaleSplit(val keep: List<TileRequest>, val dropped: List<TileRequest>)

/** Queued (unsent) requests whose rows or slabs all left the window plus overscan are dropped. P3 idle requests are never dropped. */
fun dropStale(queued: List<TileRequest>, v: Viewport): StaleSplit {
    val w = planWindow(v)
    val index = HashMap<String, Int>()
    v.rows.forEachIndexed { i, id -> index[id] = i } // the last index of an id wins, as in a Map
    val keep = ArrayList<TileRequest>()
    val dropped = ArrayList<TileRequest>()
    for (q in queued) {
        if (q.priority == 3) {
            keep.add(q)
            continue
        }
        val rowIn = q.channelIds.any { id -> index[id]?.let { it >= w.rowFrom && it <= w.rowTo } == true }
        val slabIn = q.slabs.any { it >= w.slabFrom && it <= w.slabTo }
        (if (rowIn && slabIn) keep else dropped).add(q)
    }
    return StaleSplit(keep, dropped)
}

data class TileIngest(val coverage: List<String>, val byChannel: Map<String, List<ProgramLite>>)

/**
 * What an answer covers: every requested (channel, slab) pair, even when it held nothing for a
 * channel (so a channel without EPG never loops), plus the answer grouped and cleaned per channel.
 */
fun ingestTile(req: TileRequest, programs: List<ProgramLite>): TileIngest {
    val coverage = ArrayList<String>()
    for (id in req.channelIds) for (k in req.slabs) coverage.add(coverageKey(id, k))
    val grouped = LinkedHashMap<String, MutableList<ProgramLite>>()
    for (id in req.channelIds) grouped[id] = ArrayList()
    for (p in programs) grouped[p.channelId]?.add(p)
    val byChannel = LinkedHashMap<String, List<ProgramLite>>()
    for ((id, list) in grouped) byChannel[id] = cleanPrograms(list)
    return TileIngest(coverage, byChannel)
}
