package com.wika.wicaby.tv.ui.livetv

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent as AKey
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.focused
import androidx.compose.ui.semantics.requestFocus
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.AnchorEvent
import com.wika.wicaby.core.livetv.AnchorMode
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.ChannelsLoad
import com.wika.wicaby.core.livetv.Daypart
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.FocusKind
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.GuideFocus
import com.wika.wicaby.core.livetv.JumpStep
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.NavExit
import com.wika.wicaby.core.livetv.NavMove
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.core.livetv.TV_PAGE_MS
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.core.livetv.anchorReduce
import com.wika.wicaby.core.livetv.gateMove
import com.wika.wicaby.core.livetv.leftForNow
import com.wika.wicaby.core.livetv.navMove
import com.wika.wicaby.core.livetv.parseServerDate
import com.wika.wicaby.core.livetv.resolveJump
import com.wika.wicaby.core.livetv.restoreFocus
import com.wika.wicaby.core.livetv.stepLens
import com.wika.wicaby.livetvui.CellContext
import com.wika.wicaby.livetvui.GuideState
import com.wika.wicaby.livetvui.NowLine
import com.wika.wicaby.livetvui.rememberCellContext
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.TimeZone

// The TV guide grid (spec §6.1, §6.2, §6.9, §10.2, §16.2, §21.7, TV-2), written for a low-RAM 32-bit TV:
// one LazyColumn of rows (no nested LazyRow), one hoisted horizontal offset shared by every row,
// one focusable node for the whole grid (focus is state, moves run GuideNav.kt on the data model),
// cells drawn with drawBehind + a cached TextMeasurer (GuideRow.kt), the now line in graphicsLayer.

private const val MIN = 60_000L
private const val HOUR = 3_600_000L

internal object GuideDims {
    val channelCol = 200.dp
    val ruler = 32.dp
    val band = 150.dp
    val header = 44.dp
    const val DP_PER_MIN = 4.4f
    val side = 48.dp
    val safeTop = 27.dp
}

@Composable
fun GuideGrid(
    api: Api,
    repo: LiveTvRepository,
    onEnter: () -> Unit,
    modifier: Modifier = Modifier,
    jumpTo: String? = null,
    onJumped: () -> Unit = {},
    /** TP-12: the library search's programme pick (channel, start, programme), as [jumpTo] for a time. */
    jumpAt: PendingJump? = null,
    /** Picture-in-guide (TV-5, §8.7): the player tunes in place, and the band keeps a 16:9 hole for its video at [onSlot]'s bounds (root px). */
    onTune: ((String) -> Unit)? = null,
    onSlot: ((Rect) -> Unit)? = null,
) {
    val context = LocalContext.current
    val res = LocalResources.current
    val density = LocalDensity.current
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val st = remember(repo) {
        val clock = GuideClock(TimeZone.getDefault())
        GuideState(repo, clock, with(density) { GuideDims.DP_PER_MIN.dp.toPx() }, clock.dayStart(repo.now()), BuildConfig.DEBUG)
    }
    val rows by repo.rows.collectAsState()
    val channels by repo.channels.collectAsState()
    val load by repo.channelsLoad.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val lenses by repo.lenses.collectAsState()
    // Read in the lanes' draw and in one effect, never here: a tile landing must not recompose the guide.
    val version = repo.guideVersion.collectAsState()
    val overlayMarks by repo.overlay.collectAsState()
    val caps by repo.caps.collectAsState()
    val reminders by remember(context) { Reminders.all(context) }.collectAsState(emptyList())
    val reminderIds = remember(reminders) { reminders.filter { it.serverId == repo.api.serverId && it.userId == repo.api.userId }.mapTo(HashSet()) { it.programId } }
    val byId = remember(channels) { channels.associateBy { it.id } }
    st.rowIds = remember(rows) { rows.map { it.id } }

    val listState = rememberLazyListState()
    val gridReq = remember { FocusRequester() }
    val dayReq = remember { FocusRequester() }
    var gridFocused by remember { mutableStateOf(false) }
    val jump = remember(repo) { NumberJumpState() }
    val ctx = rememberCellContext(prefs.badges, caps, tvGuideStyle())

    // GuideInfo.EndDate bounds the canvas (fallback now + 7 d).
    LaunchedEffect(repo) {
        val end = try {
            parseServerDate((repo.api.json(Dialect.guideInfo(repo.api.kind)) as? JsonObject)?.get("EndDate"))
        } catch (_: LiveApiException) {
            null
        }
        st.rangeEnd = if (end != null && end > st.now) end else st.now + 7 * 24 * HOUR
    }

    BoxWithConstraints(modifier.fillMaxWidth()) {
        val lanePx = with(density) { (maxWidth - GuideDims.side * 2 - GuideDims.channelCol).toPx() }
        st.laneMs = (lanePx / st.pxPerMin * MIN).toLong()
        // §21.7 font scale: max(60 dp, 2 lines × lineHeight × fontScale + 12 dp), clamped to 84 dp.
        val rowH = with(density) { (Type.callout.lineHeight.toDp() * 2 + 12.dp) }.coerceIn(60.dp, 84.dp)
        val rowPx = with(density) { rowH.toPx() }

        fun scrollTo(t: Long, snap: Boolean) {
            val l = st.clampLeft(t)
            st.left = l
            val target = st.x(l)
            scope.launch {
                st.offset.updateBounds(0f, maxOf(0f, st.x(st.rangeEnd) - lanePx))
                if (snap) st.offset.snapTo(target) else st.offset.animateTo(target, tween(220))
            }
        }

        fun visibleRows(): Int = maxOf(1, (listState.layoutInfo.viewportSize.height / rowPx).toInt())

        /** Scrolls the rows by a delta (not scrollToItem): the list then prefetches the next row between repeats. */
        fun revealRow(i: Int, snap: Boolean) {
            val info = listState.layoutInfo
            val items = info.visibleItemsInfo
            if (items.isEmpty()) return
            val first = items.first()
            val last = items.last()
            val end = info.viewportEndOffset
            val delta = when {
                i < first.index -> first.offset - (first.index - i) * rowPx
                i > last.index -> last.offset + last.size - end + (i - last.index) * rowPx
                else -> items.first { it.index == i }.let { if (it.offset < 0) it.offset.toFloat() else maxOf(0f, (it.offset + it.size - end).toFloat()) }
            }
            if (delta == 0f) return
            scope.launch { if (snap) listState.scrollBy(delta) else listState.animateScrollBy(delta, tween(160)) }
        }

        fun refocus(t: Long) {
            val f = st.focus ?: return
            val idx = st.rowIds.indexOf(f.channelId)
            st.focus = restoreFocus(st.model(), GuideFocus(FocusKind.LOADING, f.channelId, t), idx)
        }

        /** A jump, a day or daypart pick, Maintenant, a page: anchor first, then the view. */
        fun pick(ev: AnchorEvent, l: Long, snap: Boolean = false) {
            st.anchor = anchorReduce(st.anchor, ev).state
            scrollTo(l, snap)
            refocus(maxOf(st.left + MIN, if (st.anchor.mode == AnchorMode.LIVE) st.now else st.left + MIN))
        }

        fun goNow() = pick(AnchorEvent.Now(SystemClock.elapsedRealtime()), leftForNow(st.now, st.laneMs))

        fun runJump(j: PendingJump) {
            // Resolve against the target view, and move there while it loads: the planner then fetches its tiles.
            val target = st.clampLeft(j.time - 30 * MIN)
            when (val step = resolveJump(st.model(target), j, load == ChannelsLoad.READY || channels.isNotEmpty(), byId.keys)) {
                JumpStep.Wait -> {
                    st.pending = j
                    val row = st.rowIds.indexOf(j.channelId)
                    if (row >= 0 && st.focus?.let { it.kind == FocusKind.LOADING && it.channelId == j.channelId } != true) {
                        scrollTo(target, snap = true)
                        scope.launch { listState.scrollToItem(maxOf(0, row - 1)) }
                        st.focus = GuideFocus(FocusKind.LOADING, j.channelId, maxOf(j.time, target + MIN))
                    }
                }
                JumpStep.SwitchLens -> {
                    st.pending = j
                    repo.prefs.update(PrefField.LENS, prefs.copy(lens = LensRef.All))
                }
                is JumpStep.Done -> {
                    st.pending = null
                    st.anchor = anchorReduce(st.anchor, AnchorEvent.Pick(SystemClock.elapsedRealtime())).state
                    scrollTo(step.scrollLeft, snap = true)
                    scope.launch { listState.scrollToItem(maxOf(0, step.rowIndex - 1)) }
                    st.focus = step.focus
                    // The target row may not be loaded yet at the new time: resolve again once it lands.
                    if (step.focus.kind == FocusKind.LOADING) st.pending = j
                }
            }
        }

        fun tune(id: String) = if (onTune != null) onTune(id) else LiveTv.tune(context, repo, id)

        fun toast(id: Int, vararg args: Any) = Toast.makeText(context, res.getString(id, *args), Toast.LENGTH_SHORT).show()

        fun focusedProgram(): ProgramLite? {
            val f = st.focus ?: return null
            if (f.kind != FocusKind.PROGRAM) return null
            return repo.programs(f.channelId, f.start ?: return null, f.end ?: return null).firstOrNull { it.id == f.programId }
        }

        fun toggleFavorite(row: ChannelRow) {
            scope.launch {
                if (!repo.setFavorite(row.id, !row.favorite)) toast(com.wika.wicaby.core.R.string.livetv_toasts_favorites_unavailable)
            }
        }

        fun record(p: ProgramLite) {
            if (!caps.canRecord) return
            scope.launch { guideRecordToggle(repo, p)?.let { toast(it) } }
        }

        fun remind(p: ProgramLite) {
            val row = byId[p.channelId] ?: return
            scope.launch { toggleReminder(context, repo, p, row, p.id in reminderIds) }
        }

        fun openSheet() {
            val f = st.focus ?: return
            val row = byId[f.channelId] ?: return
            val p = focusedProgram()
            overlay.show(gridReq) {
                ProgramSheet(
                    repo, row, p, st.now, canRecord = caps.canRecord, recording = p != null && overlayMarks.containsKey(p.id),
                    reminded = p != null && p.id in reminderIds,
                    onWatch = { overlay.close(); tune(row.id) },
                    onRecord = { overlay.close(); p?.let(::record) },
                    onRemind = { overlay.close(); p?.let(::remind) },
                    onFavorite = { overlay.close(); toggleFavorite(row) },
                    onDismiss = overlay::close,
                )
            }
        }

        fun activate() {
            val f = st.focus ?: return
            when (f.kind) {
                FocusKind.CHANNEL -> tune(f.channelId)
                FocusKind.FILLER -> {
                    if (repo.rowFailed(f.channelId, st.left, st.left + st.laneMs)) repo.retryRow(f.channelId) else tune(f.channelId)
                }
                FocusKind.LOADING -> if (repo.rowFailed(f.channelId, st.left, st.left + st.laneMs)) repo.retryRow(f.channelId)
                FocusKind.PROGRAM -> {
                    val airing = (f.start ?: 0) <= st.now && st.now < (f.end ?: 0)
                    if (airing && TvSettings.liveEnterOnAiring.value == TvSettings.LIVE_ENTER_TUNE) tune(f.channelId) else openSheet()
                }
            }
        }

        fun openSearch() = overlay.show(gridReq) {
            GuideSearch(repo, st.clock, st.rangeEnd, onPick = { overlay.close(); runJump(it) }, onDismiss = overlay::close)
        }

        fun nextLens() {
            val next = stepLens(lenses, prefs.lens, 1)
            repo.prefs.update(PrefField.LENS, prefs.copy(lens = next))
            toast(com.wika.wicaby.core.R.string.livetv_lens_switched, lensLabel(context, next, prefs.groups))
        }

        fun move(m: NavMove, repeat: Boolean) {
            val f = st.focus ?: return
            // At most one repeated move per frame: repeats queued behind a slow frame share its 16 ms bucket.
            val step = gateMove(st.gate, SystemClock.uptimeMillis() / 16, repeat)
            st.gate = step.gate
            if (!step.accept) return
            st.anchor = anchorReduce(st.anchor, AnchorEvent.Input(SystemClock.elapsedRealtime())).state
            val r = navMove(st.model(), f, m, visibleRows())
            if (r.exit == NavExit.UP) {
                runCatching { dayReq.requestFocus() }
                return
            }
            val nf = r.focus ?: return // Left from the channel column: there is no side rail to leave to
            r.scrollLeft?.let { l ->
                scrollTo(l, snap = repeat)
                val nowVisible = st.now >= st.left && st.now < st.left + st.laneMs
                st.anchor = anchorReduce(st.anchor, AnchorEvent.Scroll(SystemClock.elapsedRealtime(), nowVisible)).state
            }
            r.rowIndex?.let { revealRow(it, snap = repeat) }
            st.focus = nf
        }

        var okDown by remember { mutableStateOf(false) }
        var okLong by remember { mutableStateOf(false) }

        fun onKey(e: androidx.compose.ui.input.key.KeyEvent): Boolean {
            val ne = e.nativeKeyEvent
            val code = ne.keyCode
            if (ne.action == AKey.ACTION_UP) {
                if ((code == AKey.KEYCODE_DPAD_CENTER || code == AKey.KEYCODE_ENTER || code == AKey.KEYCODE_NUMPAD_ENTER) && okDown) {
                    okDown = false
                    if (!okLong) {
                        if (jump.open) jump.enter(context, repo)?.let(::runJump) else activate()
                    }
                    return true
                }
                return false
            }
            if (ne.action != AKey.ACTION_DOWN) return false
            val repeat = ne.repeatCount > 0
            if (code in AKey.KEYCODE_0..AKey.KEYCODE_9 || code in AKey.KEYCODE_NUMPAD_0..AKey.KEYCODE_NUMPAD_9) {
                val d = if (code <= AKey.KEYCODE_9) code - AKey.KEYCODE_0 else code - AKey.KEYCODE_NUMPAD_0
                jump.digit(context, repo, d.toString())?.let(::runJump)
                return true
            }
            if (jump.open) {
                when (code) {
                    AKey.KEYCODE_PERIOD, AKey.KEYCODE_MINUS, AKey.KEYCODE_NUMPAD_DOT, AKey.KEYCODE_TV_NUMBER_ENTRY -> { jump.separator(); return true }
                    AKey.KEYCODE_DEL -> { jump.backspace(); return true }
                    AKey.KEYCODE_DPAD_UP -> { jump.pick(-1); return true }
                    AKey.KEYCODE_DPAD_DOWN -> { jump.pick(1); return true }
                }
            }
            return when (code) {
                AKey.KEYCODE_DPAD_UP -> { move(NavMove.UP, repeat); true }
                AKey.KEYCODE_DPAD_DOWN -> { move(NavMove.DOWN, repeat); true }
                AKey.KEYCODE_DPAD_LEFT -> { move(NavMove.LEFT, repeat); true }
                AKey.KEYCODE_DPAD_RIGHT -> { move(NavMove.RIGHT, repeat); true }
                AKey.KEYCODE_CHANNEL_UP, AKey.KEYCODE_PAGE_UP -> { move(NavMove.PAGE_UP, repeat); true }
                AKey.KEYCODE_CHANNEL_DOWN, AKey.KEYCODE_PAGE_DOWN -> { move(NavMove.PAGE_DOWN, repeat); true }
                AKey.KEYCODE_MOVE_HOME -> { goNow(); true }
                AKey.KEYCODE_DPAD_CENTER, AKey.KEYCODE_ENTER, AKey.KEYCODE_NUMPAD_ENTER -> {
                    if (!repeat) {
                        okDown = true
                        okLong = false
                    } else if (okDown && !okLong) {
                        okLong = true // long OK: the sheet (programme) or the channel menu
                        openSheet()
                    }
                    true
                }
                AKey.KEYCODE_INFO -> { openSheet(); true }
                AKey.KEYCODE_MENU -> {
                    overlay.show(gridReq) { SortPicker(repo, prefs, onDismiss = overlay::close) }
                    true
                }
                AKey.KEYCODE_PROG_RED, AKey.KEYCODE_MEDIA_RECORD -> { focusedProgram()?.let(::record); true }
                AKey.KEYCODE_PROG_GREEN -> { st.focus?.let { byId[it.channelId] }?.let(::toggleFavorite); true }
                AKey.KEYCODE_PROG_YELLOW -> { nextLens(); true }
                AKey.KEYCODE_PROG_BLUE, AKey.KEYCODE_SEARCH -> { openSearch(); true }
                AKey.KEYCODE_MEDIA_FAST_FORWARD -> { pick(AnchorEvent.Pick(SystemClock.elapsedRealtime()), st.left + TV_PAGE_MS, snap = repeat); true }
                AKey.KEYCODE_MEDIA_REWIND -> { pick(AnchorEvent.Pick(SystemClock.elapsedRealtime()), st.left - TV_PAGE_MS, snap = repeat); true }
                else -> false
            }
        }

        // ---- Data → focus: first focus, restore by identity after a lens or data change, the pending jump ----

        LaunchedEffect(rows.isNotEmpty()) {
            if (rows.isEmpty() || st.focus != null) return@LaunchedEffect
            st.left = st.clampLeft(leftForNow(st.now, st.laneMs))
            st.offset.snapTo(st.x(st.left))
            // §6.9 scroll restore: the guide opens on the last tuned channel's row, at now.
            val last = prefs.recents.firstOrNull { it in st.rowIds }
            val idx = if (last != null) st.rowIds.indexOf(last) else 0
            st.focus = restoreFocus(st.model(), GuideFocus(FocusKind.LOADING, st.rowIds[idx], st.now), idx)
            if (idx > 0) listState.scrollToItem(maxOf(0, idx - 1))
        }
        // TV-3: the player's GUIDE / Back lands here focused on its channel (after the first focus, which would overwrite it).
        LaunchedEffect(jumpTo, jumpAt) {
            val j = jumpAt ?: PendingJump(jumpTo ?: return@LaunchedEffect, repo.now())
            snapshotFlow { st.focus }.first { it != null }
            runJump(j)
            runCatching { gridReq.requestFocus() }
            onJumped()
        }
        fun onData() {
            st.pending?.let { runJump(it); return }
            val f = st.focus ?: return
            val inLens = f.channelId in st.rowIds
            if (!inLens || f.kind == FocusKind.LOADING || f.kind == FocusKind.FILLER) {
                st.focus = restoreFocus(st.model(), f, listState.firstVisibleItemIndex) ?: f
            }
        }
        val latestOnData by rememberUpdatedState(::onData)
        LaunchedEffect(rows) { snapshotFlow { version.value }.collect { latestOnData() } }

        LaunchedEffect(st) {
            snapshotFlow { st.focus }.collectLatest {
                delay(100)
                st.shown = it
            }
        }

        // ---- Clock tick (30 s): the now line and the anchor re-centre; nothing recomposes ----

        LaunchedEffect(st) {
            while (true) {
                delay(30_000)
                st.now = repo.now()
                val frac = (st.now - st.visibleLeft()).toDouble() / st.laneMs
                val step = anchorReduce(st.anchor, AnchorEvent.Tick(SystemClock.elapsedRealtime(), frac))
                st.anchor = step.state
                if (step.recenter) goNow()
            }
        }
        LaunchedEffect(repo) {
            repo.gate.visible.collect { on ->
                val at = SystemClock.elapsedRealtime()
                val step = anchorReduce(st.anchor, if (on) AnchorEvent.Visible(at) else AnchorEvent.Hidden(at))
                st.anchor = step.state
                if (on) st.now = repo.now()
                if (step.recenter) goNow()
            }
        }

        // ---- The planner sees the visible rows and span; after 2 s without input it adds the P3 "now" slab ----

        LaunchedEffect(st, listState) {
            var lastBucket = st.bucket.value
            snapshotFlow { Triple(st.rowIds, listState.firstVisibleItemIndex, st.bucket.value) }
                .distinctUntilChanged()
                .collectLatest { (ids, first, bucket) ->
                    if (ids.isEmpty()) return@collectLatest
                    val dir = bucket.compareTo(lastBucket)
                    lastBucket = bucket
                    val l = st.visibleLeft()
                    val last = minOf(ids.lastIndex, first + visibleRows() - 1)
                    val v = Viewport(ids, first, last, l, l + st.laneMs, repo.tuning)
                    repo.setViewport(v, dir)
                    delay(2_000)
                    repo.setViewport(v, dir, idle = true)
                }
        }

        // §16.3: per move, what recomposed for it; the budget is ≤ 3 recomposed cells, ≤ 80 composed.
        // Cells are drawn by their lane, never composed, so both cell counts are 0 by construction; a lane
        // recomposes only when data lands (or its row enters the list), never on a move.
        if (BuildConfig.DEBUG) {
            LaunchedEffect(st) {
                snapshotFlow { st.focus }.collect {
                    st.recomposedLanes = 0
                    delay(100)
                    Log.d(LIVE_TAG, "guide move: recomposed lanes ${st.recomposedLanes}, rows ${listState.layoutInfo.visibleItemsInfo.size}")
                }
            }
        }

        BackHandler(enabled = gridFocused && !overlay.open) {
            if (jump.open) jump.cancel() else runCatching { dayReq.requestFocus() }
        }

        Column(Modifier.fillMaxSize().padding(bottom = GuideDims.safeTop)) {
            GuideHeader(
                st, prefs, lenses, dayReq,
                onLens = { overlay.show { LensPicker(repo, prefs, lenses, onDismiss = overlay::close) } },
                onDay = { day -> pick(AnchorEvent.Pick(SystemClock.elapsedRealtime()), st.clock.leftForDay(day, st.left, st.anchor.mode == AnchorMode.LIVE)) },
                onNow = ::goNow,
                onDaypart = { part: Daypart ->
                    val day = st.clock.dayStart(st.left + st.laneMs / 3)
                    pick(AnchorEvent.Pick(SystemClock.elapsedRealtime()), st.clock.leftForDaypart(day, part))
                },
                onSearch = ::openSearch,
            )
            val band = Modifier.padding(horizontal = GuideDims.side).padding(top = 8.dp).height(GuideDims.band).fillMaxWidth()
            if (onSlot != null) {
                Row(band, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    DetailBand(api, repo, st, byId, overlayMarks, reminderIds, ctx, Modifier.weight(1f).fillMaxHeight())
                    // The player's video shows through this hole: same decoder, never re-prepared.
                    Spacer(Modifier.fillMaxHeight().aspectRatio(16f / 9f).onGloballyPositioned { onSlot(it.boundsInRoot()) })
                }
            } else if (TvSettings.liveGuideDetailBand.value) {
                DetailBand(api, repo, st, byId, overlayMarks, reminderIds, ctx, band)
            }
            when {
                rows.isEmpty() && load == ChannelsLoad.READY -> EmptyLens(repo, prefs)
                rows.isEmpty() -> GuideSkeleton(rowH)
                else -> GridNode(
                    st, byId, overlayMarks, reminderIds, ctx, rows.size, caps.canRecord,
                    GridActions(
                        record = { focusedProgram()?.let(::record) },
                        favorite = { st.focus?.let { byId[it.channelId] }?.let(::toggleFavorite) },
                        details = ::openSheet,
                        remind = { focusedProgram()?.let(::remind) },
                    ),
                    gridFocused, gridReq,
                    Modifier
                        .padding(top = 8.dp)
                        .fillMaxSize()
                        .focusRequester(gridReq)
                        .onFocusChanged {
                            // A sheet opened from the grid keeps the grid layout under it (no jump behind the overlay).
                            val was = gridFocused
                            gridFocused = it.isFocused || (overlay.open && gridFocused)
                            if (gridFocused && !was) onEnter() // the host lifts the guide under the safe area
                        }
                        .onKeyEvent(::onKey),
                ) {
                    Column(Modifier.fillMaxSize()) {
                        GuideRuler(st, Modifier.padding(horizontal = GuideDims.side).fillMaxWidth().height(GuideDims.ruler))
                        Box(Modifier.fillMaxSize().padding(horizontal = GuideDims.side)) {
                            GuideRows(api, st, rows, listState, rowH, version, overlayMarks, reminderIds, ctx)
                            NowLine(st, C.label, Modifier.padding(start = GuideDims.channelCol))
                        }
                    }
                }
            }
        }
        NumberJumpOverlay(jump, byId, Modifier.align(Alignment.TopEnd).padding(top = GuideDims.safeTop, end = GuideDims.side))
        LaunchedEffect(jump.state) {
            val s = jump.state ?: return@LaunchedEffect
            delay(maxOf(0L, s.lastKeyAt + jump.timeoutMs - SystemClock.elapsedRealtime()) + 10)
            jump.tick(context, repo)?.let(::runJump)
        }
    }
}

@Composable
private fun GuideRows(
    api: Api,
    st: GuideState,
    rows: List<ChannelRow>,
    listState: LazyListState,
    rowH: Dp,
    version: State<Long>,
    marks: Map<String, com.wika.wicaby.core.livetv.TimerLite>,
    reminders: Set<String>,
    ctx: CellContext,
) {
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), userScrollEnabled = false) {
        items(rows, key = { it.id }, contentType = { 0 }) { row ->
            GuideRowView(api, st, row, rowH, version, marks, reminders, ctx)
        }
    }
}

internal class GridActions(val record: () -> Unit, val favorite: () -> Unit, val details: () -> Unit, val remind: () -> Unit)

/**
 * The grid's single focus node (§6.2, §21.7): it alone reads the focus for its label, so a move
 * recomposes this node and the band, never the rows. TalkBack gets the label, the custom actions that
 * long OK cannot advertise, the collection size, and a polite live region (one change per 300 ms).
 */
@Composable
private fun GridNode(
    st: GuideState,
    byId: Map<String, ChannelRow>,
    marks: Map<String, com.wika.wicaby.core.livetv.TimerLite>,
    reminders: Set<String>,
    ctx: CellContext,
    rowCount: Int,
    canRecord: Boolean,
    actions: GridActions,
    hasFocus: Boolean,
    req: FocusRequester,
    modifier: Modifier,
    content: @Composable () -> Unit,
) {
    val f = st.shown
    val label = focusLabel(f, programOf(st.repo, f), byId, st.now, marks, reminders, ctx)
    var announced by remember { mutableStateOf("") }
    LaunchedEffect(label) {
        delay(300)
        announced = label
    }
    val gridLabel = stringResource(R.string.livetv_guide_aria_grid)
    val favorite = f?.let { byId[it.channelId] }?.favorite == true
    val acts = listOfNotNull(
        if (canRecord) CustomAccessibilityAction(stringResource(R.string.livetv_actions_record)) { actions.record(); true } else null,
        CustomAccessibilityAction(
            stringResource(if (favorite) com.wika.wicaby.core.R.string.livetv_channel_favorite_remove else com.wika.wicaby.core.R.string.livetv_channel_favorite_add),
        ) { actions.favorite(); true },
        CustomAccessibilityAction(stringResource(R.string.livetv_guide_detail)) { actions.details(); true },
        CustomAccessibilityAction(stringResource(R.string.livetv_sheet_remind_me)) { actions.remind(); true },
    )
    Box(
        modifier
            .semantics {
                focused = hasFocus
                requestFocus { runCatching { req.requestFocus() }.isSuccess }
                contentDescription = label.ifEmpty { gridLabel }
                collectionInfo = CollectionInfo(rowCount, 1)
                customActions = acts
            }
            .focusTarget(),
    ) {
        content()
        Box(Modifier.size(1.dp).semantics { liveRegion = LiveRegionMode.Polite; contentDescription = announced })
    }
}

@Composable
private fun GuideSkeleton(rowH: Dp) {
    Column(Modifier.padding(horizontal = GuideDims.side).padding(top = 8.dp + GuideDims.ruler)) {
        repeat(5) {
            Row(Modifier.height(rowH).fillMaxWidth().padding(vertical = 3.dp)) {
                Box(Modifier.width(GuideDims.channelCol - 6.dp).fillMaxHeight().background(C.fill1))
                Spacer(Modifier.width(6.dp))
                Box(Modifier.fillMaxSize().background(C.fill1))
            }
        }
    }
}

@Composable
private fun EmptyLens(repo: LiveTvRepository, prefs: com.wika.wicaby.core.livetv.LiveTvPrefs) {
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        val fav = prefs.lens == LensRef.Favorites
        Text(
            stringResource(if (fav) com.wika.wicaby.core.R.string.livetv_lens_empty_favorites else com.wika.wicaby.core.R.string.livetv_lens_empty),
            style = Type.body, color = C.label2,
        )
        Pill(
            stringResource(com.wika.wicaby.core.R.string.livetv_lens_show_all),
            onClick = { repo.prefs.update(PrefField.LENS, prefs.copy(lens = LensRef.All)) },
            modifier = Modifier.padding(top = 14.dp),
        )
    }
}

/** Shared with the scope of a launched DVR write. */
internal suspend fun guideRecordToggle(repo: LiveTvRepository, p: ProgramLite): Int? {
    val api = repo.api
    val timer = repo.overlay.value[p.id]
    val op = if (timer != null) com.wika.wicaby.core.livetv.DvrOp.CANCEL_TIMER else com.wika.wicaby.core.livetv.DvrOp.CREATE_TIMER
    return try {
        if (timer != null) {
            api.json(Dialect.cancelTimer(api.kind, timer.id))
        } else {
            val defaults = api.json(Dialect.timerDefaults(api.kind, p.id)) as? JsonObject ?: return R.string.livetv_guide_record_failed
            api.json(Dialect.createTimer(api.kind, com.wika.wicaby.core.livetv.quickRecordBody(defaults, repo.prefs.prefs.value.dvrPadding)))
        }
        repo.requestTimers(0)
        null
    } catch (e: LiveApiException) {
        val err = com.wika.wicaby.core.livetv.mapDvrError(api.kind, op, e.status, e.message.orEmpty())
        repo.noteDvrError(err)
        if (err == com.wika.wicaby.core.livetv.DvrError.FORBIDDEN) R.string.livetv_guide_record_forbidden else R.string.livetv_guide_record_failed
    }
}

