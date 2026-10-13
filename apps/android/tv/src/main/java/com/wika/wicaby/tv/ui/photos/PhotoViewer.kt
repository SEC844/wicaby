package com.wika.wicaby.tv.ui.photos

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.ExifTemplates
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.core.photos.exifOf
import com.wika.wicaby.core.photos.Immich
import com.wika.wicaby.core.photos.photoDetail
import com.wika.wicaby.core.photos.setPhotoFavorite
import com.wika.wicaby.core.photos.formatExif
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.play
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.Idle
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Photos spec §4.4 (PH-06): the full-screen viewer, a route over a loaded timeline (Route.PhotoView). Left/Right:
// previous/next; OK: the controls (Diaporama, Favori, Infos, Zoom…); Up: the info panel; Play/Pause: the slideshow
// (a fade, Ken Burns as an option); Back closes what is open, then the viewer. Zoom ×2 pans with the D-pad.
@Composable
fun PhotoViewerScreen(key: String, index: Int) {
    val api = LocalApi.current ?: return
    val nav = LocalNav.current
    val t = Cache.map[key] as? TimelineState
    if (t == null || t.photos.isEmpty()) return LaunchedEffect(Unit) { nav.pop() }
    PhotoViewer(api, t.photos, index, onClose = { nav.pop() }, onFavorite = { i, on ->
        t.photos = t.photos.toMutableList().also { l -> l[i] = l[i].copy(asset = l[i].asset.copy(favorite = on)) }
    })
}

private val INTERVALS = listOf(3, 5, 10, 20)

@Composable
fun PhotoViewer(
    api: Api,
    photos: List<Photo>,
    start: Int,
    onClose: () -> Unit,
    onFavorite: (Int, Boolean) -> Unit = { _, _ -> },
    seconds: Int = TvSettings.photoInterval.value,
    kenBurns: Boolean = TvSettings.photoKenBurns.value,
) {
    val context = LocalContext.current
    val cls = remember { DeviceClassDetector.detect(context, FormFactor.TV) }
    var index by rememberSaveable { mutableIntStateOf(start.coerceIn(0, photos.size - 1)) }
    var chrome by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    var slideshow by remember { mutableStateOf(false) }
    var zoomed by remember { mutableStateOf(false) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val favs = remember { mutableStateMapOf<String, Boolean>() }
    // An Immich clip plays here, over the viewer (spec PH-13); a server video opens the player.
    var clip by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val root = remember { FocusRequester() }
    val firstPill = remember { FocusRequester() }
    val p = photos[index]
    val fav = favs[p.asset.id] ?: p.asset.favorite

    LaunchedEffect(index) {
        zoomed = false
        pan = Offset.Zero
    }
    var rootFocused by remember { mutableStateOf(false) }
    // The route's enter transition can swallow a first request: retry until the viewer holds focus.
    LaunchedEffect(chrome) {
        delay(16)
        if (chrome) runCatching { firstPill.requestFocus() }
        else repeat(40) {
            if (rootFocused) return@LaunchedEffect
            runCatching { root.requestFocus() }
            delay(50)
        }
    }
    // The slideshow: the next still every few seconds, round the list.
    LaunchedEffect(slideshow, index, seconds) {
        if (!slideshow) return@LaunchedEffect
        // Spec F11: the slideshow keeps the screen awake, the in-app screensaver included.
        Idle.poke()
        delay(seconds * 1000L)
        val next = (1..photos.size).map { (index + it) % photos.size }.firstOrNull { photos[it].asset.kind == "photo" }
        if (next != null) index = next
    }
    val view = LocalView.current
    DisposableEffect(slideshow) {
        view.keepScreenOn = slideshow
        onDispose { view.keepScreenOn = false }
    }
    BackHandler {
        when {
            chrome -> chrome = false
            info -> info = false
            zoomed -> zoomed = false
            slideshow -> slideshow = false
            else -> onClose()
        }
    }
    fun move(d: Int) {
        if (zoomed) {
            // Half the screen at most each way: at ×2 that reaches the edges.
            val step = size.width / 6f
            val o = pan + when (d) { 0 -> Offset(step, 0f); 1 -> Offset(-step, 0f); 2 -> Offset(0f, step); else -> Offset(0f, -step) }
            pan = Offset(o.x.coerceIn(-size.width / 2f, size.width / 2f), o.y.coerceIn(-size.height / 2f, size.height / 2f))
        } else when (d) {
            0 -> if (index > 0) index--
            1 -> if (index < photos.size - 1) index++
            2 -> info = true
            else -> info = false
        }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black).testTag("photo-viewer").onSizeChanged { size = it }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown || chrome) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> move(0)
                    Key.DirectionRight -> move(1)
                    Key.DirectionUp -> move(2)
                    Key.DirectionDown -> move(3)
                    Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> if (p.asset.kind != "video") chrome = true else if (Immich.owns(p.asset)) clip = Immich.client().video(p.asset.id) else play(context, p.item)
                    Key.MediaPlayPause, Key.MediaPlay -> slideshow = !slideshow
                    Key.MediaPause -> slideshow = false
                    else -> return@onKeyEvent false
                }
                true
            }
            .focusRequester(root).onFocusChanged { rootFocused = it.isFocused }.focusable(),
    ) {
        Crossfade(index, animationSpec = tween(if (slideshow) 1600 else 300), label = "photo") { i ->
            val q = photos[i]
            val kb = remember(i) { Animatable(1f) }
            LaunchedEffect(i, slideshow && kenBurns) {
                if (slideshow && kenBurns) kb.animateTo(1.08f, tween(seconds * 1000 + 1600, easing = LinearEasing)) else kb.snapTo(1f)
            }
            PhotoImage(
                q, viewerRequest(api, q, cls),
                Modifier.fillMaxSize().testTag("photo-${q.asset.id}").graphicsLayer {
                    val s = kb.value * if (zoomed && i == index) 2f else 1f
                    scaleX = s
                    scaleY = s
                    if (i == index) {
                        translationX = pan.x
                        translationY = pan.y
                    }
                },
            )
            if (q.asset.kind == "video") Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(72.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Ic.Play, stringResource(CoreR.string.photos_play_video), tint = Color.White, modifier = Modifier.size(32.dp))
                }
            }
        }

        // The date (no place, spec §6.1), with the controls or during the slideshow.
        if (chrome || slideshow) Text(
            photoDate(p.asset.takenAt, photoLocale()), style = Type.title3, color = C.label2,
            modifier = Modifier.align(Alignment.TopStart).padding(horizontal = 56.dp, vertical = 36.dp),
        )
        AnimatedVisibility(chrome, Modifier.align(Alignment.BottomCenter), enter = fadeIn(), exit = fadeOut()) {
            Row(Modifier.padding(bottom = 40.dp).testTag("photo-chrome"), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Pill(
                    stringResource(CoreR.string.photos_slideshow), onClick = { slideshow = !slideshow; chrome = false },
                    icon = if (slideshow) Ic.Pause else Ic.Play, modifier = Modifier.focusRequester(firstPill),
                )
                Pill(
                    stringResource(if (fav) CoreR.string.photos_viewer_unfavorite else CoreR.string.photos_viewer_favorite),
                    onClick = {
                        scope.launch {
                            runCatching { api.setPhotoFavorite(p.asset, !fav) }.onSuccess {
                                favs[p.asset.id] = !fav
                                onFavorite(index, !fav)
                            }
                        }
                    },
                    icon = if (fav) Ic.Heart else Ic.HeartOutline,
                )
                Pill(stringResource(CoreR.string.photos_info), onClick = { info = true; chrome = false }, icon = Ic.Info)
                Pill(stringResource(CoreR.string.photos_zoom) + if (zoomed) " ×1" else " ×2", onClick = { zoomed = !zoomed; chrome = false })
                Pill(
                    stringResource(CoreR.string.photos_slideshow_seconds, seconds),
                    onClick = { TvSettings.photoInterval.value = INTERVALS[(INTERVALS.indexOf(seconds) + 1) % INTERVALS.size] },
                )
                Pill(stringResource(CoreR.string.photos_slideshow_ken_burns), onClick = { TvSettings.photoKenBurns.value = !kenBurns }, selected = kenBurns)
            }
        }
        AnimatedVisibility(info, Modifier.align(Alignment.BottomCenter), enter = slideInVertically { it }, exit = slideOutVertically { it }) {
            InfoPanel(api, p)
        }
        clip?.let {
            ImmichClip(it) {
                clip = null
                root.requestFocus()
            }
        }
    }
}

private val LABELS = mapOf(
    "camera" to CoreR.string.photos_exif_camera, "exposure" to CoreR.string.photos_exif_exposure, "aperture" to CoreR.string.photos_exif_aperture,
    "focal" to CoreR.string.photos_exif_focal, "iso" to CoreR.string.photos_exif_iso, "dimensions" to CoreR.string.photos_exif_dimensions,
    "altitude" to CoreR.string.photos_exif_altitude, "location" to CoreR.string.photos_exif_location, "software" to CoreR.string.photos_exif_software,
)

// The bottom third: the date and the EXIF lines the server has (held in memory only, spec §6.1).
@Composable
private fun InfoPanel(api: Api, p: Photo) {
    val locale = photoLocale()
    val item by produceState(p.item, p.asset.id) { value = runCatching { api.photoDetail(p) }.getOrDefault(p.item) }
    val tpl = ExifTemplates(
        stringResource(CoreR.string.photos_exif_aperture_value), stringResource(CoreR.string.photos_exif_exposure_value),
        stringResource(CoreR.string.photos_exif_focal_value), stringResource(CoreR.string.photos_exif_iso_value),
        stringResource(CoreR.string.photos_exif_dimensions_value), stringResource(CoreR.string.photos_exif_altitude_value),
        stringResource(CoreR.string.photos_exif_location_value),
    )
    val lines = listOf(stringResource(CoreR.string.photos_exif_taken) to photoDate(p.asset.takenAt, locale)) +
        // Immich reports the f-number itself.
        formatExif(exifOf(item), locale.language, tpl, if (Immich.owns(p.asset)) "fnumber" else "hidden").map { (k, v) -> stringResource(LABELS.getValue(k)) to v }
    Column(
        Modifier.fillMaxWidth().background(C.elevated.copy(alpha = 0.94f)).padding(horizontal = 56.dp, vertical = 28.dp).testTag("photo-info"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(CoreR.string.photos_info), style = Type.title3, color = C.label)
        for ((label, value) in lines) Row {
            Text(label, style = Type.footnote, color = C.label2, modifier = Modifier.width(160.dp))
            Text(value, style = Type.mono, color = C.label)
        }
    }
}
