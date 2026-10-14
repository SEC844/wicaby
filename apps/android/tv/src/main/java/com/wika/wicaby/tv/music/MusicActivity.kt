package com.wika.wicaby.tv.music

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent as NativeKeyEvent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.core.music.Repeat
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.TvCanvas
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.goFullscreen
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.WicabyTheme
import com.wika.wicaby.tv.ui.onAccent
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The music now-playing screen (music spec §4.7, MU-09) over the TV's music session (Music). Back returns to browsing
 * and the music plays on (MusicService). It never holds FLAG_KEEP_SCREEN_ON: after 2 min without a key it turns
 * ambient, and the system screensaver may start over it (Dream shows the same ambient layout while music plays).
 */
class MusicActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase)
        AppLanguage.overrideConfiguration(newBase)?.let { applyOverrideConfiguration(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyToCore(this)
        goFullscreen()
        if (Music.session == null) return finish()
        setContent {
            TvCanvas {
                WicabyTheme(Accents[Wicaby.app.accent.coerceIn(Accents.indices)]) {
                    val s = Music.session
                    LaunchedEffect(s, s?.released) { if (s == null || s.released) finish() }
                    if (s != null) NowPlaying(s)
                }
            }
        }
    }

    companion object {
        fun open(context: Context) = context.startActivity(
            Intent(context, MusicActivity::class.java).apply { if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) },
        )
    }
}

@Composable
fun NowPlaying(session: MusicSession) {
    val item = session.current
    val api = session.api
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val art = remember(item) { item?.let { Servers.forItem(it, api).posterArt(it, 720) } }
    // The cover's dominant colour tints the gradient (music spec MU-A3); the next track's cover is fetched ahead (MU-A5).
    val tint by rememberArtColour(art)
    PrefetchNextArt(session, 720)
    var showLyrics by remember { mutableStateOf(false) }
    var ambient by remember { mutableStateOf(false) }
    var pokes by remember { mutableIntStateOf(0) }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(session) {
        while (true) {
            position = session.player.currentPosition
            duration = session.player.duration.coerceAtLeast(0)
            delay(500)
        }
    }
    // 2 min without a key: ambient. Any key brings the screen back (and does nothing else).
    LaunchedEffect(pokes) {
        delay(AMBIENT_AFTER_MS)
        ambient = true
    }
    LaunchedEffect(Unit) { runCatching { playFocus.requestFocus() } }
    LaunchedEffect(item?.id, showLyrics) { if (showLyrics) Music.loadLyrics(session) }
    val noMix = stringResource(R.string.music_mix_none)

    Box(
        Modifier.fillMaxSize().background(C.bg).onPreviewKeyEvent { e ->
            pokes++
            if (ambient) {
                if (e.type == KeyEventType.KeyUp) ambient = false
                return@onPreviewKeyEvent true
            }
            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            // The remote's media keys, wherever the focus is.
            when (e.nativeKeyEvent.keyCode) {
                NativeKeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, NativeKeyEvent.KEYCODE_MEDIA_PLAY, NativeKeyEvent.KEYCODE_MEDIA_PAUSE -> session.playPause()
                NativeKeyEvent.KEYCODE_MEDIA_NEXT -> session.next()
                NativeKeyEvent.KEYCODE_MEDIA_PREVIOUS -> session.previous()
                NativeKeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> session.player.seekTo(session.player.currentPosition + SEEK_MS)
                NativeKeyEvent.KEYCODE_MEDIA_REWIND -> session.player.seekTo((session.player.currentPosition - SEEK_MS).coerceAtLeast(0))
                else -> return@onPreviewKeyEvent false
            }
            true
        },
    ) {
        if (art != null) {
            AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().blur(48.dp).graphicsLayer { alpha = 0.5f })
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(tint?.let { lerp(Color.Black, it, 0.35f).copy(alpha = 0.6f) } ?: Color.Black.copy(alpha = 0.25f), Color.Black.copy(alpha = 0.8f)))))
        Column(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 40.dp, bottom = 24.dp)) {
            Row(Modifier.weight(1f).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                // With the lyrics the art steps aside (it stays behind, blurred): the controls keep their width.
                if (!showLyrics) {
                    Box(Modifier.size(280.dp).clip(RoundedCornerShape(Radius.lg)).background(C.elevated2), contentAlignment = Alignment.Center) {
                        if (art != null) AsyncImage(art, item?.album ?: item?.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        else CoverPlaceholder(item?.album ?: item?.name.orEmpty(), 96.sp)
                    }
                    Spacer(Modifier.width(48.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.music_now_playing), style = Type.eyebrow, color = C.label3)
                    Text(item?.name.orEmpty(), style = Type.title1, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    item?.artistLine?.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.title3, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 6.dp)) }
                    item?.album?.let { Text(it, style = Type.callout, color = C.label3, maxLines = 1, modifier = Modifier.padding(top = 4.dp)) }
                    Spacer(Modifier.height(24.dp))
                    SeekBar(position, duration) { delta -> session.player.seekTo((session.player.currentPosition + delta).coerceIn(0, duration.coerceAtLeast(0))) }
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(clock(position), style = Type.mono, color = C.label2)
                        Text(clock(duration), style = Type.mono, color = C.label3)
                    }
                    Spacer(Modifier.height(20.dp))
                    Controls(session, showLyrics, { showLyrics = !showLyrics }, playFocus) {
                        scope.launch { if (!session.mix()) Toast.makeText(context, noMix, Toast.LENGTH_SHORT).show() }
                    }
                }
                if (showLyrics) {
                    Spacer(Modifier.width(32.dp))
                    LyricsColumn(session, position, Modifier.width(320.dp).fillMaxHeight())
                }
            }
            QueueRow(session)
        }
        AnimatedVisibility(ambient, enter = fadeIn(tween(1200)), exit = fadeOut(tween(300))) { Ambient(session) }
    }
}

@Composable
private fun SeekBar(position: Long, duration: Long, onSeek: (Long) -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val f = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
    val label = stringResource(R.string.music_position)
    Box(
        Modifier.fillMaxWidth().height(20.dp)
            .onFocusChanged { focused = it.isFocused }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> onSeek(-SEEK_MS)
                    Key.DirectionRight -> onSeek(SEEK_MS)
                    else -> return@onKeyEvent false
                }
                true
            }
            .semantics { contentDescription = label }
            .focusable(),
        contentAlignment = Alignment.Center,
    ) {
        val h = if (focused) 8.dp else 4.dp
        Box(Modifier.fillMaxWidth().height(h).clip(CircleShape).background(if (focused) C.fill4 else C.fill2)) {
            Box(Modifier.fillMaxWidth(f).height(h).background(LocalAccent.current))
        }
    }
}

@Composable
private fun Controls(session: MusicSession, lyricsOn: Boolean, onLyrics: () -> Unit, playFocus: FocusRequester, onMix: () -> Unit) {
    val scope = rememberCoroutineScope()
    val q = session.queue
    val item = session.current
    // The heart as the server last answered (the session's track keeps the state it was queued with).
    var favorite by remember(item?.id) { mutableStateOf(item?.userData?.isFavorite == true) }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        CtrlButton(Ic.Previous, stringResource(R.string.music_previous)) { session.previous() }
        CtrlButton(
            if (session.isPlaying) Ic.Pause else Ic.Play, stringResource(if (session.isPlaying) R.string.music_pause else R.string.play),
            primary = true, modifier = Modifier.focusRequester(playFocus).testTag("music-play"),
        ) { session.playPause() }
        CtrlButton(Ic.Next, stringResource(R.string.music_next)) { session.next() }
        CtrlButton(Ic.Shuffle, stringResource(if (q.unshuffled != null) R.string.music_shuffle_on else R.string.music_shuffle_off), on = q.unshuffled != null) { session.toggleShuffle() }
        val (repeatIcon, repeatLabel) = when (q.repeat) {
            Repeat.Off -> Ic.Repeat to R.string.music_repeat_off
            Repeat.All -> Ic.Repeat to R.string.music_repeat_all
            Repeat.One -> Ic.RepeatOne to R.string.music_repeat_one
        }
        CtrlButton(repeatIcon, stringResource(repeatLabel), on = q.repeat != Repeat.Off) { session.cycleRepeat() }
        CtrlButton(if (favorite) Ic.Heart else Ic.HeartOutline, stringResource(R.string.favorite), on = favorite) {
            val it = item ?: return@CtrlButton
            scope.launch { runCatching { session.api.setFavorite(it.id, !favorite) }.onSuccess { favorite = !favorite } }
        }
        CtrlButton(Ic.Mix, stringResource(R.string.music_mix), onClick = onMix)
        CtrlButton(Ic.Lyrics, stringResource(R.string.music_lyrics), Modifier.testTag("music-lyrics-toggle"), on = lyricsOn, onClick = onLyrics)
    }
}

// A round icon button; [on]: a toggle that is set (Graphite: fill-2 behind, the label colour).
@Composable
private fun CtrlButton(icon: ImageVector, label: String, modifier: Modifier = Modifier, primary: Boolean = false, on: Boolean = false, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val accent = LocalAccent.current
    val bg = when {
        focused -> Color.White
        primary -> accent
        on -> C.fill4
        else -> C.fill2
    }
    val fg = when {
        focused -> Color.Black
        primary -> onAccent(accent)
        on -> C.label
        else -> C.label2
    }
    Box(
        modifier.size(if (primary) 56.dp else 44.dp)
            .tvFocus(CircleShape, focusedScale = 1.12f, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(if (primary) 28.dp else 22.dp))
    }
}

@Composable
private fun LyricsColumn(session: MusicSession, position: Long, modifier: Modifier) {
    val id = session.queue.id
    val lyrics = id?.let { Music.lyrics[it] }
    val list = rememberLazyListState()
    val current = lyrics?.let { currentIndex(it, position) } ?: -1
    LaunchedEffect(current) { if (current >= 0) list.animateScrollToItem((current - 2).coerceAtLeast(0)) }
    // Focusable once there are lines: up/down scroll them (plain lyrics do not follow the song), then let focus go on.
    var focused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val step = with(androidx.compose.ui.platform.LocalDensity.current) { 120.dp.toPx() }
    val scrollable = lyrics != null && lyrics.lines.isNotEmpty()
    Box(
        modifier.testTag("music-lyrics")
            .clip(RoundedCornerShape(Radius.md))
            .background(if (focused) C.fill1 else Color.Transparent)
            .onFocusChanged { focused = it.isFocused }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                val by = when {
                    e.key == Key.DirectionUp && list.canScrollBackward -> -step
                    e.key == Key.DirectionDown && list.canScrollForward -> step
                    else -> return@onKeyEvent false
                }
                scope.launch { list.animateScrollBy(by) }
                true
            }
            .focusable(scrollable)
            .padding(horizontal = 12.dp),
    ) {
        when {
            lyrics == null -> Unit
            lyrics.lines.isEmpty() -> Text(stringResource(R.string.music_no_lyrics), style = Type.callout, color = C.label3, modifier = Modifier.align(Alignment.CenterStart))
            else -> LazyColumn(state = list, contentPadding = PaddingValues(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                itemsIndexed(lyrics.lines) { i, line ->
                    Text(
                        line.text.ifEmpty { "♪" }, style = if (lyrics.synced) Type.title3 else Type.body,
                        color = when {
                            !lyrics.synced -> C.label2
                            i == current -> C.label
                            else -> C.label3
                        },
                    )
                }
            }
        }
    }
}

// The queue as a row (music spec §4.7). OK plays an entry; holding OK (or Menu) puts it in edit mode, where ←/→ (or
// ↑/↓) move it, OK or Back is done, and holding OK (or Menu) again takes it out of the queue. Focus never falls off:
// keys follow the entries (not their place), and a removed entry hands focus to its neighbour.
@Composable
private fun QueueRow(session: MusicSession) {
    val q = session.queue
    if (q.ids.isEmpty()) return
    val list = rememberLazyListState()
    var editing by remember { mutableStateOf<Int?>(null) }
    var refocus by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(q.index) { if (editing == null) list.animateScrollToItem(q.index) }
    val ids = q.ids.toList()
    // An id can be queued twice: its nth copy is "id#n", stable while entries move around it.
    val keys = remember(ids) { queueKeys(ids) }
    Column(Modifier.padding(top = 16.dp)) {
        Text(
            stringResource(com.wika.wicaby.core.R.string.queue) + " · " + stringResource(com.wika.wicaby.core.R.string.queue_position, q.index + 1, q.ids.size) +
                (if (editing != null) " · " + stringResource(R.string.music_queue_edit_hint) else ""),
            style = Type.eyebrow, color = C.label3,
        )
        LazyRow(
            state = list, modifier = Modifier.padding(top = 8.dp).testTag("music-queue"),
            horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            itemsIndexed(ids, key = { i, _ -> keys[i] }) { i, id ->
                QueueEntry(
                    session, i, id, editing = editing == i, refocus = refocus == i,
                    onEdit = { on -> editing = if (on) i else null },
                    onMove = { to ->
                        if (to in q.ids.indices) {
                            session.move(i, to)
                            editing = to
                        }
                    },
                    onRemove = {
                        editing = null
                        session.remove(i)
                        // The entry after it slid into its place (the one before when it was the last).
                        refocus = minOf(i, q.ids.size - 1).takeIf { it >= 0 }
                    },
                    onRefocused = { refocus = null },
                )
            }
        }
    }
}

// The LazyRow keys of a queue: "id#n" for the nth copy of an id.
internal fun queueKeys(ids: List<String>): List<String> {
    val seen = HashMap<String, Int>()
    return ids.map { id -> "$id#${(seen[id] ?: 0).plus(1).also { seen[id] = it }}" }
}

@Composable
private fun QueueEntry(
    session: MusicSession, i: Int, id: String, editing: Boolean, refocus: Boolean,
    onEdit: (Boolean) -> Unit, onMove: (Int) -> Unit, onRemove: () -> Unit, onRefocused: () -> Unit,
) {
    val it = session.known[id]
    val playing = i == session.queue.index
    var focused by remember { mutableStateOf(false) }
    // The held OK press that opened edit mode (or removed) is still down: its repeats and release are spent.
    var armed by remember { mutableStateOf(false) }
    val self = remember { FocusRequester() }
    val art = remember(id, it != null) { it?.let { x -> Servers.forItem(x, session.api).poster(x, 160) } }
    LaunchedEffect(refocus) {
        if (!refocus) return@LaunchedEffect
        runCatching { self.requestFocus() }
        onRefocused()
    }
    val editLabel = stringResource(R.string.music_queue_edit)
    Row(
        Modifier.width(220.dp).testTag("music-queue-$i")
            .focusRequester(self)
            .onFocusChanged { f -> if (!f.hasFocus && editing) onEdit(false) }
            .onPreviewKeyEvent { e ->
                val ok = e.key == Key.DirectionCenter || e.key == Key.Enter || e.key == Key.NumPadEnter
                val down = e.type == KeyEventType.KeyDown
                val held = ok && down && e.nativeKeyEvent.repeatCount > 0
                val menu = e.key == Key.Menu && e.type == KeyEventType.KeyUp
                // A held OK acted (edit mode on, or the entry removed): the rest of that press, release included, does
                // nothing more (read from this entry's own state: no frame need pass between the key events).
                if (ok && armed) {
                    if (!down) armed = false
                    return@onPreviewKeyEvent true
                }
                if (held && e.nativeKeyEvent.repeatCount == 1) armed = true
                if (!editing) {
                    return@onPreviewKeyEvent when {
                        held -> true.also { if (armed) onEdit(true) }
                        menu -> true.also { onEdit(true) }
                        else -> false
                    }
                }
                when {
                    held || menu -> onRemove()
                    ok && !down -> onEdit(false)
                    e.key == Key.Back -> if (!down) onEdit(false)
                    !down || ok -> Unit
                    e.key == Key.DirectionLeft || e.key == Key.DirectionUp -> onMove(i - 1)
                    e.key == Key.DirectionRight || e.key == Key.DirectionDown -> onMove(i + 1)
                }
                // Edit mode keeps every key: focus stays on the entry being moved.
                true
            }
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.05f, onFocusChange = { f -> focused = f }) { session.jump(i) }
            .background(if (focused) Color.White else if (playing) C.fill3 else C.fill1)
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(Radius.xs)).background(C.elevated2), contentAlignment = Alignment.Center) {
            if (art != null) AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            if (editing) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                Icon(Ic.Move, editLabel, tint = Color.White, modifier = Modifier.size(22.dp))
            }
        }
        Column(Modifier.padding(start = 10.dp).weight(1f)) {
            Text(it?.name ?: "…", style = Type.callout, color = if (focused) Color.Black else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = if (editing) editLabel else it?.artistLine?.takeIf { a -> a.isNotEmpty() }
            sub?.let { a ->
                Text(a, style = Type.caption, color = if (focused) Color.Black.copy(alpha = 0.6f) else C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (playing) Box(Modifier.size(8.dp).clip(CircleShape).background(LocalAccent.current))
    }
}

private const val SEEK_MS = 10_000L
