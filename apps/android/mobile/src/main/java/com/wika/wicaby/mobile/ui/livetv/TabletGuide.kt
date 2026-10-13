package com.wika.wicaby.mobile.ui.livetv

import android.content.res.Configuration
import android.os.SystemClock
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.AnchorEvent
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.Daypart
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.FocusKind
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.GuideFocus
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.core.livetv.anchorReduce
import com.wika.wicaby.core.livetv.leftForNow
import com.wika.wicaby.core.livetv.parseServerDate
import com.wika.wicaby.core.livetv.programAt
import com.wika.wicaby.livetvui.GuideState
import com.wika.wicaby.livetvui.GuideStyle
import com.wika.wicaby.livetvui.Lane
import com.wika.wicaby.livetvui.NowLine
import com.wika.wicaby.livetvui.Ruler
import com.wika.wicaby.livetvui.rememberCellContext
import com.wika.wicaby.mobile.BuildConfig
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone

// The tablet guide (spec §3.2, §6.1, M-4): on a tablet in landscape, the TV grid's lanes (:livetv-ui)
// with touch scroll. One LazyColumn of rows scrolls vertically; a horizontal drag or fling moves the
// shared offset, which every lane draws from (nothing recomposes). Tapping a programme opens its
// sheet, a filler tunes (or retries a failed slab), a channel tunes; a long press opens the channel menu.

private const val MIN = 60_000L
private const val HOUR = 60 * MIN
private val CHANNEL_COL = 160.dp
private val RULER = 36.dp
private const val DP_PER_MIN = 3f

/**
 * The grid replaces the channel list on a tablet (smallest width ≥ 600 dp) in landscape. With TalkBack's
 * touch exploration the list stays: its rows are real nodes, the grid's cells are drawn.
 */
@Composable
fun useTabletGrid(): Boolean {
    val conf = LocalConfiguration.current
    val context = LocalContext.current
    // shortcut: read when the configuration changes, not live; a TalkBack toggle applies on the next rotation or visit.
    val explore = remember(conf, context) { context.getSystemService(AccessibilityManager::class.java)?.isTouchExplorationEnabled == true }
    return conf.smallestScreenWidthDp >= 600 && conf.orientation == Configuration.ORIENTATION_LANDSCAPE && !explore
}

/** The grid scrolls to the time chip's [part] (null = now) on every pick ([picks] counts them, so re-picking "Maintenant" re-centres). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TabletGuide(repo: LiveTvRepository, rows: List<ChannelRow>, part: String?, picks: Int, onAgenda: (String) -> Unit) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val st = remember(repo) {
        val clock = GuideClock(TimeZone.getDefault())
        GuideState(repo, clock, with(density) { DP_PER_MIN.dp.toPx() }, clock.dayStart(repo.now()), BuildConfig.DEBUG)
    }
    st.rowIds = remember(rows) { rows.map { it.id } }
    val prefs by repo.prefs.prefs.collectAsState()
    val caps by repo.caps.collectAsState()
    val marks by repo.overlay.collectAsState()
    // Read in the lanes' draw, never here: a tile landing must not recompose the guide.
    val version = repo.guideVersion.collectAsState()
    val style = remember {
        GuideStyle(
            bg = G.bg, label = G.label, label2 = G.label2, label3 = G.label3, fill1 = G.fill1, fill2 = G.fill2, fill3 = G.fill3,
            separator = G.separator, red = G.red, title = Type.callout, caption = Type.caption, radius = Radius.xs,
        )
    }
    val ctx = rememberCellContext(prefs.badges, caps, style)
    val list = rememberLazyListState()
    var sheet by remember { mutableStateOf<Pair<ChannelRow, ProgramLite>?>(null) }
    val today = stringResource(R.string.livetv_guide_today)
    val tomorrow = stringResource(R.string.livetv_guide_tomorrow)
    val locale = uiLocale()
    val dayLabel = remember(st, locale, today, tomorrow) {
        val f = SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEdMMM"), locale)
        val label: (Long) -> String = { at ->
            val d = st.clock.dayStart(at)
            val d0 = st.clock.dayStart(st.now)
            when (d) {
                d0 -> today
                st.clock.dayStart(d0 + 36 * HOUR) -> tomorrow
                else -> f.format(Date(at))
            }
        }
        label
    }

    // GuideInfo.EndDate bounds the canvas (fallback now + 7 d), as on TV.
    LaunchedEffect(repo) {
        val end = try {
            parseServerDate((repo.api.json(Dialect.guideInfo(repo.api.kind)) as? JsonObject)?.get("EndDate"))
        } catch (_: LiveApiException) {
            null
        }
        st.rangeEnd = if (end != null && end > st.now) end else st.now + 7 * 24 * HOUR
    }
    LaunchedEffect(prefs.lens) { list.scrollToItem(0) }

    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        val lanePx = with(density) { (maxWidth - CHANNEL_COL).toPx() }
        st.laneMs = (lanePx / st.pxPerMin * MIN).toLong()

        fun snap(px: Float) {
            val v = px.coerceIn(0f, maxOf(0f, st.x(st.rangeEnd - st.laneMs)))
            // Undispatched: the uncontended snap lands before the next drag delta reads the offset.
            scope.launch(start = CoroutineStart.UNDISPATCHED) { st.offset.snapTo(v) }
        }

        val hScroll = rememberScrollableState { d ->
            val cur = st.offset.value
            val next = (cur - d).coerceIn(0f, maxOf(0f, st.x(st.rangeEnd) - lanePx))
            snap(next)
            val l = st.timeAt(next)
            st.anchor = anchorReduce(st.anchor, AnchorEvent.Scroll(SystemClock.elapsedRealtime(), st.now >= l && st.now < l + st.laneMs)).state
            cur - next
        }

        fun goNow() {
            st.left = st.clampLeft(leftForNow(st.now, st.laneMs))
            snap(st.x(st.left))
        }

        // §6.4: "Maintenant" puts now a third into the lane (anchor live); a daypart puts its time 30 min in.
        LaunchedEffect(part, picks) {
            val at = SystemClock.elapsedRealtime()
            val dp = Daypart.fromId(part)
            if (dp == null) {
                st.anchor = anchorReduce(st.anchor, AnchorEvent.Now(at)).state
                goNow()
            } else {
                st.anchor = anchorReduce(st.anchor, AnchorEvent.Pick(at)).state
                st.left = st.clampLeft(st.clock.leftForDaypart(st.clock.dayStart(st.now), dp))
                snap(st.x(st.left))
            }
        }

        // The now line and the airing progress follow the clock (drawn, so nothing recomposes); while live, the
        // view re-centres on now once it drifts out of its band after 5 min without input (anchorReduce, as on TV).
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

        // The planner sees the visible rows and span (settled, §16 request budget); after 2 s the idle "now" slab.
        LaunchedEffect(st, list, rows) {
            var lastBucket = st.bucket.value
            snapshotFlow { list.firstVisibleItemIndex to st.bucket.value }
                .distinctUntilChanged()
                .collectLatest { (first, bucket) ->
                    val ids = st.rowIds
                    if (ids.isEmpty()) return@collectLatest
                    val dir = bucket.compareTo(lastBucket)
                    lastBucket = bucket
                    if (list.isScrollInProgress || hScroll.isScrollInProgress) delay(250)
                    val l = st.visibleLeft()
                    val f = first.coerceIn(0, ids.lastIndex)
                    val last = (f + list.layoutInfo.visibleItemsInfo.size - 1).coerceIn(f, ids.lastIndex)
                    val v = Viewport(ids, f, last, l, l + st.laneMs, repo.tuning)
                    repo.setViewport(v, dir)
                    delay(2_000)
                    repo.setViewport(v, dir, idle = true)
                }
        }

        fun tap(row: ChannelRow, at: Long) {
            val p = programAt(repo.programs(row.id, at, at + MIN), at)
            when {
                p != null -> {
                    st.focus = GuideFocus(FocusKind.PROGRAM, row.id, at, p.id, p.start, p.end) // inverted while its sheet is open
                    sheet = row to p
                }
                repo.rowFailed(row.id, at, at + MIN) -> repo.retryRow(row.id)
                else -> tune(context, repo, row.id) // a filler tunes, as OK does on TV (§6.1)
            }
        }

        val rowH = with(density) { rowSpec(Type.callout.lineHeight.toDp()).height }.coerceAtLeast(64.dp)
        val r = with(density) { Radius.xs.toPx() }
        Column(
            Modifier.fillMaxSize().scrollable(hScroll, Orientation.Horizontal).pointerInput(st) {
                // Any touch is input: it holds off the idle re-centre (a horizontal drag also reports Scroll above).
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent(PointerEventPass.Initial)
                        st.anchor = anchorReduce(st.anchor, AnchorEvent.Input(SystemClock.elapsedRealtime())).state
                    }
                }
            },
        ) {
            Ruler(st, style, CHANNEL_COL, dayLabel, Modifier.fillMaxWidth().height(RULER))
            Box(Modifier.fillMaxSize()) {
                LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(rows, key = { it.id }, contentType = { 0 }) { row ->
                        var menu by remember { mutableStateOf(false) }
                        Row(Modifier.height(rowH).fillMaxWidth().padding(vertical = 3.dp)) {
                            Box {
                                Row(
                                    Modifier.width(CHANNEL_COL - 6.dp).fillMaxHeight()
                                        .drawBehind { drawRoundRect(G.fill1, cornerRadius = CornerRadius(r)) }
                                        .combinedClickable(role = Role.Button, onClick = { tune(context, repo, row.id) }, onLongClick = { menu = true })
                                        .padding(horizontal = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    // The number, then the logo in a fixed 2:1 slot as on TV (ChannelLogo falls back to the name).
                                    Text(row.number, style = Type.mono, color = G.label2, maxLines = 1)
                                    ChannelLogo(repo, row, 30.dp, Modifier.width(60.dp), nameLines = 2, showNumber = false)
                                    if (row.favorite) Text("★", style = Type.caption, color = G.label2)
                                }
                                // Composed only once opened, as in the phone list.
                                if (menu) ChannelMenu(repo, row, onDismiss = { menu = false }, onAgenda = onAgenda)
                            }
                            Spacer(Modifier.width(6.dp))
                            Lane(
                                st, row, version, marks, emptySet(), ctx,
                                Modifier.fillMaxSize().pointerInput(row.id) { detectTapGestures { pos -> tap(row, st.timeAt(st.offset.value + pos.x)) } },
                            )
                        }
                    }
                }
                NowLine(st, G.label, Modifier.padding(start = CHANNEL_COL))
            }
        }
    }
    sheet?.let { (row, p) ->
        ProgramSheet(repo, row, p, st.now, onDismiss = {
            sheet = null
            st.focus = null
        })
    }
}
