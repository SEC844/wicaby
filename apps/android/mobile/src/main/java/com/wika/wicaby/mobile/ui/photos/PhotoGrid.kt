package com.wika.wicaby.mobile.ui.photos

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.semantics.selected
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.onAccent
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.allowRgb565
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSizes
import com.wika.wicaby.core.photos.Row as LayoutRow
import com.wika.wicaby.core.photos.buckets
import com.wika.wicaby.core.photos.layoutTimeline
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.photoImage
import com.wika.wicaby.core.photos.rotation
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Type

// Photos spec §4.3: the justified timeline. A LazyColumn of precomputed rows (core layoutTimeline) under sticky month
// headers; two fingers pinch between three row heights (PhotoSizes.ROW_DP), one finger still scrolls. The densest one
// is a square-crop month overview.

private sealed interface Entry {
    val key: String
}

private class Header(val month: String, override val key: String) : Entry
private class Line(val row: LayoutRow, override val key: String) : Entry

private val GAP = 2.dp
private val HEADER = 44.dp

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PhotoGrid(
    api: Api,
    photos: List<Photo>,
    density: Int,
    onDensity: (Int) -> Unit,
    onOpen: (Int) -> Unit,
    modifier: Modifier = Modifier,
    list: LazyListState = rememberLazyListState(),
    top: Dp = 0.dp,
    selected: Set<String> = emptySet(),
    onLongPress: (Int) -> Unit = {},
) {
    BoxWithConstraints(modifier) {
        val px = LocalDensity.current
        val locale = LocalConfiguration.current.locales[0]
        val width = constraints.maxWidth.toFloat()
        val entries = remember(photos, density, width, locale) {
            val gap = with(px) { GAP.toPx() }
            val aspects = if (density == 0) List(photos.size) { 1.0 } else photos.map { it.asset.aspect }
            val sections = layoutTimeline(buckets(photos.map { it.asset.takenAt }), aspects, width.toDouble(), with(px) { PhotoSizes.ROW_DP[density].dp.toPx() }.toDouble(), gap.toDouble(), 0.0)
            buildList {
                sections.forEach { s ->
                    // A month can come back twice across a page boundary (each page is sorted on its own): unique keys.
                    add(Header(photoDate("${s.key}-01", locale, "LLLL yyyy"), "h-${s.rows.firstOrNull()?.items?.firstOrNull()?.index}"))
                    s.rows.forEach { r -> add(Line(r, "r-${r.items.first().index}")) }
                }
            }
        }
        val context = LocalContext.current
        // mobile-low: 16-bit tiles (spec §4.3 memory budget).
        val low = remember { DeviceClassDetector.detect(context, FormFactor.MOBILE).isLow }
        val thumbPx = with(px) { PhotoSizes.THUMB_DP[density].dp.roundToPx() }

        // After a density change: the row holding the anchor asset comes back to the top.
        var anchor by remember { mutableIntStateOf(-1) }
        LaunchedEffect(entries) {
            if (anchor < 0) return@LaunchedEffect
            val at = entries.indexOfFirst { it is Line && it.row.items.any { x -> x.index == anchor } }
            if (at >= 0) list.scrollToItem(at)
            anchor = -1
        }
        var pinch by remember { mutableFloatStateOf(1f) }
        val change by rememberUpdatedState(onDensity)
        val current by rememberUpdatedState(entries)

        LazyColumn(
            state = list,
            contentPadding = PaddingValues(top = top, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(GAP),
            modifier = Modifier
                .fillMaxSize()
                .testTag("photo-grid")
                .pointerInput(density) {
                    // Two fingers only, seen before the list: one-finger scrolling stays the list's.
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        var zoom = 1f
                        do {
                            val ev = awaitPointerEvent(PointerEventPass.Initial)
                            if (ev.changes.count { it.pressed } >= 2) {
                                zoom *= ev.calculateZoom()
                                pinch = zoom.coerceIn(0.6f, 1.6f)
                                ev.changes.forEach { it.consume() }
                            }
                        } while (ev.changes.any { it.pressed })
                        pinch = 1f
                        val next = (density + if (zoom > 1.25f) 1 else if (zoom < 0.8f) -1 else 0).coerceIn(0, PhotoSizes.ROW_DP.size - 1)
                        if (next != density) {
                            anchor = list.layoutInfo.visibleItemsInfo.firstNotNullOfOrNull { (current.getOrNull(it.index) as? Line)?.row?.items?.first()?.index } ?: -1
                            change(next)
                        }
                    }
                }
                .graphicsLayer {
                    scaleX = pinch
                    scaleY = pinch
                    transformOrigin = TransformOrigin(0.5f, 0f)
                },
        ) {
            entries.forEach { e ->
                when (e) {
                    is Header -> stickyHeader(e.key, contentType = "month") {
                        Text(
                            e.month, style = Type.title3, color = G.label,
                            modifier = Modifier.fillMaxWidth().height(HEADER).background(G.bg.copy(alpha = 0.92f)).padding(horizontal = 16.dp, vertical = 10.dp).testTag("photo-month"),
                        )
                    }
                    is Line -> item(e.key, contentType = "row") {
                        Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                            for (it in e.row.items) {
                                val p = photos[it.index]
                                Tile(api, p, with(px) { it.w.toFloat().toDp() }, with(px) { e.row.height.toFloat().toDp() }, thumbPx, low, p.asset.id in selected, { onLongPress(it.index) }) { onOpen(it.index) }
                            }
                        }
                    }
                }
            }
        }
        FastScroller(list, entries, with(px) { top.toPx() }, constraints.maxHeight.toFloat())
    }
}

// Spec §4.3 fast scroller: a right-edge thumb while the list moves; dragging it jumps through the rows (layoutTimeline's
// sections, in order) with the month in a bubble. Only there while shown, so the edge tiles keep their taps otherwise.
@Composable
private fun FastScroller(list: LazyListState, entries: List<Entry>, topPx: Float, heightPx: Float) {
    if (entries.size < 2) return
    val months = remember(entries) { var m = ""; entries.map { e -> if (e is Header) m = e.month; m } }
    var drag by remember { mutableStateOf<Int?>(null) }
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(list.isScrollInProgress, drag) {
        if (list.isScrollInProgress || drag != null) shown = true else {
            delay(1_500)
            shown = false
        }
    }
    if (!shown) return
    val scope = rememberCoroutineScope()
    val px = LocalDensity.current
    val thumb = with(px) { 44.dp.toPx() }
    val track = (heightPx - topPx - thumb).coerceAtLeast(1f)
    val span = (entries.size - list.layoutInfo.visibleItemsInfo.size).coerceAtLeast(1)
    val frac = drag?.let { it.toFloat() / (entries.size - 1) } ?: (list.firstVisibleItemIndex.toFloat() / span).coerceIn(0f, 1f)
    fun jump(y: Float) {
        val i = (((y - topPx - thumb / 2) / track).coerceIn(0f, 1f) * (entries.size - 1)).toInt()
        drag = i
        scope.launch { list.scrollToItem(i) }
    }
    Box(Modifier.fillMaxSize()) {
        val y = with(px) { (topPx + frac * track).toDp() }
        Box(
            Modifier.align(Alignment.TopEnd).fillMaxHeight().width(36.dp).testTag("photo-scroller").pointerInput(entries) {
                detectVerticalDragGestures(
                    onDragStart = { jump(it.y) }, onDragEnd = { drag = null }, onDragCancel = { drag = null },
                ) { change, _ ->
                    change.consume()
                    jump(change.position.y)
                }
            },
        ) {
            Box(Modifier.align(Alignment.TopEnd).offset(y = y).padding(end = 4.dp).size(6.dp, 44.dp).background(G.label3, RoundedCornerShape(3.dp)))
        }
        drag?.let { i ->
            Text(
                months[i], style = Type.footnote, color = G.label,
                modifier = Modifier.align(Alignment.TopEnd).offset(y = y).padding(end = 44.dp).background(G.elevated2, RoundedCornerShape(50))
                    .padding(horizontal = 12.dp, vertical = 6.dp).testTag("photo-scroller-month"),
            )
        }
    }
}

@Composable
private fun Tile(api: Api, p: Photo, w: Dp, h: Dp, thumbPx: Int, low: Boolean, selected: Boolean, onLongClick: () -> Unit, onClick: () -> Unit) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    // Spec §3.1 orientation rule, once the thumbnail is decoded.
    var rot by remember(p.asset.id) { mutableIntStateOf(0) }
    val request = remember(p.asset.id, thumbPx) {
        ImageRequest.Builder(context).data(api.photoImage(p.asset, maxHeight = thumbPx)).allowRgb565(low).build()
    }
    val label = photoDate(p.asset.takenAt, locale)
    Box(
        Modifier.size(w, h).clip(RoundedCornerShape(3.dp)).background(G.fill1)
            .combinedClickable(onLongClick = onLongClick, onClick = onClick).testTag("photo-${p.asset.id}")
            .semantics { contentDescription = label; this.selected = selected },
    ) {
        AsyncImage(
            request, null, contentScale = ContentScale.Crop,
            onSuccess = { s -> rot = rotation(p.item.imageOrientation, p.item.width ?: 0, p.item.height ?: 0, s.result.image.width, s.result.image.height) },
            modifier = (if (rot % 180 != 0) Modifier.align(Alignment.Center).requiredSize(h, w) else Modifier.fillMaxSize()).graphicsLayer { rotationZ = rot.toFloat() },
        )
        if (selected) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f))) {
            Icon(
                Ic.Check, null, tint = onAccent(LocalAccent.current),
                modifier = Modifier.align(Alignment.TopEnd).padding(6.dp).size(22.dp).background(LocalAccent.current, CircleShape).padding(3.dp),
            )
        }
        p.asset.durationMs?.let { ms ->
            Text(
                clock(ms), style = Type.caption, color = Color.White,
                modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp).background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
    }
}
