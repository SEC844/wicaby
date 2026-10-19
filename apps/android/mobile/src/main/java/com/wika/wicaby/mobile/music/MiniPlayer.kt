package com.wika.wicaby.mobile.music

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.Type
import kotlinx.coroutines.delay

/** The player's position, read 4 times a second while shown. */
@Composable
fun rememberPosition(s: MusicSession): State<Long> = produceState(s.player.currentPosition, s) {
    while (true) {
        value = s.player.currentPosition
        delay(250)
    }
}

fun MusicSession.durationMs(): Long = player.duration.takeIf { it > 0 } ?: current?.durationMs() ?: 0

/** A round icon button with its spoken label (TalkBack). */
@Composable
fun IconBtn(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, size: Dp = 44.dp, tint: Color = G.label, fill: Color = Color.Transparent) {
    Box(modifier.size(size).clip(CircleShape).background(fill).clickable(role = Role.Button, onClickLabel = null, onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Above the navigation bar while music plays (§4.6): tap or swipe up opens the player, swipe down stops a paused one. */
@Composable
fun MiniPlayerSlot() {
    val s = PlayerHolder.music ?: return
    MiniPlayer(s) { NowPlaying.open = true }
}

@Composable
fun MiniPlayer(s: MusicSession, onOpen: () -> Unit) {
    val item = s.current ?: return
    PrefetchNextArt(s)
    val pos by rememberPosition(s)
    val dur = s.durationMs()
    Column(
        Modifier.fillMaxWidth().background(G.elevated)
            .draggable(rememberDraggableState { }, Orientation.Vertical, onDragStopped = { v -> if (v < -300) onOpen() else if (v > 300 && !s.isPlaying) s.release() })
            .clickable(role = Role.Button, onClick = onOpen),
    ) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(G.fill2)) {
            Box(Modifier.fillMaxWidth(if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f).height(2.dp).background(LocalAccent.current))
        }
        Row(Modifier.fillMaxWidth().height(62.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Art(s.api, item, 44.dp)
            Column(Modifier.weight(1f)) {
                Text(item.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (item.artistLine.isNotEmpty()) Text(item.artistLine, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconBtn(if (s.playOn) Ic.Pause else Ic.Play, stringResource(if (s.playOn) R.string.music_pause else R.string.music_play), s::playPause)
            IconBtn(Ic.Next, stringResource(R.string.music_next), s::next)
        }
    }
}
