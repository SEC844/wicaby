package com.wika.wicaby.core.livetv

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

// Live TV guide navigation on the data model (spec §6.9, §21.6): cells with gap fillers, the D-pad
// moves with focusT, restore by identity after a reload, the pending jump and key-repeat coalescing.
// The TV grid (TV-2) calls it and never re-implements it. Mirrors D/shared/livetv/nav.ts (golden
// vectors: guide-nav.json).

const val MINUTE_MS = 60_000L

/** A gap over 10 min becomes a focusable filler. */
const val GAP_FILLER_MS = 10 * MINUTE_MS
const val SCROLL_BACK_MS = 30 * MINUTE_MS

@Serializable
enum class CellKind {
    @SerialName("program") PROGRAM,
    @SerialName("filler") FILLER,
}

@Serializable
data class Cell(val kind: CellKind, val channelId: String, val start: Long, val end: Long, val programId: String? = null)

@Serializable
enum class FocusKind {
    @SerialName("channel") CHANNEL,
    @SerialName("program") PROGRAM,
    @SerialName("filler") FILLER,
    @SerialName("loading") LOADING,
}

@Serializable
data class GuideFocus(
    val kind: FocusKind,
    val channelId: String,
    /** Kept by vertical moves, reset by horizontal ones. */
    val focusT: Long,
    val programId: String? = null,
    val start: Long? = null,
    val end: Long? = null,
)

/**
 * The guide as navigation sees it. [programs] returns null while that row's slabs around the
 * viewport are not loaded, an empty list when the channel has no EPG there. Gaps inside the returned
 * list (and before its first programme, back to [rangeStart]) read as "no programme information"
 * fillers, so return null rather than a list with unloaded holes. Lists are clean (cleanPrograms).
 */
data class NavModel(
    /** Channel ids in lens order. */
    val rows: List<String>,
    val programs: (String) -> List<ProgramLite>?,
    /** Canvas: start of today (local). */
    val rangeStart: Long,
    /** GuideInfo.EndDate. */
    val rangeEnd: Long,
    /** Viewport time span. */
    val left: Long,
    val right: Long,
    val now: Long,
)

@Serializable
enum class NavMove {
    @SerialName("left") LEFT,
    @SerialName("right") RIGHT,
    @SerialName("up") UP,
    @SerialName("down") DOWN,
    @SerialName("page-up") PAGE_UP,
    @SerialName("page-down") PAGE_DOWN,
    @SerialName("first") FIRST,
    @SerialName("last") LAST,
}

@Serializable
enum class NavExit {
    /** Channel column → sidebar. */
    @SerialName("left") LEFT,

    /** Row 0 → day strip. */
    @SerialName("up") UP,
}

@Serializable
data class NavResult(
    /** null when focus leaves the grid. */
    val focus: GuideFocus?,
    val exit: NavExit? = null,
    /** New viewport left time, when the viewport must move. */
    val scrollLeft: Long? = null,
    /** The row to scroll into view. */
    val rowIndex: Int? = null,
)

/**
 * Cells of one row inside [from, to): programmes plus fillers for gaps over 10 min. Filler bounds come
 * from the neighbouring programmes (or the canvas), so they are stable while scrolling. A row with no
 * EPG is one filler per window. null = not loaded.
 */
fun rowCells(m: NavModel, channelId: String, from: Long, to: Long): List<Cell>? {
    val list = m.programs(channelId) ?: return null
    if (list.isEmpty()) return listOf(Cell(CellKind.FILLER, channelId, from, to))
    val out = ArrayList<Cell>()
    val i0 = firstEndingAfter(list, from)
    var cursor = if (i0 > 0) list[i0 - 1].end else minOf(m.rangeStart, list[0].start)
    var programCells = 0
    for (p in programsInWindow(list, from, to)) {
        if (p.start - cursor > GAP_FILLER_MS) out.add(Cell(CellKind.FILLER, channelId, cursor, p.start))
        out.add(Cell(CellKind.PROGRAM, channelId, p.start, p.end, p.id))
        programCells++
        cursor = maxOf(cursor, p.end)
    }
    val next = list.getOrNull(i0 + programCells)
    val tail = next?.start ?: maxOf(m.rangeEnd, cursor)
    if (cursor < to && tail - cursor > GAP_FILLER_MS) out.add(Cell(CellKind.FILLER, channelId, cursor, tail))
    return out.filter { it.end > from && it.start < to }
}

private fun focusOf(c: Cell, focusT: Long): GuideFocus =
    if (c.kind == CellKind.PROGRAM) {
        GuideFocus(FocusKind.PROGRAM, c.channelId, focusT, c.programId, c.start, c.end)
    } else {
        GuideFocus(FocusKind.FILLER, c.channelId, focusT, null, c.start, c.end)
    }

/** Cells around t on a row, wide enough for a neighbour lookup (one viewport on each side). A row with no EPG is one filler over the viewport. */
private fun cellsAround(m: NavModel, channelId: String, t: Long): List<Cell>? {
    val list = m.programs(channelId) ?: return null
    if (list.isEmpty()) return listOf(Cell(CellKind.FILLER, channelId, m.left, m.right))
    val span = maxOf(m.right - m.left, MINUTE_MS)
    return rowCells(m, channelId, minOf(t, m.left) - span, maxOf(t, m.right) + span)
}

/** The cell airing at t, else the nearest one, else null. */
private fun cellAt(cells: List<Cell>, t: Long): Cell? {
    var best: Cell? = null
    var bestD = Long.MAX_VALUE
    for (c in cells) {
        if (c.start <= t && t < c.end) return c
        val d = if (t < c.start) c.start - t else t - c.end + 1
        if (d < bestD) {
            best = c
            bestD = d
        }
    }
    return best
}

private fun sameCell(c: Cell, f: GuideFocus): Boolean =
    if (f.kind == FocusKind.PROGRAM) c.programId == f.programId else c.kind == CellKind.FILLER && c.start == f.start

/** focusT after a horizontal move: max(cell.start, viewport left + 1 min). */
private fun focusTFor(c: Cell, left: Long): Long = maxOf(c.start, left + MINUTE_MS)

private fun onRow(m: NavModel, row: Int, focusT: Long): GuideFocus {
    val id = m.rows[row]
    val cells = cellsAround(m, id, focusT) ?: return GuideFocus(FocusKind.LOADING, id, focusT)
    val c = cellAt(cells, focusT)
    return if (c != null) focusOf(c, focusT) else GuideFocus(FocusKind.CHANNEL, id, focusT)
}

/** Moves the viewport so [c] shows its start (or as much as fits). */
private fun reveal(m: NavModel, c: Cell): Long? {
    if (c.start >= m.left && c.start < m.right) return null
    if (c.start < m.left && c.end > m.left) return null // already partly visible from the left edge
    return maxOf(m.rangeStart, c.start)
}

fun navMove(m: NavModel, f: GuideFocus, move: NavMove, pageRows: Int = 1): NavResult {
    val row = m.rows.indexOf(f.channelId)
    if (row < 0) return NavResult(f)
    when (move) {
        NavMove.UP, NavMove.DOWN, NavMove.PAGE_UP, NavMove.PAGE_DOWN, NavMove.FIRST, NavMove.LAST -> {
            val step = when (move) {
                NavMove.UP -> -1
                NavMove.DOWN -> 1
                NavMove.PAGE_UP -> -pageRows
                NavMove.PAGE_DOWN -> pageRows
                else -> 0
            }
            if (move == NavMove.UP && row == 0) return NavResult(null, exit = NavExit.UP)
            val target = when (move) {
                NavMove.FIRST -> 0
                NavMove.LAST -> m.rows.size - 1
                else -> maxOf(0, minOf(m.rows.size - 1, row + step))
            }
            if (target == row && move != NavMove.FIRST && move != NavMove.LAST) return NavResult(f)
            if (f.kind == FocusKind.CHANNEL) return NavResult(GuideFocus(FocusKind.CHANNEL, m.rows[target], f.focusT), rowIndex = target)
            return NavResult(onRow(m, target, f.focusT), rowIndex = target)
        }
        NavMove.RIGHT -> {
            val nowInView = m.now >= m.left && m.now < m.right
            val fromChannel = f.kind == FocusKind.CHANNEL || f.kind == FocusKind.LOADING
            val edge = if (nowInView) m.now else m.left + MINUTE_MS
            val cells = cellsAround(m, f.channelId, if (fromChannel) edge else f.end ?: f.focusT) ?: return NavResult(f)
            val next: Cell? = if (fromChannel) {
                // The airing programme, else the first future one. When the view is away from now
                // (another day or time), the cell at the left edge instead, so the view never jumps.
                cells.firstOrNull { it.start <= edge && edge < it.end } ?: cells.firstOrNull { it.start > edge }
            } else {
                val i = cells.indexOfFirst { sameCell(it, f) }
                if (i >= 0) cells.getOrNull(i + 1) else cells.firstOrNull { it.start >= (f.end ?: f.focusT) }
            }
            if (next == null) return NavResult(f)
            val scrollLeft = reveal(m, next)
            return NavResult(focusOf(next, focusTFor(next, scrollLeft ?: m.left)), scrollLeft = scrollLeft)
        }
        NavMove.LEFT -> {
            if (f.kind == FocusKind.CHANNEL) return NavResult(null, exit = NavExit.LEFT)
            val toChannel = NavResult(GuideFocus(FocusKind.CHANNEL, f.channelId, f.focusT))
            val cells = cellsAround(m, f.channelId, f.start ?: f.focusT) ?: return toChannel
            val i = cells.indexOfFirst { sameCell(it, f) }
            val cur = if (i >= 0) cells[i] else null
            val prev = if (i > 0) cells[i - 1] else null
            val curStart = cur?.start ?: f.focusT
            if (curStart <= m.left) {
                // First visible cell: scroll 30 min back while earlier programmes exist.
                val earlier = prev != null || (curStart > m.rangeStart && m.left > m.rangeStart)
                if (!earlier) return toChannel
                val newLeft = maxOf(m.rangeStart, m.left - SCROLL_BACK_MS)
                val c = cellAt(cells, newLeft + MINUTE_MS)
                return NavResult(if (c != null) focusOf(c, focusTFor(c, newLeft)) else f, scrollLeft = newLeft)
            }
            if (prev == null) return toChannel
            val scrollLeft = if (prev.start < m.left) {
                maxOf(m.rangeStart, if (prev.start >= m.left - SCROLL_BACK_MS) prev.start else m.left - SCROLL_BACK_MS)
            } else {
                null
            }
            return NavResult(focusOf(prev, focusTFor(prev, scrollLeft ?: m.left)), scrollLeft = scrollLeft)
        }
    }
}

/**
 * After a reload (lens, data or tiles): the same programme, else the cell at focusT on the same
 * channel, else the row that now sits at the old index. The grid is never unmounted for this.
 */
fun restoreFocus(m: NavModel, f: GuideFocus, oldRowIndex: Int): GuideFocus? {
    if (m.rows.isEmpty()) return null
    var row = m.rows.indexOf(f.channelId)
    if (row < 0) row = maxOf(0, minOf(m.rows.size - 1, oldRowIndex))
    val id = m.rows[row]
    if (f.kind == FocusKind.CHANNEL) return GuideFocus(FocusKind.CHANNEL, id, f.focusT)
    if (id == f.channelId && !f.programId.isNullOrEmpty()) {
        val p = m.programs(id)?.firstOrNull { it.id == f.programId }
        if (p != null) return GuideFocus(FocusKind.PROGRAM, id, f.focusT, p.id, p.start, p.end)
    }
    return onRow(m, row, f.focusT)
}

// ---- Pending jump (search, deep link, "Voir dans le guide") ----

@Serializable
data class PendingJump(val channelId: String, val time: Long, val programId: String? = null)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("status")
sealed interface JumpStep {
    /** Channels or the target row's programmes are not loaded: keep it and replay. */
    @Serializable @SerialName("wait") data object Wait : JumpStep

    /** The channel is outside the lens: switch to Toutes, then replay. */
    @Serializable @SerialName("switch-lens") data object SwitchLens : JumpStep
    @Serializable @SerialName("done") data class Done(val focus: GuideFocus, val rowIndex: Int, val scrollLeft: Long) : JumpStep
}

/**
 * [channelsLoaded]: the lineup is in. [allRows]: the whole lineup (to tell "outside the lens" from
 * "unknown channel"); an unknown channel ends the jump on the first row.
 */
fun resolveJump(m: NavModel, j: PendingJump, channelsLoaded: Boolean, allRows: Collection<String>): JumpStep {
    if (!channelsLoaded) return JumpStep.Wait
    val row = m.rows.indexOf(j.channelId)
    if (row < 0) {
        if (j.channelId in allRows) return JumpStep.SwitchLens
        return JumpStep.Done(GuideFocus(FocusKind.CHANNEL, m.rows.firstOrNull() ?: j.channelId, j.time), 0, j.time - 30 * MINUTE_MS)
    }
    val list = m.programs(j.channelId) ?: return JumpStep.Wait
    val p = if (!j.programId.isNullOrEmpty()) list.firstOrNull { it.id == j.programId } else null
    val t = p?.start ?: j.time
    val scrollLeft = maxOf(m.rangeStart, t - 30 * MINUTE_MS)
    if (p != null) {
        return JumpStep.Done(GuideFocus(FocusKind.PROGRAM, j.channelId, maxOf(p.start, scrollLeft + MINUTE_MS), p.id, p.start, p.end), row, scrollLeft)
    }
    val view = m.copy(left = scrollLeft, right = scrollLeft + (m.right - m.left))
    return JumpStep.Done(onRow(view, row, t), row, scrollLeft)
}

// ---- Key-repeat coalescing: at most one repeated move per frame ----

data class RepeatGate(val lastFrame: Long)

fun repeatGateInit(): RepeatGate = RepeatGate(-1)

data class GateStep(val gate: RepeatGate, val accept: Boolean)

/** A first press always passes; a repeat passes only on a frame that has not moved yet. */
fun gateMove(g: RepeatGate, frame: Long, repeat: Boolean): GateStep {
    if (repeat && frame <= g.lastFrame) return GateStep(g, false)
    return GateStep(RepeatGate(maxOf(g.lastFrame, frame)), true)
}
