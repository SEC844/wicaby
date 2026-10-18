package com.wika.wicaby.mobile.reader

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.comics.ComicPages
import com.wika.wicaby.core.comics.ComicReader
import com.wika.wicaby.core.comics.ReaderAwake
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.accentOf
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.GlassIconButton
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.WicabyTheme
import com.wika.wicaby.mobile.ui.ZoomState
import com.wika.wicaby.mobile.ui.zoomable
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// Full-screen CBZ reader: swipe pages (manga order reverses them), pinch and double-tap zoom,
// two-page spreads on landscape tablets, and a vertical strip for webtoons.
class ReaderActivity : AppCompatActivity() {
    companion object {
        private const val EXTRA_ID = "id"
        private const val EXTRA_FROM_START = "fromStart"
        private const val EXTRA_SERVER = "server"

        // server: TP-06, an extra server's id (null = the primary one), as PlayerActivity.
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

    // A comic page is media: the reader stays dark in the light theme (G.media).
    private val media = G.MediaHold()

    override fun onStart() {
        super.onStart()
        media.start()
    }

    override fun onPause() {
        super.onPause()
        if (isFinishing) media.stop()
    }

    override fun onStop() {
        super.onStop()
        media.stop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val server = intent.getStringExtra(EXTRA_SERVER)
        val api = if (server != null) Servers.extraOf(server) else Core.api
        val id = intent.getStringExtra(EXTRA_ID)
        if (api == null || id == null) return finish()
        val r = ComicReader(api, id, keep = 3, scope = lifecycleScope, pixelBudget = 2.5f)
        reader = r
        r.start(intent.getBooleanExtra(EXTRA_FROM_START, false))
        awake.poke()
        immersive()
        setContent {
            val snap by Core.prefs.data.collectAsState(null)
            WicabyTheme(accentOf(snap?.accent ?: 0)) {
                ReaderScreen(r, onExit = ::finish)
            }
        }
    }

    private fun immersive() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    // Back saves the last page (also when the system finishes us, or recreates us on a locale or font change:
    // onCreate opens a new reader, so this one's book and pending save must go now).
    override fun onDestroy() {
        awake.stop()
        reader?.close()
        super.onDestroy()
    }
}

@Composable
private fun ReaderScreen(r: ComicReader, onExit: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (val s = r.state) {
            is ComicReader.State.Loading -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner()
                Text(stringResource(R.string.reader_loading, (s.progress * 100).roundToInt()), style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 16.dp))
            }
            is ComicReader.State.Failed -> Column(
                Modifier.fillMaxSize().padding(horizontal = 32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(r.title, style = Type.title3, color = G.label, textAlign = TextAlign.Center, maxLines = 2)
                Text(s.message, style = Type.body, color = G.label2, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp, bottom = 22.dp))
                PillButton(stringResource(R.string.reader_back), onExit)
            }
            ComicReader.State.Ready -> {
                var chrome by remember { mutableStateOf(false) }
                BackHandler(enabled = chrome) { chrome = false }
                if (r.webtoon) Strip(r, chrome) { chrome = !chrome } else Paged(r, chrome) { chrome = !chrome }
            }
        }
    }
}

@Composable
private fun Paged(r: ComicReader, chrome: Boolean, toggleChrome: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        r.screen = w.toInt() to h.toInt()
        // Spreads only where two pages fit: tablets in landscape.
        val double = LocalConfiguration.current.smallestScreenWidthDp >= 600 && w > h * 1.15f
        val spreads by remember(double) { derivedStateOf { r.spreads(double) } }
        val pager = rememberPagerState(initialPage = ComicPages.spreadOf(spreads, r.page)) { spreads.size }
        val scope = rememberCoroutineScope()
        var zoomed by remember { mutableStateOf(false) }

        // Rotating regroups the pages: stay on the one being read.
        LaunchedEffect(spreads) {
            val want = ComicPages.spreadOf(spreads, r.page)
            if (pager.currentPage != want) pager.scrollToPage(want)
        }
        LaunchedEffect(pager, spreads) {
            snapshotFlow { pager.settledPage }.collect { p -> spreads.getOrNull(p)?.let(r::show) }
        }

        fun side(right: Boolean) {
            val t = (pager.currentPage + if (right != r.rtl) 1 else -1).coerceIn(0, max(0, spreads.size - 1))
            scope.launch { pager.animateScrollToPage(t) }
        }

        HorizontalPager(
            state = pager,
            reverseLayout = r.rtl,
            userScrollEnabled = !zoomed,
            beyondViewportPageCount = 1,
            key = { spreads.getOrNull(it)?.first() ?: it },
            modifier = Modifier.fillMaxSize(),
        ) { p ->
            val spread = spreads.getOrElse(p) { listOf(0) }
            SpreadPage(
                r, spread, w, h, active = p == pager.currentPage,
                onZoom = { if (p == pager.currentPage) zoomed = it },
                onTap = { o ->
                    when {
                        o.x < w / 3f -> side(false)
                        o.x > w * 2f / 3f -> side(true)
                        else -> toggleChrome()
                    }
                },
            )
        }

        val spread = spreads.getOrElse(pager.currentPage) { listOf(r.page) }
        val folio = if (spread.size > 1) "${spread.first() + 1}–${spread.last() + 1}" else "${spread.first() + 1}"
        Chrome(r, chrome, folio, pager.currentPage, spreads.size, onSeek = { scope.launch { pager.scrollToPage(it) } })
    }
}

// One spread, fitted to the screen, zoomable (ui/Zoomable.kt): pinch, double tap, pan while zoomed.
@Composable
private fun SpreadPage(r: ComicReader, spread: List<Int>, w: Float, h: Float, active: Boolean, onZoom: (Boolean) -> Unit, onTap: (Offset) -> Unit) {
    val zoom = remember { ZoomState() }
    LaunchedEffect(active) {
        if (!active) zoom.reset()
    }
    val ratios = spread.map { r.sizes.getOrNull(it)?.aspect ?: 0.68f }
    val sum = ratios.sum()
    val pageH = min(h, w / sum)
    val density = LocalDensity.current
    Box(
        Modifier.fillMaxSize().zoomable(zoom, sum * pageH, pageH, onTap = onTap, onZoom = onZoom),
        contentAlignment = Alignment.Center,
    ) {
        val order = if (r.rtl) spread.reversed() else spread
        Row(Modifier.width(with(density) { (sum * pageH).toDp() }).height(with(density) { pageH.toDp() })) {
            for (i in order) {
                val bmp = r.bitmap(i)
                val m = Modifier.weight(r.sizes.getOrNull(i)?.aspect ?: 0.68f).fillMaxHeight()
                if (bmp != null) Image(remember(bmp) { bmp.asImageBitmap() }, null, contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.Medium, modifier = m)
                else Box(m.background(G.fill1), contentAlignment = Alignment.Center) { Spinner() }
            }
        }
    }
}

// Webtoons: one column across the screen; tap anywhere shows the controls.
@Composable
private fun Strip(r: ComicReader, chrome: Boolean, toggleChrome: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        r.screen = constraints.maxWidth to constraints.maxHeight
        val list = rememberLazyListState(initialFirstVisibleItemIndex = r.page)
        val scope = rememberCoroutineScope()
        // Tablets: a readable column rather than a giant strip.
        val colW = min(maxWidth.value, 720f).dp
        LaunchedEffect(list) {
            snapshotFlow { list.firstVisibleItemIndex to list.canScrollForward }.collect { (first, more) ->
                val last = r.pageCount - 1
                // The last page only counts once the strip cannot go further.
                r.show(list.layoutInfo.visibleItemsInfo.map { it.index }.filter { !more || it != last }.ifEmpty { listOf(first) })
            }
        }
        LazyColumn(
            state = list,
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { toggleChrome() } },
        ) {
            items(r.pageCount, key = { it }) { i ->
                val bmp = r.bitmap(i)
                Box(Modifier.width(colW).aspectRatio(r.sizes.getOrNull(i)?.aspect ?: 0.68f).background(G.fill1)) {
                    if (bmp != null) Image(remember(bmp) { bmp.asImageBitmap() }, null, contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.Medium, modifier = Modifier.fillMaxSize())
                }
            }
        }
        Chrome(r, chrome, "${r.page + 1}", r.page, r.pageCount, onSeek = { scope.launch { list.scrollToItem(it) } })
    }
}

// Top: back and title. Bottom: page count, the slider (mirrored in manga order) and options.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Chrome(r: ComicReader, visible: Boolean, folio: String, step: Int, steps: Int, onSeek: (Int) -> Unit) {
    val activity = LocalActivity.current
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible, enter = fadeIn(tween(180)), exit = fadeOut(tween(160)), modifier = Modifier.align(Alignment.TopCenter)) {
            Row(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
                    .statusBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlassIconButton(Ic.Back, stringResource(R.string.reader_back), { activity?.finish() })
                Text(r.title, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 12.dp).weight(1f))
            }
        }
        AnimatedVisibility(visible, enter = fadeIn(tween(180)), exit = fadeOut(tween(160)), modifier = Modifier.align(Alignment.BottomCenter)) {
            Column(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f))))
                    .navigationBarsPadding().padding(start = 20.dp, end = 20.dp, top = 36.dp, bottom = 14.dp),
            ) {
                Text(stringResource(R.string.reader_page_of, folio, r.pageCount), style = Type.mono, color = G.label2)
                var drag by remember { mutableStateOf<Float?>(null) }
                CompositionLocalProvider(LocalLayoutDirection provides if (r.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr) {
                    Slider(
                        value = drag ?: step.toFloat(),
                        onValueChange = {
                            drag = it
                            onSeek(it.roundToInt())
                        },
                        onValueChangeFinished = { drag = null },
                        valueRange = 0f..max(1, steps - 1).toFloat(),
                        enabled = steps > 1,
                        colors = SliderDefaults.colors(
                            thumbColor = G.label, activeTrackColor = G.label, inactiveTrackColor = G.fill3,
                            disabledThumbColor = G.label3, disabledActiveTrackColor = G.label3,
                        ),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip(stringResource(R.string.reader_rtl), selected = r.rtl, icon = Ic.Check.takeIf { r.rtl }) { r.toggleRtl() }
                    Chip(stringResource(R.string.reader_webtoon), selected = r.webtoon, icon = Ic.Check.takeIf { r.webtoon }) { r.toggleWebtoon() }
                }
            }
        }
    }
}
