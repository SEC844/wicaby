package com.wika.wicaby.mobile.ui.photos

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.AsyncImage
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.ExifTemplates
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSizes
import com.wika.wicaby.core.photos.exifOf
import com.wika.wicaby.core.photos.Immich
import com.wika.wicaby.core.photos.apertureUnit
import com.wika.wicaby.core.photos.photoDetail
import com.wika.wicaby.core.photos.setPhotoFavorite
import com.wika.wicaby.core.photos.formatExif
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.photoImage
import com.wika.wicaby.core.photos.quarterTurn
import com.wika.wicaby.core.photos.rotation
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.GlassIconButton
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.ZoomState
import com.wika.wicaby.mobile.ui.play
import com.wika.wicaby.mobile.ui.zoomable
import kotlinx.coroutines.launch
import kotlin.math.min

// Photos spec §4.3: the full-screen viewer over the timeline. A pager over the list; each page zooms (ui/Zoomable.kt),
// a swipe down closes, a swipe up opens the info panel, a tap shows or hides the controls.

@Composable
fun PhotoViewerDialog(api: Api, photos: List<Photo>, start: Int, onClose: () -> Unit, onFavorite: (Int, Boolean) -> Unit = { _, _ -> }) {
    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        PhotoViewer(api, photos, start, onClose, onFavorite)
    }
}

@Composable
fun PhotoViewer(api: Api, photos: List<Photo>, start: Int, onClose: () -> Unit, onFavorite: (Int, Boolean) -> Unit = { _, _ -> }) {
    val context = LocalContext.current
    val cap = remember { PhotoSizes.viewerCap(DeviceClassDetector.detect(context, FormFactor.MOBILE)) }
    val pager = rememberPagerState(initialPage = start.coerceIn(0, (photos.size - 1).coerceAtLeast(0))) { photos.size }
    val scope = rememberCoroutineScope()
    var chrome by remember { mutableStateOf(true) }
    var info by remember { mutableStateOf(false) }
    var slideshow by remember { mutableStateOf(false) }
    var zoomed by remember { mutableStateOf(false) }
    var drag by remember { mutableFloatStateOf(0f) }
    val favs = remember { mutableStateMapOf<String, Boolean>() }
    // An Immich clip plays here, over the viewer (spec PH-13); a server video opens the player.
    var clip by remember { mutableStateOf<String?>(null) }
    val dismiss = with(LocalDensity.current) { 120.dp.toPx() }
    BackHandler(info) { info = false }
    LaunchedEffect(pager.currentPage) { zoomed = false }

    Box(Modifier.fillMaxSize().background(Color.Black).testTag("photo-viewer")) {
        HorizontalPager(
            state = pager,
            userScrollEnabled = !zoomed,
            beyondViewportPageCount = 1,
            key = { photos[it].asset.id },
            modifier = Modifier.fillMaxSize()
                // Not zoomed: down follows the finger and closes, up opens the info panel.
                .pointerInput(zoomed) {
                    if (zoomed) return@pointerInput
                    detectVerticalDragGestures(
                        onDragEnd = {
                            if (drag > dismiss) onClose() else if (drag < -dismiss / 2) info = true
                            drag = 0f
                        },
                        onDragCancel = { drag = 0f },
                    ) { change, dy ->
                        drag += dy
                        change.consume()
                    }
                }
                .graphicsLayer {
                    translationY = drag.coerceAtLeast(0f)
                    alpha = 1f - (drag / size.height).coerceIn(0f, 0.5f)
                },
        ) { page ->
            val p = photos[page]
            val zoom = remember { ZoomState() }
            LaunchedEffect(pager.currentPage) { if (pager.currentPage != page) zoom.reset() }
            BoxWithConstraints(Modifier.fillMaxSize().testTag("photo-page-${p.asset.id}")) {
                val w = constraints.maxWidth.toFloat()
                val h = constraints.maxHeight.toFloat()
                val a = p.asset.aspect.toFloat()
                val cw = if (w / h > a) h * a else w
                val ch = cw / a
                val px = LocalDensity.current
                Box(
                    Modifier.fillMaxSize().zoomable(zoom, cw, ch, onTap = { chrome = !chrome }, onZoom = { if (page == pager.currentPage) zoomed = it })
                        .testTag("photo-zoom-${p.asset.id}"),
                    contentAlignment = Alignment.Center,
                ) {
                    val box = Modifier.size(with(px) { cw.toDp() }, with(px) { ch.toDp() })
                    PhotoImage(api, p, min(w.toInt(), cap), min(h.toInt(), cap), box)
                    // Past ×2 the current page swaps in a larger rendition (spec §4.3 memory budget).
                    if (zoom.scale > 2f && page == pager.currentPage) PhotoImage(api, p, min(p.item.width ?: cap, PhotoSizes.ZOOM_CAP), min(p.item.height ?: cap, PhotoSizes.ZOOM_CAP), box)
                }
                if (p.asset.kind == "video") {
                    Box(
                        Modifier.align(Alignment.Center).size(72.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape)
                            .clickable(role = Role.Button) { if (Immich.owns(p.asset)) clip = Immich.client().video(p.asset.id) else play(context, p.item) },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Ic.Play, stringResource(CoreR.string.photos_play_video), tint = Color.White, modifier = Modifier.size(32.dp)) }
                }
            }
        }

        val current = photos.getOrNull(pager.currentPage)
        AnimatedVisibility(chrome && current != null, enter = fadeIn(), exit = fadeOut()) {
            val p = current ?: return@AnimatedVisibility
            val fav = favs[p.asset.id] ?: p.asset.favorite
            Box(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    GlassIconButton(Ic.Close, stringResource(R.string.close), onClose)
                    Spacer(Modifier.weight(1f))
                    GlassIconButton(
                        if (fav) Ic.HeartFilled else Ic.Heart,
                        stringResource(if (fav) CoreR.string.photos_viewer_unfavorite else CoreR.string.photos_viewer_favorite),
                        {
                            scope.launch {
                                runCatching { api.setPhotoFavorite(p.asset, !fav) }.onSuccess {
                                    favs[p.asset.id] = !fav
                                    onFavorite(pager.currentPage, !fav)
                                }
                            }
                        },
                    )
                    GlassIconButton(Ic.Info, stringResource(CoreR.string.photos_info), { info = true })
                    GlassIconButton(Ic.Slideshow, stringResource(CoreR.string.photos_slideshow), { slideshow = true })
                }
                Text(
                    photoDate(p.asset.takenAt, LocalConfiguration.current.locales[0]), style = Type.footnote, color = G.label2,
                    modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 16.dp),
                )
            }
        }

        // The info panel: the date and the EXIF lines the server has.
        if (info) Box(Modifier.fillMaxSize().testTag("photo-info-scrim").clickable(null, null) { info = false })
        AnimatedVisibility(info && current != null, Modifier.align(Alignment.BottomCenter), enter = slideInVertically { it }, exit = slideOutVertically { it }) {
            current?.let { InfoPanel(api, it) }
        }

        clip?.let { ImmichClip(it) { clip = null } }

        if (slideshow) Slideshow(api, photos, pager.currentPage) { i ->
            slideshow = false
            scope.launch { pager.scrollToPage(i) }
        }
    }
}

private val LABELS = mapOf(
    "camera" to CoreR.string.photos_exif_camera, "exposure" to CoreR.string.photos_exif_exposure, "aperture" to CoreR.string.photos_exif_aperture,
    "focal" to CoreR.string.photos_exif_focal, "iso" to CoreR.string.photos_exif_iso, "dimensions" to CoreR.string.photos_exif_dimensions,
    "altitude" to CoreR.string.photos_exif_altitude, "location" to CoreR.string.photos_exif_location, "software" to CoreR.string.photos_exif_software,
)

@Composable
private fun InfoPanel(api: Api, p: Photo) {
    val locale = LocalConfiguration.current.locales[0]
    // Gate G3: list answers may lack the EXIF fields; the item's own answer has them. Held in memory only (spec §6.1).
    val item by produceState(p.item, p.asset.id) { value = runCatching { api.photoDetail(p) }.getOrDefault(p.item) }
    val tpl = ExifTemplates(
        stringResource(CoreR.string.photos_exif_aperture_value), stringResource(CoreR.string.photos_exif_exposure_value),
        stringResource(CoreR.string.photos_exif_focal_value), stringResource(CoreR.string.photos_exif_iso_value),
        stringResource(CoreR.string.photos_exif_dimensions_value), stringResource(CoreR.string.photos_exif_altitude_value),
        stringResource(CoreR.string.photos_exif_location_value),
    )
    val lines = listOf(stringResource(CoreR.string.photos_exif_taken) to photoDate(p.asset.takenAt, locale)) +
        // Immich and the photo sources report the f-number itself.
        formatExif(exifOf(item), locale.language, tpl, api.apertureUnit(p.asset)).map { (k, v) -> stringResource(LABELS.getValue(k)) to v }
    Column(
        Modifier.fillMaxWidth().background(G.elevated2, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
            .navigationBarsPadding().padding(20.dp).testTag("photo-info"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(CoreR.string.photos_info), style = Type.title3, color = G.label)
        for ((label, value) in lines) {
            Row {
                Text(label, style = Type.footnote, color = G.label2, modifier = Modifier.width(120.dp))
                Text(value, style = Type.mono, color = G.label)
            }
        }
    }
}

// A photo fitted into [modifier]'s box at most maxW × maxH px, turned by the client when the server did not
// (spec §3.1 orientation rule).
@Composable
internal fun PhotoImage(api: Api, p: Photo, maxW: Int, maxH: Int, modifier: Modifier, scale: ContentScale = ContentScale.Fit) {
    var rot by remember(p.asset.id) { mutableIntStateOf(0) }
    // Jellyfin sends the pixels as stored: a quarter-turn photo is asked for in its unturned shape.
    val swap = !api.server.isEmby && quarterTurn(p.item.imageOrientation) != 0
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        AsyncImage(
            api.photoImage(p.asset, maxWidth = if (swap) maxH else maxW, maxHeight = if (swap) maxW else maxH), null, contentScale = scale,
            onSuccess = { s -> rot = rotation(p.item.imageOrientation, p.item.width ?: 0, p.item.height ?: 0, s.result.image.width, s.result.image.height) },
            modifier = (if (rot % 180 != 0) Modifier.requiredSize(maxHeight, maxWidth) else Modifier.fillMaxSize()).graphicsLayer { rotationZ = rot.toFloat() },
        )
    }
}
