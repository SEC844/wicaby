package com.wika.wicaby.mobile.ui.photos

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSizes
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.Ic
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

// Photos spec F11, §4.3: the stills from [start] on, one every few seconds with a fade (Ken Burns as an option).
// The screen stays on while it runs; a tap shows the controls. Compose UI lives per app: the TV has its own copy
// (shortcut: merge into a shared UI module if a third copy appears).
@Composable
fun Slideshow(api: Api, photos: List<Photo>, start: Int, onExit: (Int) -> Unit) {
    val stills = remember(photos) { photos.indices.filter { photos[it].asset.kind == "photo" } }
    var at by remember { mutableIntStateOf(stills.indexOfFirst { it >= start }.coerceAtLeast(0)) }
    var seconds by rememberSaveable { mutableIntStateOf(5) }
    var kenBurns by rememberSaveable { mutableStateOf(false) }
    var paused by remember { mutableStateOf(false) }
    var controls by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val cap = remember { PhotoSizes.viewerCap(DeviceClassDetector.detect(context, FormFactor.MOBILE)) }
    val view = LocalView.current
    DisposableEffect(view) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }
    fun exit() = onExit(stills.getOrElse(at) { start })
    BackHandler { exit() }
    LaunchedEffect(at, seconds, paused, stills) {
        if (paused || stills.size < 2) return@LaunchedEffect
        delay(seconds * 1000L)
        at = (at + 1) % stills.size
    }

    Box(Modifier.fillMaxSize().background(Color.Black).testTag("photo-slideshow").clickable(null, null) { controls = !controls }) {
        // Compose follows the system animator scale: with animations off the fade is a cut.
        Crossfade(stills.getOrNull(at), animationSpec = tween(900), label = "slideshow") { i ->
            if (i != null) {
                val zoom = remember(i) { Animatable(1f) }
                LaunchedEffect(i, kenBurns) { if (kenBurns) zoom.animateTo(1.08f, tween(seconds * 1000 + 900, easing = LinearEasing)) else zoom.snapTo(1f) }
                PhotoImage(
                    api, photos[i], cap, cap,
                    Modifier.fillMaxSize().graphicsLayer { scaleX = zoom.value; scaleY = zoom.value },
                )
            }
        }
        if (controls) Row(
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().horizontalScroll(rememberScrollState()).padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Chip(stringResource(if (paused) R.string.resume else R.string.pause), selected = false, icon = if (paused) Ic.Play else Ic.Pause) { paused = !paused }
            for (s in listOf(3, 5, 10, 20)) Chip(stringResource(CoreR.string.photos_slideshow_seconds, s), selected = s == seconds) { seconds = s }
            Chip(stringResource(CoreR.string.photos_slideshow_ken_burns), selected = kenBurns) { kenBurns = !kenBurns }
            Chip(stringResource(R.string.close), selected = false, icon = Ic.Close) { exit() }
        }
    }
}
