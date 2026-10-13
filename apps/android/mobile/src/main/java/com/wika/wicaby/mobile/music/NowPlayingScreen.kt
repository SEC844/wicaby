package com.wika.wicaby.mobile.music

import android.os.Build
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.music.Lyrics
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.core.music.Repeat
import com.wika.wicaby.core.music.lyrics
import com.wika.wicaby.core.music.saveQueueAsPlaylist
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.onAccent
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Over the whole app while open: slides up from the mini player, down to close. */
@Composable
fun MusicOverlay() {
    val s = PlayerHolder.music
    LaunchedEffect(s) { if (s == null) NowPlaying.open = false }
    AnimatedVisibility(NowPlaying.open && s != null, enter = slideInVertically { it }, exit = slideOutVertically { it }) {
        s?.let { NowPlayingScreen(it) { NowPlaying.open = false } }
    }
}

/** The full-screen player (§4.6): blurred art, art, title, heart, seek bar, controls, lyrics and queue sheets. */
@Composable
fun NowPlayingScreen(s: MusicSession, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    val item = s.current
    val api = s.api
    val accent = LocalAccent.current
    val scope = rememberCoroutineScope()
    var sheet by remember { mutableStateOf<Int?>(null) }
    var menu by remember { mutableStateOf<Item?>(null) }
    val pos by rememberPosition(s)
    val dur = s.durationMs()
    var seeking by remember { mutableStateOf<Float?>(null) }
    Box(Modifier.fillMaxSize().background(G.bg)) {
        // Content first (docs/design.md): the art is the only colour. blur() needs API 31; below, the scrim alone.
        if (item != null) {
            val bg = remember(item.id) { api.poster(item, 256) }
            AsyncImage(bg, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().alpha(if (Build.VERSION.SDK_INT >= 31) 0.55f else 0.25f).blur(60.dp))
        }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)))
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBtn(Ic.ChevronDown, stringResource(R.string.music_close), onClose)
                Text(stringResource(R.string.music_now_playing), style = Type.eyebrow, color = G.label2, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                IconBtn(Ic.More, stringResource(R.string.music_options), { menu = item })
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                if (item != null) Art(api, item, minOf(maxWidth, maxHeight, 380.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 16.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(item?.name.orEmpty(), style = Type.title2, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(item?.artistLine.orEmpty(), style = Type.body, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (item != null) {
                    var fav by remember(item.id) { mutableStateOf(item.userData?.isFavorite == true) }
                    IconBtn(
                        if (fav) Ic.HeartFilled else Ic.Heart, stringResource(if (fav) R.string.music_favorite_remove else R.string.music_favorite_add),
                        { scope.launch { runCatching { api.setFavorite(item.id, !fav) }.onSuccess { fav = !fav } } },
                    )
                }
            }
            val label = stringResource(R.string.music_seek)
            Slider(
                value = seeking ?: if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f,
                onValueChange = { seeking = it },
                onValueChangeFinished = { seeking?.let { s.seekTo((it * dur).toLong()) }; seeking = null },
                colors = SliderDefaults.colors(thumbColor = G.label, activeTrackColor = G.label, inactiveTrackColor = G.fill3),
                modifier = Modifier.padding(top = 8.dp).semantics { contentDescription = label },
            )
            Row {
                Text(clock(seeking?.let { (it * dur).toLong() } ?: pos), style = Type.mono, color = G.label2)
                Spacer(Modifier.weight(1f))
                Text(clock(dur), style = Type.mono, color = G.label2)
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                val shuffled = s.queue.unshuffled != null
                IconBtn(Ic.Shuffle, stringResource(if (shuffled) R.string.music_shuffle_on else R.string.music_shuffle_off), s::toggleShuffle, fill = if (shuffled) G.fill3 else Color.Transparent)
                IconBtn(Ic.Previous, stringResource(R.string.music_previous), s::previous, size = 52.dp)
                IconBtn(if (s.isPlaying) Ic.Pause else Ic.Play, stringResource(if (s.isPlaying) R.string.music_pause else R.string.music_play), s::playPause, size = 72.dp, tint = onAccent(accent), fill = accent)
                IconBtn(Ic.Next, stringResource(R.string.music_next), s::next, size = 52.dp)
                val r = s.queue.repeat
                IconBtn(
                    if (r == Repeat.One) Ic.RepeatOne else Ic.Repeat,
                    stringResource(when (r) { Repeat.Off -> R.string.music_repeat_off; Repeat.All -> R.string.music_repeat_all; Repeat.One -> R.string.music_repeat_one }),
                    s::cycleRepeat, fill = if (r != Repeat.Off) G.fill3 else Color.Transparent,
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                IconBtn(Ic.Lyrics, stringResource(R.string.music_lyrics), { sheet = 0 })
                IconBtn(Ic.Queue, stringResource(R.string.music_queue), { sheet = 1 })
            }
        }
    }
    sheet?.let { PlayerSheet(s, it) { sheet = null } }
    menu?.let { TrackMenu(api, it, onDismiss = { menu = null }) }
}

/** Paroles and File d'attente, one bottom sheet with two pages. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlayerSheet(s: MusicSession, first: Int, onDismiss: () -> Unit) {
    var page by remember { mutableIntStateOf(first) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var naming by remember { mutableStateOf(false) }
    val savedText = stringResource(R.string.music_saved_playlist)
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxHeight(0.85f).navigationBarsPadding()) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(stringResource(R.string.music_lyrics), selected = page == 0) { page = 0 }
                Chip(stringResource(R.string.music_queue), selected = page == 1) { page = 1 }
            }
            if (page == 0) {
                val item = s.current
                val lyrics by produceState<Lyrics?>(LOADING, item?.id) {
                    value = item?.let { runCatching { s.api.lyrics(if (s.api.server.isEmby) s.api.item(it.id) else it) }.getOrNull() }
                }
                val pos by rememberPosition(s)
                if (lyrics === LOADING) Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { Spinner() }
                else LyricsPane(lyrics, pos, s::seekTo)
            } else {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { s.clearUpcoming() }) { Text(stringResource(R.string.music_clear_upcoming), color = G.label2) }
                    TextButton(onClick = { naming = true }) { Text(stringResource(R.string.music_save_queue), color = G.label2) }
                }
                QueueList(s.api, s.queue.ids, s.queue.index, s.known, onJump = s::jump, onMove = s::move, onRemove = s::remove)
            }
        }
    }
    if (naming) NameDialog({ naming = false }) { name ->
        naming = false
        scope.launch {
            if (s.api.saveQueueAsPlaylist(name, s.queue.ids.toList()) != null) Toast.makeText(context, savedText.format(name), Toast.LENGTH_SHORT).show()
        }
    }
}

private val LOADING = Lyrics(false, emptyList())

/** The line sung at [positionMs]: the last one that started, -1 before the first. */
fun currentLine(l: Lyrics, positionMs: Long) = if (!l.synced) -1 else l.lines.indexOfLast { (it.startMs ?: 0) <= positionMs }

/** Synced lyrics follow the position (tap a line to go there); plain ones are a text; none, the empty message. */
@Composable
fun LyricsPane(lyrics: Lyrics?, positionMs: Long, onSeek: (Long) -> Unit) {
    if (lyrics == null || lyrics.lines.isEmpty()) {
        return Text(stringResource(R.string.music_no_lyrics), style = Type.body, color = G.label2, modifier = Modifier.padding(24.dp))
    }
    val cur = currentLine(lyrics, positionMs)
    val list = rememberLazyListState()
    LaunchedEffect(cur) { if (cur > 2) list.animateScrollToItem(cur - 2) }
    LazyColumn(state = list, contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp)) {
        itemsIndexed(lyrics.lines) { i, line ->
            val start = line.startMs
            Text(
                line.text.ifEmpty { "♪" },
                style = if (lyrics.synced) Type.title3.copy(fontWeight = if (i == cur) FontWeight.Bold else FontWeight.SemiBold) else Type.body,
                color = if (!lyrics.synced || i == cur) G.label else G.label3,
                modifier = Modifier.fillMaxWidth().padding(vertical = if (lyrics.synced) 6.dp else 1.dp)
                    .semantics { selected = i == cur }
                    .then(if (start != null) Modifier.clickable { onSeek(start) } else Modifier),
            )
        }
    }
}

/**
 * The queue: the current song, then what follows. Long press and drag a row to move it, swipe it away to remove it;
 * TalkBack gets the same as actions (Monter, Descendre, Retirer).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueList(api: Api, ids: List<String>, index: Int, known: Map<String, Item>, onJump: (Int) -> Unit, onMove: (Int, Int) -> Unit, onRemove: (Int) -> Unit) {
    if (ids.isEmpty()) return Text(stringResource(R.string.music_queue_empty), style = Type.body, color = G.label2, modifier = Modifier.padding(24.dp))
    val rowPx = with(LocalDensity.current) { 56.dp.toPx() }
    var dragging by remember { mutableStateOf<Int?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    val up = stringResource(R.string.music_move_up)
    val down = stringResource(R.string.music_move_down)
    val remove = stringResource(R.string.music_remove)
    val upNext = stringResource(R.string.music_up_next)
    LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
        item("now") {
            Text(stringResource(R.string.music_now_playing), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 4.dp))
            known[ids[index]]?.let { TrackRow(api, it, onClick = {}, playing = true) }
            if (index < ids.lastIndex) Text(upNext, style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 20.dp, top = 12.dp, bottom = 4.dp))
        }
        for (i in index + 1 until ids.size) {
            item("$i-${ids[i]}") {
                val t = known[ids[i]] ?: Item(ids[i])
                val swipe = rememberSwipeToDismissBoxState()
                SwipeToDismissBox(
                    swipe,
                    backgroundContent = {
                        Box(Modifier.fillMaxSize().background(G.red).padding(horizontal = 24.dp), contentAlignment = Alignment.CenterEnd) { Icon(Ic.Trash, null, tint = Color.White) }
                    },
                    enableDismissFromStartToEnd = false,
                    onDismiss = { if (it == SwipeToDismissBoxValue.EndToStart) onRemove(i) },
                    modifier = Modifier.zIndex(if (dragging == i) 1f else 0f).graphicsLayer { translationY = if (dragging == i) offset else 0f },
                ) {
                    TrackRow(
                        api, t, onClick = { onJump(i) },
                        modifier = Modifier.background(G.elevated)
                            .pointerInput(i) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = { dragging = i; offset = 0f },
                                    onDrag = { change, d -> change.consume(); offset += d.y },
                                    onDragEnd = {
                                        val to = (i + (offset / rowPx).roundToInt()).coerceIn(index + 1, ids.lastIndex)
                                        dragging = null
                                        if (to != i) onMove(i, to)
                                    },
                                    onDragCancel = { dragging = null },
                                )
                            }
                            .semantics {
                                customActions = listOfNotNull(
                                    CustomAccessibilityAction(up) { onMove(i, i - 1); true }.takeIf { i > index + 1 },
                                    CustomAccessibilityAction(down) { onMove(i, i + 1); true }.takeIf { i < ids.lastIndex },
                                    CustomAccessibilityAction(remove) { onRemove(i); true },
                                )
                            },
                        trailing = { Icon(Ic.Grip, null, tint = G.label3, modifier = Modifier.size(20.dp)) },
                    )
                }
            }
        }
    }
}
