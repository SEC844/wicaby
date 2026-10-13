package com.wika.wicaby.tv.ui.photos

import android.os.Build
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.memoryPhotos
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.randomPhotos
import com.wika.wicaby.core.photos.toAsset
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.ClockText
import com.wika.wicaby.tv.ui.Idle
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.delay
import java.util.Calendar
import java.util.Locale

// Photos spec PH-07: the screensaver's photo source (opt-in; film backdrops stay the default). 60 random stills from
// an album or library ([parentId]; null = every photo), or with [memories] those taken on today's day in earlier
// years (random stills when there are none), 9 s each, a 1.6 s crossfade and the ×1.08 drift that also
// moves pixels against burn-in. A portrait photo sits over a dimmed copy of itself. The caption is the date: never a
// place or coordinates (spec §6.1, a screensaver plays to anyone in the room).
@Composable
fun PhotoScreensaver(api: Api, parentId: String?, memories: Boolean = false) {
    val context = LocalContext.current
    val cls = remember { DeviceClassDetector.detect(context, FormFactor.TV) }
    val photos by produceState<List<Photo>>(emptyList(), parentId, memories) {
        value = runCatching {
            (if (memories) api.memoryPhotos(parentId, String.format(Locale.ROOT, "%tF", Calendar.getInstance())) else api.randomPhotos(parentId))
                .map { Photo(toAsset(it), it) }
        }.getOrDefault(emptyList())
    }
    var index by remember { mutableIntStateOf(0) }
    LaunchedEffect(photos) {
        while (photos.isNotEmpty()) {
            delay(9_000)
            index = (index + 1) % photos.size
        }
    }
    val locale = photoLocale()
    Box(Modifier.fillMaxSize().background(Color.Black).testTag("photo-screensaver").pointerInput(Unit) { detectTapGestures { Idle.saver = false; Idle.poke() } }) {
        val p = photos.getOrNull(index)
        Crossfade(p, animationSpec = tween(1600), label = "saver") { q ->
            if (q != null) {
                val zoom = remember(q.asset.id) { Animatable(1f) }
                LaunchedEffect(q.asset.id) { zoom.animateTo(1.08f, tween(11_000, easing = LinearEasing)) }
                val url = viewerRequest(api, q, cls)
                Box(Modifier.fillMaxSize().graphicsLayer { scaleX = zoom.value; scaleY = zoom.value }) {
                    // Coil's memory cache serves the same URL twice. Blur needs API 31; below that, dim only.
                    PhotoImage(q, url, Modifier.fillMaxSize().then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(32.dp) else Modifier).graphicsLayer { alpha = 0.35f }, ContentScale.Crop)
                    PhotoImage(q, url, Modifier.fillMaxSize(), ContentScale.Fit)
                }
            }
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.7f))))
        Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 56.dp, vertical = 40.dp), verticalAlignment = Alignment.Bottom) {
            Text(p?.let { photoDate(it.asset.takenAt, locale) }.orEmpty(), style = Type.title3, color = C.label2, modifier = Modifier.weight(1f).testTag("saver-caption"))
            ClockText()
        }
    }
}
