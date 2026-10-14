package com.wika.wicaby.tv.music

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.tv.material3.Text
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.music.MusicArt
import com.wika.wicaby.core.music.MusicSession

// Music covers on the TV (music-feishin-navidrome spec §4.A): the placeholder, the dominant colour and the prefetch.

/** A music item without art: its initials on a colour from its name (MU-A4, core MusicArt). Fills its box. */
@Composable
fun CoverPlaceholder(name: String, fontSize: TextUnit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Color(0xFF000000 or MusicArt.tileRgb(MusicArt.hue(name)).toLong())).testTag("music-art-placeholder"), contentAlignment = Alignment.Center) {
        Text(MusicArt.initials(name), color = Color.White.copy(alpha = 0.92f), fontSize = fontSize, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** The dominant colour of a cover (MU-A3), null until known or when it has none. */
@Composable
fun rememberArtColour(art: Any?): State<Color?> {
    val context = LocalContext.current
    return produceState<Color?>(null, art) {
        value = art?.let { MusicArt.colour(SingletonImageLoader.get(context), context, it) }?.let { Color(0xFF000000 or it.toLong()) }
    }
}

/** The next track's cover at the player's size, fetched ahead so the art switches without a gap (MU-A5). */
@Composable
fun PrefetchNextArt(session: MusicSession, px: Int) {
    val context = LocalContext.current
    val next = session.queue.nextId?.let { session.known[it] }
    LaunchedEffect(next?.id) {
        val n = next ?: return@LaunchedEffect
        Servers.forItem(n, session.api).posterArt(n, px)?.let { SingletonImageLoader.get(context).enqueue(ImageRequest.Builder(context).data(it).build()) }
    }
}
