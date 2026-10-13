package com.wika.wicaby.tv.music

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.music.Lyrics
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.ClockText
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.delay

/**
 * The screensaver-friendly layout (music spec §4.7): black, the album art at 25 % opacity drifting 1 px a second (OLED
 * safe, no full-frame animation), the title, the artist and the current lyric line. The now-playing screen switches to
 * it after [AMBIENT_AFTER_MS] without input; the in-app screensaver and the system Dream show it while music plays.
 */
@Composable
fun Ambient(session: MusicSession, modifier: Modifier = Modifier) {
    val item = session.current
    val api = session.api
    val art = remember(item?.id) { item?.let { Servers.forItem(it, api).poster(it, 720) } }
    // A triangle wave, ±DRIFT px, one step a second: the picture never sits still on the same pixels.
    var t by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            t = (t + 1) % (DRIFT * 4)
        }
    }
    val d = (if (t < DRIFT * 2) t - DRIFT else DRIFT * 3 - t).toFloat()
    LaunchedEffect(item?.id) { Music.loadLyrics(session) }
    val lyric = currentLine(item?.id?.let { Music.lyrics[it] }, session.player.currentPosition)
    Box(modifier.fillMaxSize().background(Color.Black).testTag("music-ambient")) {
        Column(
            Modifier.align(Alignment.CenterStart).padding(start = 96.dp).graphicsLayer { translationX = d; translationY = d / 2 },
        ) {
            Box(Modifier.size(260.dp).clip(RoundedCornerShape(Radius.lg)).graphicsLayer { alpha = 0.25f }) {
                if (art != null) AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
            Text(item?.name.orEmpty(), style = Type.title2, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 24.dp))
            item?.artistLine?.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.callout, color = C.label3, maxLines = 1, modifier = Modifier.padding(top = 4.dp)) }
            lyric?.let { Text(it, style = Type.title3, color = C.label2, maxLines = 2, modifier = Modifier.padding(top = 20.dp)) }
        }
        // The clock drifts too, dimmed: nothing bright stays on the same pixels.
        ClockText(Modifier.align(Alignment.BottomEnd).padding(40.dp).graphicsLayer { translationX = -d; translationY = -d / 2; alpha = 0.6f })
    }
}

/** The synced line at [positionMs] (the last one started), null for plain or no lyrics. */
fun currentLine(lyrics: Lyrics?, positionMs: Long): String? {
    if (lyrics == null || !lyrics.synced) return null
    return lyrics.lines.lastOrNull { (it.startMs ?: 0) <= positionMs }?.text?.ifEmpty { null }
}

/** Index of the synced line at [positionMs], -1 before the first. */
fun currentIndex(lyrics: Lyrics, positionMs: Long): Int = if (!lyrics.synced) -1 else lyrics.lines.indexOfLast { (it.startMs ?: 0) <= positionMs }

const val AMBIENT_AFTER_MS = 120_000L
private const val DRIFT = 24
