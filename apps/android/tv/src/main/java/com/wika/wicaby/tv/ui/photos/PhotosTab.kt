package com.wika.wicaby.tv.ui.photos

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.allowRgb565
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.livetv.DeviceClass
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSizes
import com.wika.wicaby.core.photos.PhotoSource
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.core.photos.buckets
import com.wika.wicaby.core.photos.photoAlbums
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.photoImage
import com.wika.wicaby.core.photos.quarterTurn
import com.wika.wicaby.core.photos.rotation
import com.wika.wicaby.core.photos.timelineQuery
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.Centered
import com.wika.wicaby.tv.ui.EdgeSpec
import com.wika.wicaby.tv.ui.ErrorState
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.LocalAutoFocus
import com.wika.wicaby.tv.ui.LocalCacheNs
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.dpadEdges
import com.wika.wicaby.tv.ui.dpPx
import com.wika.wicaby.tv.ui.rememberFocusMemory
import com.wika.wicaby.tv.ui.rememberLoad
import com.wika.wicaby.tv.ui.remembered
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.delay

// Photos spec §4.4 (PH-06): a photo library ("photos", or "homevideos" by decision O3) on the TV. Uniform 3:2
// tiles (a justified grid makes D-pad focus wander) under full-width month headers; Page/Channel down and up jump
// a month. Tabs: Chronologie, Albums, Favoris. No map on the TV.
val PHOTO_COLLECTIONS = setOf("photos", "homevideos")

private const val COLUMNS = 6
// The grids start under the header (PhotosTab).
private val CONTENT_TOP = 8.dp

@Composable
fun PhotosTab(api: Api, parentId: String, title: String, top: Dp, album: Boolean = false, onScrolled: (Boolean) -> Unit = {}) {
    var tab by rememberSaveable(parentId) { mutableIntStateOf(0) }
    val nav = LocalNav.current
    val sid = Servers.extraOf(api.server.id)?.server?.id
    var scrolled by remember { mutableStateOf(false) }
    var pillsFocused by remember { mutableStateOf(false) }
    // The top bar hides once the timeline scrolls: the header moves up into its place.
    val headTop by animateDpAsState(if (scrolled && !album) 32.dp else top, label = "photos-header")
    val accent = LocalAccent.current
    Column(Modifier.fillMaxSize()) {
        // The header stays outside the switched content: a tab switch never disposes the focused pill (the focus would
        // fall to the top bar, which selects Home), and the pills stay while a tab loads or fails.
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 48.dp, end = 48.dp, top = headTop, bottom = 4.dp)) {
            Text(title, style = Type.largeTitle, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (!album) Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.onFocusChanged { pillsFocused = it.hasFocus }) {
                listOf(CoreR.string.photos_tab_timeline, CoreR.string.photos_tab_albums, CoreR.string.photos_tab_favorites).forEachIndexed { i, label ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Pill(
                            stringResource(label), selected = tab == i, modifier = Modifier.testTag("photos-tab-$i"),
                            onClick = { if (tab != i) { tab = i; scrolled = false; onScrolled(false) } },
                        )
                        // The selected tab: an accent bar under its pill (fill4 alone is too faint at ten feet).
                        Box(Modifier.padding(top = 6.dp).size(32.dp, 4.dp).background(if (tab == i) accent else Color.Transparent, CircleShape))
                    }
                }
            }
        }
        // While a pill has the focus, the new tab's first tile does not take it.
        CompositionLocalProvider(LocalAutoFocus provides (LocalAutoFocus.current && !pillsFocused)) {
            if (tab == 1) Albums(api, parentId) { nav.push(Route.PhotoAlbum(it.id, it.name, sid)) }
            else Timeline(api, parentId, favorites = tab == 2, { scrolled = it; onScrolled(it) }, onBack = if (album) nav::pop else null)
        }
    }
}

@Composable
private fun Timeline(api: Api, parentId: String, favorites: Boolean, onScrolled: (Boolean) -> Unit, onBack: (() -> Unit)?) {
    val nav = LocalNav.current
    val key = LocalCacheNs.current + "photos-$parentId-$favorites"
    val t = remember(key) { Cache.map.getOrPut(key) { TimelineState() } as TimelineState }
    var nonce by remember { mutableIntStateOf(0) }
    // A load cut short (the tab left mid-paging) resumes here: only a complete timeline is reused (TimelineState).
    LaunchedEffect(t, nonce) { t.load(PhotoSource(api.timelineQuery(parentId, favorites)), force = nonce > 0) }
    val sid = Servers.extraOf(api.server.id)?.server?.id
    when {
        t.failed -> Centered { ErrorState { t.failed = false; nonce++ } }
        t.total < 0 -> Centered { Spinner() }
        else -> PhotoGrid(api, t.photos, CONTENT_TOP, {}, onScrolled, onBack) { nav.push(Route.PhotoView(key, it, sid)) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PhotoGrid(api: Api, photos: List<Photo>, top: Dp, header: @Composable () -> Unit, onScrolled: (Boolean) -> Unit = {}, onBack: (() -> Unit)? = null, onOpen: (Int) -> Unit) {
    val memory = rememberFocusMemory()
    val locale = photoLocale()
    val months = remember(photos) { buckets(photos.map { it.asset.takenAt }) }
    // The bucket of each asset, and each asset's grid index (1 header, then a month header before each month).
    val monthOf = remember(months) { IntArray(photos.size).also { a -> months.forEachIndexed { m, b -> for (i in b.firstIndex until b.firstIndex + b.count) a[i] = m } } }
    fun gridIndex(i: Int) = 2 + monthOf[i] + i
    val grid = rememberLazyGridState()
    LaunchedEffect(grid) { snapshotFlow { grid.firstVisibleItemIndex > 0 || grid.firstVisibleItemScrollOffset > 60 }.collect(onScrolled) }
    var focused by rememberSaveable { mutableIntStateOf(-1) }
    var target by remember { mutableIntStateOf(-1) }
    val targetReq = remember { FocusRequester() }
    LaunchedEffect(target) {
        if (target < 0) return@LaunchedEffect
        grid.scrollToItem(gridIndex(target))
        delay(32)
        if (runCatching { targetReq.requestFocus() }.getOrDefault(false)) target = -1
    }
    // The floating month label, for 1.5 s on each month change.
    var label by remember { mutableStateOf<String?>(null) }
    var lastMonth by remember { mutableIntStateOf(-1) }
    LaunchedEffect(focused) {
        val m = monthOf.getOrNull(focused) ?: return@LaunchedEffect
        if (m == lastMonth) return@LaunchedEffect
        val first = lastMonth < 0
        lastMonth = m
        if (first) return@LaunchedEffect
        label = photoDate("${months[m].key}-01", locale, "LLLL yyyy")
        delay(1_500)
        label = null
    }
    val context = LocalContext.current
    val cls = remember { DeviceClassDetector.detect(context, FormFactor.TV) }
    val margin = with(LocalDensity.current) { 110.dp.toPx() }
    val spec = remember(margin) { EdgeSpec(margin) }

    Box(Modifier.fillMaxSize()) {
        if (photos.isEmpty()) Column(Modifier.padding(start = 48.dp, end = 48.dp, top = top)) {
            header()
            Text(stringResource(CoreR.string.photos_empty), style = Type.title3, color = C.label2, modifier = Modifier.padding(vertical = 24.dp))
            // An empty album has no tile and no tab: something to focus, and a way out besides Back.
            if (onBack != null) {
                val back = remember { FocusRequester() }
                Pill(stringResource(R.string.photos_back), onClick = onBack, modifier = Modifier.focusRequester(back).testTag("photos-back"))
                LaunchedEffect(Unit) { delay(40); runCatching { back.requestFocus() } }
            }
        }
        else CompositionLocalProvider(LocalBringIntoViewSpec provides spec) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(COLUMNS),
                state = grid,
                modifier = Modifier.fillMaxSize().testTag("photo-grid").dpadEdges().onPreviewKeyEvent { e ->
                    // Page/Channel down, or Down held (its first repeat): the next month's first photo; up: this month's
                    // start, or the one before. Further repeats of a held Down are swallowed: one month per hold.
                    val held = e.key == Key.DirectionDown && e.nativeKeyEvent.repeatCount > 0
                    if (held && e.nativeKeyEvent.repeatCount > 1) return@onPreviewKeyEvent true
                    val down = e.key == Key.PageDown || e.key == Key.ChannelDown || held
                    val up = e.key == Key.PageUp || e.key == Key.ChannelUp
                    if (!down && !up || focused < 0) return@onPreviewKeyEvent false
                    if (e.type == KeyEventType.KeyDown) {
                        val m = monthOf[focused]
                        val to = when {
                            down -> months.getOrNull(m + 1)
                            focused > months[m].firstIndex -> months[m]
                            else -> months.getOrNull(m - 1)
                        }
                        if (to != null) target = to.firstIndex
                    }
                    true
                },
                contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = top, bottom = 56.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item("header", span = { GridItemSpan(maxLineSpan) }) {
                    Column {
                        header()
                        Text(pluralStringResource(CoreR.plurals.photos_count, photos.size, photos.size) + " · " + stringResource(R.string.photos_month_jump_hint), style = Type.footnote, color = C.label3)
                    }
                }
                months.forEach { b ->
                    item("m-${b.firstIndex}", span = { GridItemSpan(maxLineSpan) }) {
                        Text(photoDate("${b.key}-01", locale, "LLLL yyyy"), style = Type.title3, color = C.label, modifier = Modifier.padding(top = 12.dp))
                    }
                    items(b.count, key = { photos[b.firstIndex + it].asset.id }) { k ->
                        val i = b.firstIndex + k
                        val p = photos[i]
                        Tile(
                            api, p, cls,
                            Modifier.remembered(memory, p.asset.id, default = i == 0).then(if (i == target) Modifier.focusRequester(targetReq) else Modifier),
                            onFocus = { focused = i },
                        ) { onOpen(i) }
                    }
                }
            }
        }
        AnimatedVisibility(label != null, Modifier.align(Alignment.TopCenter).padding(top = top + 8.dp), enter = fadeIn(), exit = fadeOut()) {
            Text(
                label.orEmpty(), style = Type.title2, color = C.label,
                modifier = Modifier.testTag("month-label").background(C.elevated2, RoundedCornerShape(50)).padding(horizontal = 22.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun Tile(api: Api, p: Photo, cls: DeviceClass, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    val context = LocalContext.current
    BoxWithConstraints(
        modifier.fillMaxWidth().aspectRatio(3f / 2f).testTag("tile-${p.asset.id}")
            .tvFocus(RoundedCornerShape(Radius.xs), focusedScale = 1.05f, onFocusChange = { if (it) onFocus() }, onClick = onClick)
            .background(C.fill2),
    ) {
        // tv-low: 240 px at most, 16-bit (spec §4.4 memory budget).
        val px = PhotoSizes.tvTile(cls, constraints.maxWidth)
        val request = remember(p.asset.id, px) { ImageRequest.Builder(context).data(api.photoImage(p.asset, maxWidth = px)).allowRgb565(cls.isLow).build() }
        PhotoImage(p, request, Modifier.fillMaxSize(), ContentScale.Crop)
    }
}

// The image of [p] in [modifier]'s box, turned by the client when the server did not (spec §3.1 orientation rule).
@Composable
internal fun PhotoImage(p: Photo, model: Any, modifier: Modifier, scale: ContentScale = ContentScale.Fit) {
    var rot by remember(p.asset.id) { mutableIntStateOf(0) }
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        AsyncImage(
            model, null, contentScale = scale,
            onSuccess = { s -> rot = rotation(p.item.imageOrientation, p.item.width ?: 0, p.item.height ?: 0, s.result.image.width, s.result.image.height) },
            modifier = (if (rot % 180 != 0) Modifier.requiredSize(maxHeight, maxWidth) else Modifier.fillMaxSize()).graphicsLayer { rotationZ = rot.toFloat() },
        )
    }
}

// Jellyfin sends the pixels as stored: a quarter-turn photo is asked for in its unturned shape.
internal fun Api.viewerImage(p: Photo, cap: Int): String =
    if (!server.isEmby && quarterTurn(p.item.imageOrientation) != 0) photoImage(p.asset, maxWidth = cap * 9 / 16, maxHeight = cap) else photoImage(p.asset, maxWidth = cap, maxHeight = cap * 9 / 16)

// The viewer and screensaver image: tv-low asks for 1280 px at most and decodes 16-bit (spec §4.4 memory budget).
@Composable
internal fun viewerRequest(api: Api, p: Photo, cls: DeviceClass): ImageRequest {
    val context = LocalContext.current
    return remember(p.asset.id, cls) {
        ImageRequest.Builder(context).data(api.viewerImage(p, PhotoSizes.viewerCap(cls))).allowRgb565(cls.isLow).build()
    }
}

@Composable
private fun Albums(api: Api, parentId: String, onOpen: (Item) -> Unit) {
    val albums by rememberLoad("photo-albums-$parentId") { api.photoAlbums(parentId) }
    val list = albums.value
    val memory = rememberFocusMemory()
    val context = LocalContext.current
    // tv-low: album covers within the tile budget too (240 px).
    val px = PhotoSizes.tvTile(remember { DeviceClassDetector.detect(context, FormFactor.TV) }, dpPx(180.dp))
    LazyVerticalGrid(
        columns = GridCells.Fixed(5),
        modifier = Modifier.fillMaxSize().dpadEdges(),
        contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = CONTENT_TOP + 12.dp, bottom = 56.dp),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        when {
            list == null && albums.error != null -> item("error", span = { GridItemSpan(maxLineSpan) }) { ErrorState { Cache.changed() } }
            list == null -> item("loading", span = { GridItemSpan(maxLineSpan) }) { Spinner() }
            list.isEmpty() -> item("empty", span = { GridItemSpan(maxLineSpan) }) { Text(stringResource(CoreR.string.photos_empty), style = Type.title3, color = C.label2) }
            else -> items(list, key = { it.id }) { a ->
                Column {
                    AsyncImage(
                        a.imageTags["Primary"]?.let { api.image(a.id, "Primary", it, maxWidth = px) }, a.name, contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().aspectRatio(1f).remembered(memory, a.id)
                            .tvFocus(RoundedCornerShape(Radius.md), onClick = { onOpen(a) }).background(C.fill2),
                    )
                    Text(a.name, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
                    a.childCount?.let { Text(pluralStringResource(CoreR.plurals.photos_count, it, it), style = Type.footnote, color = C.label3) }
                }
            }
        }
    }
}

// An album's own timeline (Route.PhotoAlbum).
@Composable
fun PhotoAlbumScreen(api: Api, id: String, name: String) {
    Box(Modifier.fillMaxSize().background(C.bg)) { PhotosTab(api, id, name, top = 48.dp, album = true) }
}

// The UI locale (minSdk 23: no Configuration.locales).
@Composable
internal fun photoLocale(): java.util.Locale = androidx.core.os.ConfigurationCompat.getLocales(LocalConfiguration.current)[0] ?: java.util.Locale.ROOT
