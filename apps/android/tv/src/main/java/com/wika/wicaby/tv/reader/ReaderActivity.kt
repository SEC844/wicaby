package com.wika.wicaby.tv.reader

import com.wika.wicaby.tv.ui.dpadEdges
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.tv.material3.Text
import com.wika.wicaby.core.comics.ComicPages
import com.wika.wicaby.core.comics.ComicReader
import com.wika.wicaby.core.comics.ReaderAwake
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.TvCanvas
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.goFullscreen
import com.wika.wicaby.tv.hideSystemBars
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.WicabyTheme
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// Full-screen CBZ reader for the remote: double-page spreads on 16:9, manga order, fit and
// zoom, and a vertical strip for webtoons. The book itself lives in core (ComicReader).
class ReaderActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase)
        AppLanguage.overrideConfiguration(newBase)?.let { applyOverrideConfiguration(it) }
    }

    companion object {
        private const val EXTRA_ID = "id"
        private const val EXTRA_FROM_START = "fromStart"

        // TP-06: [server] names an extra server (null: the primary one).
        private const val EXTRA_SERVER = "server"

        fun start(context: Context, id: String, fromStart: Boolean = false, server: String? = null) {
            context.startActivity(Intent(context, ReaderActivity::class.java).putExtra(EXTRA_ID, id).putExtra(EXTRA_FROM_START, fromStart).putExtra(EXTRA_SERVER, server))
        }
    }

    private var reader: ComicReader? = null
    private val awake by lazy { ReaderAwake(window) }

    override fun onUserInteraction() {
        super.onUserInteraction()
        awake.poke()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyToCore(this)
        val api = intent.getStringExtra(EXTRA_SERVER)?.let { com.wika.wicaby.core.data.Servers.extraOf(it) } ?: Wicaby.app.api.takeIf { intent.getStringExtra(EXTRA_SERVER) == null }
        val id = intent.getStringExtra(EXTRA_ID)
        if (api == null || id == null) {
            finish()
            return
        }
        // TVs are short on RAM: two decoded pages each side, about 1.5 screens of pixels per page.
        val r = ComicReader(api, id, keep = 2, scope = lifecycleScope, pixelBudget = 1.5f)
        reader = r
        r.start(intent.getBooleanExtra(EXTRA_FROM_START, false))
        goFullscreen()
        awake.poke()
        setContent {
            WicabyTheme(Accents[Wicaby.app.accent.coerceIn(Accents.indices)]) {
                ReaderScreen(r, onExit = ::finish)
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Back (or Home and the system killing us later) saves the last page.
    override fun onDestroy() {
        awake.stop()
        reader?.close()
        super.onDestroy()
    }
}

private enum class Fit { Page, Width }

private fun isSelect(k: Key) = k == Key.DirectionCenter || k == Key.Enter || k == Key.NumPadEnter || k == Key.ButtonA

@Composable
private fun ReaderScreen(r: ComicReader, onExit: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (val s = r.state) {
            is ComicReader.State.Loading -> TvCanvas {
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Spinner()
                    Text(
                        stringResource(R.string.reader_loading, (s.progress * 100).roundToInt()), style = Type.callout, color = C.label2,
                        modifier = Modifier.padding(top = 18.dp),
                    )
                }
            }
            is ComicReader.State.Failed -> TvCanvas {
                val focus = remember { FocusRequester() }
                Column(Modifier.fillMaxSize().padding(horizontal = 120.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(r.title, style = Type.title2, color = C.label, textAlign = TextAlign.Center, maxLines = 2)
                    Text(s.message, style = Type.body, color = C.label2, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp, bottom = 26.dp))
                    Pill(stringResource(R.string.reader_back), onClick = onExit, modifier = Modifier.focusRequester(focus))
                }
                LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            }
            ComicReader.State.Ready -> if (r.webtoon) StripView(r) else PagedView(r)
        }
    }
}

// Remote keys for the page area, when the bar is hidden. OK opens the bar on release, so the
// release never lands on the control that just took focus.
@Composable
private fun Modifier.readerKeys(enabled: Boolean, focus: FocusRequester, onOk: () -> Unit, onKey: (Key) -> Boolean): Modifier {
    var okDown by remember { mutableStateOf(false) }
    return this
        .focusRequester(focus)
        .onKeyEvent { e ->
            if (!enabled) return@onKeyEvent false
            when {
                isSelect(e.key) && e.type == KeyEventType.KeyDown -> {
                    okDown = true
                    true
                }
                isSelect(e.key) && e.type == KeyEventType.KeyUp -> {
                    if (okDown) onOk()
                    okDown = false
                    true
                }
                e.type == KeyEventType.KeyDown -> onKey(e.key)
                else -> false
            }
        }
        .focusable()
}

@Composable
private fun PagedView(r: ComicReader) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        r.screen = w.toInt() to h.toInt()
        // 16:9 shows two pages; the cover, landscape pages and the last page stay alone.
        val double = w > h * 1.15f
        val spreads by remember(double) { derivedStateOf { r.spreads(double) } }
        var fit by rememberSaveable { mutableStateOf(Fit.Page) }
        var zoom by rememberSaveable { mutableFloatStateOf(1f) }
        var panX by remember { mutableFloatStateOf(0f) }
        var panY by remember { mutableFloatStateOf(0f) }
        var bar by remember { mutableStateOf(false) }
        val root = remember { FocusRequester() }
        val scrub = remember { FocusRequester() }

        val index = ComicPages.spreadOf(spreads, r.page)
        val spread = spreads.getOrElse(index) { listOf(r.page) }
        val ratios = spread.map { r.sizes.getOrNull(it)?.aspect ?: 0.68f }
        val sum = ratios.sum()
        // Pages share one height; the fit decides it, the zoom multiplies it.
        val pageH = (if (fit == Fit.Width) w / sum else min(h, w / sum)) * zoom
        val maxX = max(0f, (sum * pageH - w) / 2)
        val maxY = max(0f, (pageH - h) / 2)

        val fade = remember { Animatable(1f) }
        val slide = remember { Animatable(0f) }
        var lastIndex by remember { mutableStateOf(index) }
        LaunchedEffect(spread) { r.show(spread) }
        // A new spread starts at its top, on the reading side, and slides in from there.
        LaunchedEffect(spread, fit, zoom) {
            panX = if (r.rtl) -maxX else maxX
            panY = maxY
        }
        LaunchedEffect(index) {
            if (index == lastIndex) return@LaunchedEffect
            val dir = if (index > lastIndex) 1 else -1
            lastIndex = index
            launch { fade.snapTo(0.35f); fade.animateTo(1f, tween(200)) }
            slide.snapTo(dir * (if (r.rtl) -1 else 1) * w * 0.035f)
            slide.animateTo(0f, tween(220))
        }
        val shownX by animateFloatAsState(panX, tween(240), label = "panX")
        val shownY by animateFloatAsState(panY, tween(240), label = "panY")

        fun go(i: Int) {
            val t = i.coerceIn(0, spreads.lastIndex)
            if (t != index) r.show(spreads[t])
        }
        fun side(right: Boolean) = go(index + if (right != r.rtl) 1 else -1)
        // Arrows pan an overflowing spread first and turn the page at its edge.
        fun horizontal(right: Boolean) {
            val more = if (right) panX > -maxX + 1 else panX < maxX - 1
            if (maxX > 1 && more) panX = (panX + (if (right) -1 else 1) * w * 0.6f).coerceIn(-maxX, maxX) else side(right)
        }
        fun vertical(down: Boolean) {
            val more = if (down) panY > -maxY + 1 else panY < maxY - 1
            if (maxY > 1 && more) panY = (panY + (if (down) -1 else 1) * h * 0.6f).coerceIn(-maxY, maxY)
            else if (down && maxY > 1) go(index + 1)
        }

        LaunchedEffect(bar) { if (!bar) runCatching { root.requestFocus() } }
        BackHandler(enabled = bar) { bar = false }

        Canvas(
            Modifier.fillMaxSize()
                .readerKeys(!bar, root, onOk = { bar = true }) { k ->
                    when (k) {
                        Key.DirectionLeft -> horizontal(false)
                        Key.DirectionRight -> horizontal(true)
                        Key.DirectionUp -> vertical(false)
                        Key.DirectionDown -> vertical(true)
                        Key.MediaNext, Key.MediaFastForward, Key.PageDown, Key.ChannelDown -> go(index + 1)
                        Key.MediaPrevious, Key.MediaRewind, Key.PageUp, Key.ChannelUp -> go(index - 1)
                        else -> return@readerKeys false
                    }
                    true
                }
                // Touch (the TV app also runs on tablets): side thirds turn, the middle opens the bar.
                .pointerInput(Unit) {
                    detectTapGestures { o ->
                        when {
                            o.x < size.width / 3f -> side(false)
                            o.x > size.width * 2f / 3f -> side(true)
                            else -> bar = !bar
                        }
                    }
                }
                .graphicsLayer {
                    alpha = fade.value
                    translationX = slide.value
                },
        ) {
            var x = (w - sum * pageH) / 2 + shownX
            val y = (h - pageH) / 2 + shownY
            val order = if (r.rtl) spread.reversed() else spread
            for (i in order) {
                val pw = (r.sizes.getOrNull(i)?.aspect ?: 0.68f) * pageH
                val bmp = r.bitmap(i)
                if (bmp != null) {
                    drawImage(
                        bmp.asImageBitmap(), dstOffset = IntOffset(x.roundToInt(), y.roundToInt()),
                        dstSize = IntSize(pw.roundToInt(), pageH.roundToInt()), filterQuality = FilterQuality.Medium,
                    )
                } else drawRect(C.fill1, Offset(x, y), Size(pw, pageH))
                x += pw
            }
        }
        if (spread.any { r.bitmap(it) == null }) Spinner(Modifier.align(Alignment.Center).size(30.dp))

        AnimatedVisibility(bar, enter = fadeIn(tween(200)) + slideInVertically(tween(260)) { it / 4 }, exit = fadeOut(tween(160)) + slideOutVertically(tween(200)) { it / 4 }) {
            val folio = if (spread.size > 1) "${spread.first() + 1}–${spread.last() + 1}" else "${spread.first() + 1}"
            ReaderBar(
                r, folio, steps = spreads.size, step = index, current = spread, scrub = scrub,
                onStep = { d -> go(index + d) },
                onPick = { p ->
                    go(ComicPages.spreadOf(spreads, p))
                    bar = false
                },
                onClose = { bar = false },
            ) {
                Pill(stringResource(R.string.reader_fit_page), onClick = { fit = Fit.Page }, selected = fit == Fit.Page, icon = Ic.Check.takeIf { fit == Fit.Page })
                Pill(stringResource(R.string.reader_fit_width), onClick = { fit = Fit.Width }, selected = fit == Fit.Width, icon = Ic.Check.takeIf { fit == Fit.Width })
                Pill(stringResource(R.string.reader_zoom), onClick = { zoom = if (zoom > 1f) 1f else 2f }, selected = zoom > 1f, icon = Ic.Check.takeIf { zoom > 1f })
                Pill(stringResource(R.string.reader_rtl), onClick = { r.toggleRtl() }, selected = r.rtl, icon = Ic.Check.takeIf { r.rtl })
                Pill(stringResource(R.string.reader_webtoon), onClick = { r.toggleWebtoon() }, selected = false)
            }
        }
    }
}

// Webtoons: one centred column; up/down scroll, left/right jump a page.
@Composable
private fun StripView(r: ComicReader) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        r.screen = w.toInt() to h.toInt()
        val colW = with(LocalDensity.current) { min(w, h * 0.85f).toDp() }
        val list = rememberLazyListState(initialFirstVisibleItemIndex = r.page)
        val scope = rememberCoroutineScope()
        var bar by remember { mutableStateOf(false) }
        val root = remember { FocusRequester() }
        val scrub = remember { FocusRequester() }

        LaunchedEffect(list) {
            snapshotFlow { list.firstVisibleItemIndex to list.canScrollForward }.collect { (first, more) ->
                val last = r.pageCount - 1
                // The last page only counts once the strip cannot go further.
                val visible = list.layoutInfo.visibleItemsInfo.map { it.index }.filter { more.not() || it != last }.ifEmpty { listOf(first) }
                r.show(visible)
            }
        }
        LaunchedEffect(bar) { if (!bar) runCatching { root.requestFocus() } }
        BackHandler(enabled = bar) { bar = false }

        fun jump(d: Int) = scope.launch { list.animateScrollToItem((list.firstVisibleItemIndex + d).coerceIn(0, max(0, r.pageCount - 1))) }

        LazyColumn(
            state = list,
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize()
                .readerKeys(!bar, root, onOk = { bar = true }) { k ->
                    when (k) {
                        Key.DirectionUp -> scope.launch { list.animateScrollBy(-h * 0.6f) }
                        Key.DirectionDown -> scope.launch { list.animateScrollBy(h * 0.6f) }
                        Key.DirectionLeft, Key.MediaPrevious, Key.PageUp -> jump(-1)
                        Key.DirectionRight, Key.MediaNext, Key.PageDown -> jump(1)
                        else -> return@readerKeys false
                    }
                    true
                }
                .pointerInput(Unit) { detectTapGestures { bar = !bar } },
        ) {
            items(r.pageCount, key = { it }) { i ->
                val bmp = r.bitmap(i)
                Box(Modifier.width(colW).aspectRatio(r.sizes.getOrNull(i)?.aspect ?: 0.68f).background(C.fill1)) {
                    if (bmp != null) Image(remember(bmp) { bmp.asImageBitmap() }, null, contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.Medium, modifier = Modifier.fillMaxSize())
                }
            }
        }

        AnimatedVisibility(bar, enter = fadeIn(tween(200)) + slideInVertically(tween(260)) { it / 4 }, exit = fadeOut(tween(160)) + slideOutVertically(tween(200)) { it / 4 }) {
            ReaderBar(
                r, "${r.page + 1}", steps = r.pageCount, step = r.page, current = listOf(r.page), scrub = scrub,
                onStep = { d -> jump(d) },
                onPick = { p ->
                    scope.launch { list.scrollToItem(p) }
                    bar = false
                },
                onClose = { bar = false },
            ) {
                Pill(stringResource(R.string.reader_webtoon), onClick = { r.toggleWebtoon() }, selected = true, icon = Ic.Check)
            }
        }
    }
}

// The bar OK opens: title and page, the thumbnail strip, the scrubber, then the options.
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun ReaderBar(
    r: ComicReader,
    folio: String,
    steps: Int,
    step: Int,
    current: List<Int>,
    scrub: FocusRequester,
    onStep: (Int) -> Unit,
    onPick: (Int) -> Unit,
    onClose: () -> Unit,
    options: @Composable RowScope.() -> Unit,
) {
    LaunchedEffect(Unit) { runCatching { scrub.requestFocus() } }
    TvCanvas {
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f), Color.Black.copy(alpha = 0.92f))))
                    .padding(start = 48.dp, end = 48.dp, top = 70.dp, bottom = 26.dp),
            ) {
                Row(verticalAlignment = Alignment.Bottom) {
                    val series = r.meta.series?.takeIf { !r.title.startsWith(it, true) }
                    Text(
                        listOfNotNull(series?.let { s -> r.meta.number?.let { "$s n° $it" } ?: s }, r.title).joinToString(" · "),
                        style = Type.title3, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    Text(stringResource(R.string.reader_page_of, folio, r.pageCount), style = Type.mono, color = C.label2, modifier = Modifier.padding(start = 16.dp))
                }
                val strip = rememberLazyListState(initialFirstVisibleItemIndex = max(0, current.first() - 4))
                LaunchedEffect(current.first()) { strip.animateScrollToItem(max(0, current.first() - 4)) }
                LazyRow(
                    state = strip,
                    reverseLayout = r.rtl,
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
                ) {
                    items(r.pageCount, key = { it }) { i ->
                        LaunchedEffect(i) { r.loadThumb(i) }
                        val bmp = r.thumb(i)
                        val on = i in current
                        Box(
                            Modifier.height(78.dp).width(78.dp * (r.sizes.getOrNull(i)?.aspect ?: 0.68f).coerceIn(0.3f, 1.6f))
                                .tvFocus(RoundedCornerShape(Radius.xs), focusedScale = 1.12f, onClick = { onPick(i) })
                                .background(C.fill2),
                        ) {
                            // The pages on screen stay bright; the rest of the strip recedes.
                            if (bmp != null) Image(remember(bmp) { bmp.asImageBitmap() }, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().alpha(if (on) 1f else 0.5f))
                            if (on) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp).background(C.label))
                        }
                    }
                }
                // Down from the scrubber lands on the first option (or the last one used), not the nearest.
                val opts = remember { FocusRequester() }
                Scrubber(step, steps, r.rtl, scrub, opts, onStep, onClose)
                Row(
                    Modifier.padding(top = 18.dp).focusRequester(opts).focusRestorer().focusGroup(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), content = options,
                )
            }
        }
    }
}

// The page slider: ←/→ step through spreads (mirrored in manga order), OK closes the bar.
@Composable
private fun Scrubber(step: Int, steps: Int, rtl: Boolean, focus: FocusRequester, below: FocusRequester, onStep: (Int) -> Unit, onDone: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    var pressed by remember { mutableStateOf(false) }
    val frac = if (steps <= 1) 1f else step / (steps - 1f)
    val shown by animateFloatAsState(frac, tween(160), label = "scrub")
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(30.dp)
            .focusRequester(focus)
            .focusProperties { down = below }
            .onFocusChanged { focused = it.hasFocus }
            .onKeyEvent { e ->
                when {
                    e.type == KeyEventType.KeyDown && e.key == Key.DirectionLeft -> { onStep(if (rtl) 1 else -1); true }
                    e.type == KeyEventType.KeyDown && e.key == Key.DirectionRight -> { onStep(if (rtl) -1 else 1); true }
                    isSelect(e.key) && e.type == KeyEventType.KeyDown -> { pressed = true; true }
                    isSelect(e.key) && e.type == KeyEventType.KeyUp -> { if (pressed) onDone(); pressed = false; true }
                    else -> false
                }
            }
            .focusable(),
        contentAlignment = Alignment.CenterStart,
    ) {
        val knob = if (focused) 18.dp else 10.dp
        val track = if (focused) 6.dp else 4.dp
        val along = (maxWidth - knob) * (if (rtl) 1f - shown else shown)
        Box(Modifier.fillMaxWidth().height(track).clip(CircleShape).background(Color.White.copy(alpha = 0.22f)))
        Box(
            Modifier.fillMaxWidth(shown.coerceIn(0f, 1f)).height(track).align(if (rtl) Alignment.CenterEnd else Alignment.CenterStart)
                .clip(CircleShape).background(if (focused) Color.White else C.label2),
        )
        Box(Modifier.offset(x = along).size(knob).clip(CircleShape).background(if (focused) Color.White else C.label2))
    }
    Spacer(Modifier.height(2.dp))
}
