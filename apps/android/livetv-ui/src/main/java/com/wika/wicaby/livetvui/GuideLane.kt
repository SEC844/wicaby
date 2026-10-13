package com.wika.wicaby.livetvui

import android.os.SystemClock
import android.text.format.DateFormat
import android.util.Log
import android.view.Choreographer
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.AnchorMode
import com.wika.wicaby.core.livetv.Badge
import com.wika.wicaby.core.livetv.CellKind
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.FocusKind
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.GuideFocus
import com.wika.wicaby.core.livetv.LiveCaps
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.Mark
import com.wika.wicaby.core.livetv.NavModel
import com.wika.wicaby.core.livetv.PF
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.core.livetv.Tri
import com.wika.wicaby.core.livetv.anchorInit
import com.wika.wicaby.core.livetv.markFor
import com.wika.wicaby.core.livetv.repeatGateInit
import com.wika.wicaby.core.livetv.rowCells
import com.wika.wicaby.core.livetv.slabEnd
import com.wika.wicaby.core.livetv.slabOf
import com.wika.wicaby.core.livetv.slabRange
import com.wika.wicaby.core.livetv.slabStart
import java.util.Date

// The guide grid's drawing core (spec §6.1, §6.2, §21.9), shared by the TV grid (TV-2) and the tablet
// grid (M-4). A row is a channel cell (the app's own) and a lane drawn in one drawBehind. The lane keeps
// its cells as data (a memo refreshed in draw when the 3 h window or the data version changes), draws
// the ones under the shared offset with drawText from one TextMeasurer cache, and reads the focus
// through a per-row derivedStateOf. A move, a scroll or a 30 min bucket crossing recomposes nothing:
// it redraws the lanes.

private const val MIN = 60_000L
private const val HOUR = 3_600_000L
private const val BUCKET_MS = 30 * MIN
private const val MEASURES_PER_FRAME = 8
private const val LIVE_TAG = "WicabyLive"

/** The Graphite tokens the grid draws with; each app passes its own theme's values (§11). */
@Stable
class GuideStyle(
    val bg: Color,
    val label: Color,
    val label2: Color,
    val label3: Color,
    val fill1: Color,
    val fill2: Color,
    val fill3: Color,
    val separator: Color,
    val red: Color,
    val title: TextStyle,
    val caption: TextStyle,
    val radius: Dp,
)

/** Shared guide state: focus, the hoisted offset and the clock. Main thread only. [debug]: §16.3 counters and logs. */
@Stable
class GuideState(val repo: LiveTvRepository, val clock: GuideClock, val pxPerMin: Float, val rangeStart: Long, val debug: Boolean = false) {
    /** GuideInfo.EndDate (fallback now + 7 d). */
    var rangeEnd by mutableLongStateOf(rangeStart + 8 * 24 * HOUR)

    /** px from [rangeStart] to the lane's left edge; every row places its cells from it. */
    val offset = Animatable(0f)
    var focus by mutableStateOf<GuideFocus?>(null)

    /** [focus] once it has held 100 ms: the band and the TalkBack label follow it, so a held D-pad recomposes neither. */
    var shown by mutableStateOf<GuideFocus?>(null)
    var now by mutableLongStateOf(repo.now())

    /** The target left edge (the offset animates towards it). */
    var left = 0L
    var laneMs = 150 * MIN
    var anchor by mutableStateOf(anchorInit(SystemClock.elapsedRealtime()))

    /** Anchor live ("Maintenant" selected); notifies only when the mode flips, not on every input. */
    val live = derivedStateOf { anchor.mode == AnchorMode.LIVE }
    var rowIds: List<String> = emptyList()
    var gate = repeatGateInit()
    var pending: PendingJump? = null

    // §16.3 dev counter (debug builds): lanes recomposed (cells are drawn, never composed).
    var recomposedLanes = 0
    var painted = false
    val openedAt = SystemClock.elapsedRealtime()

    // §16.2: at most MEASURES_PER_FRAME text measures per frame; cells past it (a tile landing in view) draw
    // their titles one frame later instead of stretching this one.
    private var measureFrame = 0L
    private var measuresLeft = 0

    fun takeMeasure(): Boolean {
        val frame = SystemClock.uptimeMillis() / 16
        if (frame != measureFrame) {
            measureFrame = frame
            measuresLeft = MEASURES_PER_FRAME
        }
        return measuresLeft-- > 0
    }

    fun x(t: Long): Float = (t - rangeStart) * pxPerMin / MIN
    fun timeAt(px: Float): Long = rangeStart + (px / pxPerMin * MIN).toLong()
    fun visibleLeft(): Long = timeAt(offset.value)

    /** The 30 min bucket of the visible left edge: a row recomposes only when it changes. */
    val bucket = derivedStateOf { Math.floorDiv(visibleLeft(), BUCKET_MS) }

    fun clampLeft(t: Long): Long = t.coerceIn(rangeStart, maxOf(rangeStart, rangeEnd - laneMs))

    /** Navigation's view of a row: null while a slab of the viewport is not in memory (main-thread safe). */
    fun navPrograms(id: String, l: Long, r: Long): List<ProgramLite>? {
        for (k in slabRange(l, r)) if (repo.cache.unit(id, k, disk = false) == null) return null
        return repo.programs(id, l - 6 * HOUR, r + 6 * HOUR)
    }

    fun model(l: Long = left): NavModel = NavModel(rowIds, { navPrograms(it, l, l + laneMs) }, rangeStart, rangeEnd, l, l + laneMs, now)

    companion object {
        /** Pure (no state read): the lane draws with its row's derived focus. */
        fun matches(f: GuideFocus, c: GCell): Boolean {
            if (f.channelId != c.channelId) return false
            return when (f.kind) {
                FocusKind.PROGRAM -> c.programId != null && c.programId == f.programId
                FocusKind.FILLER -> c.programId == null && (f.start ?: 0) < c.end && c.start < (f.end ?: 0)
                else -> false
            }
        }
    }
}

/** A drawn cell: a programme, or a filler (no EPG, a gap over 10 min, or a failed slab: "Réessayer"). */
data class GCell(val channelId: String, val start: Long, val end: Long, val program: ProgramLite?, val failed: Boolean = false) {
    val programId: String? get() = program?.id

    /** Filled on first use ([prep]), and carried over when the lane refreshes. */
    var sub: String? = null
    var badges: List<String> = emptyList()
    var prepared = false

    /** Its measured lines (first draw or warm-up), so later draws measure nothing. */
    var tl: TextLayoutResult? = null
    var sl: TextLayoutResult? = null

    /** The sub line and badges, once: a lane refresh must not format 20+ dates for cells nobody sees. */
    fun prep(ctx: CellContext) {
        if (prepared) return
        prepared = true
        program?.let { sub = ctx.subLine(it); badges = ctx.badgesOf(it) }
    }
}

class RowCells(val cells: List<GCell>, val missing: List<Pair<Long, Long>>)

/**
 * The cells of a row in [from, to): GuideNav's rowCells over each run of slabs in memory (fillers
 * clipped to the run), and the runs not loaded yet (skeleton, or a "Réessayer" filler after a failure).
 */
fun renderRow(st: GuideState, id: String, from: Long, to: Long): RowCells {
    val repo = st.repo
    val slabs = slabRange(from, to)
    val cells = ArrayList<GCell>()
    val missing = ArrayList<Pair<Long, Long>>()
    // 0 in memory, 1 failed ("Réessayer"), 2 not loaded yet (skeleton).
    fun state(k: Long) = if (repo.cache.unit(id, k, disk = false) != null) 0 else if (repo.rowFailed(id, slabStart(k), slabEnd(k))) 1 else 2
    var i = 0
    while (i < slabs.size) {
        val on = state(slabs[i])
        var j = i
        while (j + 1 < slabs.size && state(slabs[j + 1]) == on) j++
        val rs = maxOf(from, slabStart(slabs[i]))
        val re = minOf(to, slabEnd(slabs[j]))
        when (on) {
            0 -> {
                val list = repo.programs(id, rs, re)
                val m = NavModel(listOf(id), { list }, st.rangeStart, st.rangeEnd, rs, re, st.now)
                for (c in rowCells(m, id, rs, re).orEmpty()) {
                    if (c.kind == CellKind.PROGRAM) {
                        val p = list.firstOrNull { it.id == c.programId } ?: continue
                        if (cells.lastOrNull()?.programId != p.id) cells.add(GCell(id, p.start, p.end, p))
                    } else {
                        cells.add(GCell(id, maxOf(c.start, rs), minOf(c.end, re), null))
                    }
                }
            }
            1 -> cells.add(GCell(id, rs, re, null, failed = true))
            else -> missing.add(rs to re)
        }
        i = j + 1
    }
    return RowCells(cells, missing)
}

/** Everything a cell draws with, built once per guide (the TextMeasurer caches by text and 8 dp width bucket). */
@Stable
class CellContext(
    val tm: TextMeasurer,
    val timeFmt: java.text.DateFormat,
    val style: GuideStyle,
    val noInfo: String,
    val retry: String,
    val episode: String,
    val badgeNames: Map<Badge, String>,
    val badges: List<Badge>,
    val caps: LiveCaps,
    val pad: Float,
    val gap: Float,
    val radius: Float,
    val dot: Float,
    val bell: Float,
    val line: Float,
    val badgeMin: Float,
    val minText: Float,
) {
    /** Lucide `bell` (ISC), 24-unit viewport: the reminder mark (§6.7). */
    val bellPath = PathParser().parsePathString("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0").toPath()

    /**
     * One line, unconstrained: the cache key is the text alone, so the sticky title that shrinks while
     * its cell scrolls past the lane edge stays a cache hit (the caller clips to the space left).
     */
    private val smallCache = HashMap<String, TextLayoutResult>()

    /** Badges and the error glyph: a handful of strings, measured once per guide. */
    fun small(text: String): TextLayoutResult = smallCache.getOrPut(text) { measure(text, style.caption) }

    fun measure(text: String, style: TextStyle): TextLayoutResult =
        tm.measure(text, style, TextOverflow.Clip, softWrap = false, maxLines = 1)

    fun subLine(p: ProgramLite): String {
        val se = if (p.season != null && p.episode != null) String.format(episode, p.season, p.episode) else null
        return listOfNotNull(se, p.episodeTitle?.takeIf { it.isNotEmpty() }).joinToString(" · ").ifEmpty { timeFmt.format(Date(p.start)) }
    }

    /** §6.7 badges, switched on in lt.badges; "HD" is the only literal acronym. */
    fun badgesOf(p: ProgramLite): List<String> {
        val out = ArrayList<String>(2)
        fun add(b: Badge, on: Boolean) {
            if (on && b in badges) badgeNames[b]?.let(out::add)
        }
        add(Badge.LIVE, p.flags and PF.LIVE != 0)
        add(Badge.NEW, caps.newFlag && p.flags and PF.NEW != 0)
        add(Badge.PREMIERE, p.flags and PF.PREMIERE != 0)
        add(Badge.REPEAT, p.flags and PF.REPEAT != 0)
        add(Badge.HD, caps.hdFlag != Tri.FALSE && p.flags and PF.HD != 0)
        if (Badge.RATING in badges && !p.rating.isNullOrEmpty()) out.add(p.rating!!)
        return out
    }
}

@Composable
fun rememberCellContext(badges: List<Badge>, caps: LiveCaps, style: GuideStyle): CellContext {
    val context = LocalContext.current
    val d = LocalDensity.current
    val tm = rememberTextMeasurer(cacheSize = 256)
    val noInfo = stringResource(com.wika.wicaby.core.R.string.livetv_guide_no_info)
    val retry = stringResource(com.wika.wicaby.core.R.string.livetv_guide_retry)
    val episode = stringResource(R.string.livetv_guide_episode)
    val names = mapOf(
        Badge.LIVE to stringResource(R.string.livetv_badges_live),
        Badge.NEW to stringResource(R.string.livetv_badges_new),
        Badge.PREMIERE to stringResource(R.string.livetv_badges_premiere),
        Badge.REPEAT to stringResource(R.string.livetv_badges_repeat),
        Badge.HD to "HD",
    )
    return remember(tm, badges, caps, noInfo, d, style) {
        with(d) {
            CellContext(
                tm, DateFormat.getTimeFormat(context), style,
                noInfo, retry, episode, names, badges, caps,
                pad = 10.dp.toPx(), gap = 3.dp.toPx(), radius = style.radius.toPx(),
                dot = 7.dp.toPx(), bell = 12.dp.toPx(), line = 2.dp.toPx(), badgeMin = 180.dp.toPx(), minText = 12.dp.toPx(),
            )
        }
    }
}

/** A lane's cells, refreshed in draw (never in composition) when the 3 h window, the data or the context changes. */
private class LaneMemo {
    var win = Long.MIN_VALUE
    var version = -1L
    var rangeEnd = 0L
    var laneMs = 0L
    var ctx: CellContext? = null
    var rc = RowCells(emptyList(), emptyList())

    /** Slab-aligned window [left − 3 h, left + lane + 3 h]: rebuilt once per 3 h of scrolling or per data landing. */
    fun refresh(st: GuideState, id: String, from: Long, version: Long, ctx: CellContext): RowCells {
        val w = slabOf(from)
        if (w != win || version != this.version || st.rangeEnd != rangeEnd || st.laneMs != laneMs || ctx !== this.ctx) {
            val r = renderRow(st, id, slabStart(w - 1), slabEnd(slabOf(from + st.laneMs) + 1))
            if (ctx === this.ctx) {
                // Data landing rebuilds the lane: keep what the old cells already prepared and measured.
                val old = rc.cells.associateBy { it.program }
                for (c in r.cells) old[c.program ?: continue]?.let { o -> c.sub = o.sub; c.badges = o.badges; c.prepared = o.prepared; c.tl = o.tl; c.sl = o.sl }
            }
            win = w; this.version = version; rangeEnd = st.rangeEnd; laneMs = st.laneMs; this.ctx = ctx; rc = r
        }
        return rc
    }
}

/** One row's programmes, drawn under [GuideState.offset]; the focused cell (if any) is inverted. */
@Composable
fun Lane(st: GuideState, row: ChannelRow, versionState: State<Long>, marks: Map<String, TimerLite>, reminders: Set<String>, ctx: CellContext, modifier: Modifier) {
    val memo = remember(row.id) { LaneMemo() }
    // Notifies this lane only when the focus enters, moves within or leaves it.
    val redraw = remember(row.id) { mutableIntStateOf(0) }
    val rowFocus = remember(row.id) { derivedStateOf { st.focus?.takeIf { it.channelId == row.id && it.kind != FocusKind.CHANNEL } } }
    if (st.debug) SideEffect { st.recomposedLanes++ }
    val overlay = marks.takeIf { it.isNotEmpty() } // empty = timers not loaded yet: the programme payload decides
    val c0 = ctx.style.fill1
    Spacer(
        modifier
            .layout { m, c ->
                // Runs when the row is (pre)measured, so LazyColumn prefetch builds the cells and warms the text
                // cache before the row scrolls in (a held Down then draws from cache). Unobserved reads: scrolling
                // or data landing must not remeasure the rows.
                Snapshot.withoutReadObservation {
                    val from = st.timeAt(st.offset.value)
                    val to = from + (c.maxWidth / st.pxPerMin * MIN).toLong()
                    for (cell in memo.refresh(st, row.id, from, versionState.value, ctx).cells) {
                        if (cell.end > from && cell.start < to) lines(cell, ctx)
                    }
                }
                val p = m.measure(c)
                layout(p.width, p.height) { p.place(0, 0) }
            }
            .clipToBounds()
            .drawBehind {
                val off = st.offset.value
                val from = st.timeAt(off)
                val to = st.timeAt(off + size.width)
                // Draw reads: data landing or a 3 h window change redraws the lane, never recomposes it.
                val rc = memo.refresh(st, row.id, from, versionState.value, ctx)
                for ((s, e) in rc.missing) {
                    if (e <= from || s >= to) continue
                    drawRoundRect(c0, topLeft = Offset(st.x(s) - off, 0f), size = Size(st.x(e) - st.x(s) - ctx.gap, size.height), cornerRadius = CornerRadius(ctx.radius))
                }
                val f = rowFocus.value
                redraw.intValue // a draw read: the frame callback below redraws the lane
                var late = false
                for (c in rc.cells) {
                    if (c.end <= from || c.start >= to) continue
                    val p = c.program
                    c.prep(ctx)
                    val x = st.x(c.start) - off
                    translate(left = x) {
                        late = drawCell(st, c, x, st.x(c.end) - st.x(c.start), f != null && GuideState.matches(f, c), p?.let { markFor(it, overlay) }, p != null && p.id in reminders, ctx) || late
                    }
                }
                if (late) Choreographer.getInstance().postFrameCallback { redraw.intValue++ }
                // Warm the next cells on both sides, two per draw, so a held Left/Right draws entering cells from cache.
                var budget = 2
                for (c in rc.cells) {
                    if (budget == 0) break
                    if (c.tl == null && c.end > from - WARM_AHEAD_MS && c.start < to + WARM_AHEAD_MS) {
                        if (!lines(c, ctx, st)) break
                        budget--
                    }
                }
                if (st.debug && !st.painted && rc.cells.isNotEmpty()) {
                    st.painted = true // §16.3: first row drawn with cells, since the guide opened
                    Log.d(LIVE_TAG, "guide first paint ${SystemClock.elapsedRealtime() - st.openedAt} ms")
                }
            },
    )
}

private const val WARM_AHEAD_MS = 60 * MIN

/** Measures a cell's lines once and keeps them on the cell; false when this frame's budget is spent ([st] given). */
private fun lines(c: GCell, ctx: CellContext, st: GuideState? = null): Boolean {
    if (c.tl != null) return true
    if (st != null && !st.takeMeasure()) return false
    c.prep(ctx)
    c.tl = ctx.measure(c.program?.title ?: if (c.failed) ctx.retry else ctx.noInfo, ctx.style.title)
    c.sl = c.sub?.let { ctx.measure(it, ctx.style.caption) }
    return true
}

/** One cell at the origin, [cellX] px from the lane edge (the title sticks to that edge, §6.1). True: its text waits for the next frame. */
private fun DrawScope.drawCell(st: GuideState, c: GCell, cellX: Float, cellW: Float, focused: Boolean, mark: Mark?, reminder: Boolean, ctx: CellContext): Boolean {
    val s = ctx.style
    val w = cellW - ctx.gap
    val h = size.height
    if (w <= 1f) return false
    val now = st.now
    val p = c.program
    val airing = p != null && p.start <= now && now < p.end
    val past = p != null && p.end <= now
    // §11: inverted focus; airing fill-2; everything else fill-1. No accent, no genre colour.
    drawRoundRect(if (focused) s.label else if (airing) s.fill2 else s.fill1, size = Size(w, h), cornerRadius = CornerRadius(ctx.radius))
    if (mark == Mark.RECORDING) {
        val sw = ctx.line / 2
        drawRoundRect(s.red, topLeft = Offset(sw, sw), size = Size(w - ctx.line, h - ctx.line), cornerRadius = CornerRadius(ctx.radius), style = Stroke(ctx.line / 2))
    }
    if (airing) {
        val f = ((now - p.start).toFloat() / (p.end - p.start)).coerceIn(0f, 1f)
        drawRect((if (focused) s.bg else s.label).copy(alpha = 0.6f), topLeft = Offset(0f, h - ctx.line), size = Size(w * f, ctx.line))
    }
    val left = maxOf(0f, -cellX) + ctx.pad
    var right = w - ctx.pad
    val cy = h / 2
    if (mark != null && mark != Mark.RULE_SKIP) {
        val r = ctx.dot / 2
        val cx = right - r
        when (mark) {
            Mark.ERROR -> {
                val t = ctx.small("!")
                drawText(t, color = if (focused) s.bg else s.label2, topLeft = Offset(cx - t.size.width / 2f, cy - t.size.height / 2f))
            }
            Mark.CONFLICT_WONT -> {
                drawCircle(s.label3, r, Offset(cx, cy))
                drawLine(if (focused) s.bg else s.label2, Offset(cx - r - 2, cy + r + 2), Offset(cx + r + 2, cy - r - 2), strokeWidth = ctx.line / 2)
            }
            else -> drawCircle(s.red, r, Offset(cx, cy))
        }
        if (mark == Mark.SERIES) drawCircle(s.red, r + ctx.line * 1.2f, Offset(cx, cy), style = Stroke(ctx.line * 0.75f))
        right -= ctx.dot + ctx.pad
    }
    if (reminder) {
        val b = ctx.bell
        translate(right - b, cy - b / 2) {
            scale(b / 24f, b / 24f, pivot = Offset.Zero) {
                drawPath(ctx.bellPath, if (focused) s.bg else s.label2, style = Stroke(2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
        right -= b + ctx.pad
    }
    // Badges drop from the right when the visible part of the cell is narrow (§6.1).
    val badges = c.badges
    if (badges.isNotEmpty() && w - maxOf(0f, -cellX) >= ctx.badgeMin) {
        for (b in badges.asReversed()) {
            val t = ctx.small(b)
            val bw = t.size.width + ctx.pad
            if (right - bw - left < ctx.badgeMin / 2) break
            val top = cy - t.size.height / 2f - 2
            drawRoundRect(if (focused) s.bg.copy(alpha = 0.12f) else s.fill3, topLeft = Offset(right - bw, top), size = Size(bw, t.size.height + 4f), cornerRadius = CornerRadius(ctx.radius))
            drawText(t, color = if (focused) s.bg else s.label2, topLeft = Offset(right - bw + ctx.pad / 2, top + 2))
            right -= bw + ctx.pad / 2
        }
    }
    if (right - left < ctx.minText) return false // under the minimum: marks only; the title goes to the band and the label
    if (!lines(c, ctx, st)) return true
    val tl = c.tl ?: return false
    val sl = c.sl
    // §21.7: at the height clamp, line 2 drops before line 1 clips.
    val two = sl != null && tl.size.height + sl.size.height + ctx.line * 2 <= h
    val y = (h - tl.size.height - (if (two) sl.size.height else 0)) / 2f
    val main = when {
        focused -> s.bg
        p == null -> s.label3
        past -> s.label2 // §21.7: past titles keep 4.5:1, the "past" cue is the missing progress line
        else -> s.label
    }
    clipRect(left, 0f, right, h) {
        drawText(tl, color = main, topLeft = Offset(left, y))
        if (two) drawText(sl, color = if (focused) s.bg.copy(alpha = 0.7f) else s.label2, topLeft = Offset(left, y + tl.size.height))
    }
    return false
}

/**
 * Ruler: ticks every 30 min drawn from the offset (no recomposition while scrolling); the corner, [channelCol]
 * wide, shows [dayLabel] of the left edge and recomposes when the day changes, not on every bucket crossing.
 */
@Composable
fun Ruler(st: GuideState, style: GuideStyle, channelCol: Dp, dayLabel: (Long) -> String, modifier: Modifier) {
    val context = LocalContext.current
    val tm = rememberTextMeasurer(cacheSize = 64)
    val fmt = remember(context) { DateFormat.getTimeFormat(context) }
    val tick = with(LocalDensity.current) { 6.dp.toPx() }
    val day by remember(st, dayLabel) { derivedStateOf { dayLabel(st.bucket.value * BUCKET_MS) } }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(channelCol).padding(start = 10.dp)) {
            BasicText(day, style = style.caption.copy(color = style.label2), maxLines = 1)
        }
        Canvas(Modifier.fillMaxSize().clipToBounds()) {
            val off = st.offset.value
            var t = Math.floorDiv(st.timeAt(off), BUCKET_MS) * BUCKET_MS
            while (st.x(t) - off < size.width) {
                val x = st.x(t) - off
                drawLine(style.separator, Offset(x, size.height * 0.45f), Offset(x, size.height), strokeWidth = 1f)
                val tl = tm.measure(fmt.format(Date(t)), style.caption, TextOverflow.Clip, softWrap = false, maxLines = 1)
                drawText(tl, color = style.label2, topLeft = Offset(x + tick, (size.height - tl.size.height) / 2f))
                t += BUCKET_MS
            }
        }
    }
}

/** The now line: reads the clock and the offset in graphicsLayer, so the tick recomposes nothing. */
@Composable
fun NowLine(st: GuideState, color: Color, modifier: Modifier) {
    Box(modifier.fillMaxSize().clipToBounds()) {
        Spacer(
            Modifier.width(2.dp).fillMaxHeight()
                .graphicsLayer {
                    translationX = st.x(st.now) - st.offset.value // the parent clips it outside the lane
                }
                .background(color.copy(alpha = 0.9f)),
        )
    }
}
