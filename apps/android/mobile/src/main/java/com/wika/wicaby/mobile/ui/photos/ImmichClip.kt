package com.wika.wicaby.mobile.ui.photos

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.PlayerView
import com.wika.wicaby.core.photos.immichClipPlayer

// An Immich clip over the photo viewer (photos spec PH-13), with the player's own controls; Back closes it. The key
// rides in the header (core ImmichKeyInterceptor), never in the URL.
@Composable
fun ImmichClip(url: String, onClose: () -> Unit) {
    val context = LocalContext.current
    val player = remember(url) { immichClipPlayer(context, url) }
    DisposableEffect(player) { onDispose { player.release() } }
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color.Black).testTag("immich-clip")) {
        AndroidView({ PlayerView(it).apply { this.player = player; isFocusable = true; post { requestFocus() } } }, Modifier.fillMaxSize())
    }
}
