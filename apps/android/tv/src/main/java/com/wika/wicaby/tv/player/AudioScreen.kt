package com.wika.wicaby.tv.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.player.PlayQueue
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type

// Music stopgap: a track has no picture, so the player shows its album art (blurred behind, sharp on the left) with
// the title, artist and album, the progress and where it is in the queue. Drawn under the OSD and the key catcher.
@Composable
fun AudioScreen(item: Item, api: Api, position: Long, duration: Long, queue: PlayQueue?, next: Item?) {
    val art = remember(item.id) { Servers.forItem(item, api).poster(item, 720) }
    Box(Modifier.fillMaxSize().background(C.bg)) {
        if (art != null) {
            AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().blur(48.dp).graphicsLayer { alpha = 0.5f })
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Color.Black.copy(alpha = 0.25f), Color.Black.copy(alpha = 0.75f)))))
        Row(
            Modifier.fillMaxSize().padding(horizontal = 96.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(56.dp),
        ) {
            Box(Modifier.size(300.dp).clip(RoundedCornerShape(Radius.lg)).background(C.elevated2), contentAlignment = Alignment.Center) {
                if (art != null) AsyncImage(art, item.album ?: item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else Icon(Ic.Play, null, tint = C.label3, modifier = Modifier.size(64.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(item.name, style = Type.title1, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                item.artistLine.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.title3, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 8.dp)) }
                item.album?.let { Text(it, style = Type.callout, color = C.label3, maxLines = 1, modifier = Modifier.padding(top = 4.dp)) }
                Spacer(Modifier.height(32.dp))
                val f = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(C.fill2)) {
                    Box(Modifier.fillMaxWidth(f).height(4.dp).background(LocalAccent.current))
                }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(clock(position), style = Type.mono, color = C.label2)
                    Text(clock(duration), style = Type.mono, color = C.label3)
                }
                if (queue != null && queue.ids.size > 1) {
                    Spacer(Modifier.height(28.dp))
                    Text("${queue.index + 1} / ${queue.ids.size}", style = Type.eyebrow, color = C.label3)
                    next?.let {
                        Text(
                            "${stringResource(R.string.next_up)} · ${it.name}" + it.artistLine.takeIf { a -> a.isNotEmpty() }?.let { a -> " — $a" }.orEmpty(),
                            style = Type.callout, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
        }
    }
}
