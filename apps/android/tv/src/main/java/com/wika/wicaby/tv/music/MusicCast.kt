package com.wika.wicaby.tv.music

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.cast.CastController
import com.wika.wicaby.core.cast.CastRemote
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.cast.DlnaDevice
import com.wika.wicaby.core.cast.DlnaRenderers
import com.wika.wicaby.core.cast.RemoteTargets
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvFocus
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.onAccent
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import com.wika.wicaby.core.R as CR

/**
 * Music to another device from the TV (owner request; the cast spec had the TV send nothing): the player's Cast button
 * sends the queue, from this song and position, to another app's session or a renderer the server drives ("Lire sur…",
 * Sessions API), or to a DLNA renderer this TV finds itself (a speaker, an AV receiver, another TV), which this TV then
 * feeds song after song and reports for (CastController). No Google Cast here: the TV app links no Play services.
 * While it casts, the player shows the device's song with previous, play/pause, next and stop. Main thread.
 */
object TvCasting {
    var target by mutableStateOf<CastTarget?>(null)
        private set
    var remote: CastRemote? = null
        private set

    // Set before the handoff: the player screen stays (as the casting screen) while the music here ends.
    fun start(t: CastTarget, r: CastRemote) {
        target = t
        remote = r
        // A direct cast ends by itself (the end of the queue, the renderer lost).
        if (r is CastController) Core.scope.launch(Dispatchers.Main) {
            r.ended.first { it != null }
            if (remote === r) clear()
        }
    }

    fun clear() {
        target = null
        remote = null
    }

    suspend fun stop() {
        val t = target ?: return
        val r = remote
        clear()
        if (r is CastController) r.stop() else runCatching { r?.transport(t, "Stop") }
    }

    // The queue from [s]'s song and position to [t]: the music here ends once the device plays it, else plays on.
    fun send(context: Context, s: MusicSession, t: CastTarget) = Core.scope.launch(Dispatchers.Main) {
        val api = s.api
        val ids = s.queue.ids.toList()
        val index = s.queue.index
        val id = ids.getOrNull(index) ?: return@launch
        val ok = runCatching {
            val r: CastRemote = if (t.key.startsWith("d:")) {
                val renderer = DlnaRenderers.get(t.key) ?: throw IOException("renderer gone")
                // Reported as this TV's session: the music here stops before the cast's Playing (one DeviceId, §8.4).
                CastController(api, DlnaDevice(renderer), beforePlaying = { withContext(Dispatchers.Main) { Music.release() } })
            } else RemoteTargets(api)
            start(t, r)
            r.play(t, ids, startIndex = index, positionTicks = s.player.currentPosition * TICKS_PER_MS)
            if (!s.released) s.player.pause()
            r.awaitPlaying(t, id)
        }.getOrDefault(false)
        if (ok) {
            if (Music.session === s) Music.release()
            Toast.makeText(context, Core.str(CR.string.cast_started, t.name), Toast.LENGTH_SHORT).show()
        } else {
            if (target == t) clear()
            if (!s.released) s.player.play()
            Toast.makeText(context, Core.str(CR.string.cast_error_unreachable, t.name), Toast.LENGTH_LONG).show()
        }
    }
}

/** "Lire sur…" for a song: the sessions that play audio, then the DLNA renderers found on the network (3 s). */
@Composable
fun CastSheet(session: MusicSession, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val api = session.api
    val item = session.current ?: return onDismiss()
    var sessions by remember { mutableStateOf<List<CastTarget>?>(null) }
    LaunchedEffect(api, item.id) {
        if (!api.server.caps.sessionsRemote) return@LaunchedEffect run { sessions = emptyList() }
        val rt = RemoteTargets(api)
        while (true) {
            runCatching { rt.list(item) }.onSuccess { sessions = it }.onFailure { if (sessions == null) sessions = emptyList() }
            delay(2_000)
        }
    }
    var renderers by remember { mutableStateOf(DlnaRenderers.recent()) }
    var searching by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        if (LocalNetwork.granted(context)) DlnaRenderers.discover(context, emptyList()).collect { r -> renderers = renderers.filter { it.key != r.key } + r }
        searching = false
    }
    val list = sessions.orEmpty()
    // §2.2 dedupe: a renderer the server already drives shows once, as the server's session.
    val found = renderers.filter { r -> list.none { it.kind == CastTarget.Kind.Dlna && it.deviceId.equals(r.key.removePrefix("d:"), true) } }.map { it.target() }
    val rows = (list + found).filter { "Audio" in it.mediaTypes }
    TvSheet(onDismiss, width = 520.dp) {
        Text(stringResource(CR.string.cast_picker_title), style = Type.title3, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp))
        Text(item.name, style = Type.callout, color = C.label2, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        if (rows.isEmpty()) {
            val text = if (searching || sessions == null) CR.string.cast_searching else CR.string.cast_empty
            Text(stringResource(text), style = Type.body, color = C.label2, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        val first = remember { FocusRequester() }
        LaunchedEffect(rows.isNotEmpty()) { if (rows.isNotEmpty()) runCatching { first.requestFocus() } }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            rows.forEachIndexed { i, t ->
                val via = if (t.kind == CastTarget.Kind.Dlna && !t.key.startsWith("d:")) stringResource(CR.string.cast_via_server, t.detail) else t.detail
                val icon = when {
                    t.device == CastTarget.Device.Speaker -> Ic.Speaker
                    t.kind == CastTarget.Kind.Session -> Ic.Phone
                    else -> Ic.Cast
                }
                SheetButton(
                    if (via.isBlank()) t.name else "${t.name} · $via", {
                        onDismiss()
                        TvCasting.send(context.applicationContext, session, t)
                    }, if (i == 0) Modifier.focusRequester(first) else Modifier, icon = icon,
                )
            }
        }
    }
}

/** While the music plays elsewhere: what the device plays, previous, play/pause, next and stop. */
@Composable
fun CastingScreen(t: CastTarget, r: CastRemote) {
    val state by remember(t, r) { r.mirror(t) }.collectAsState(null)
    val playing = state?.session?.nowPlayingItem
    val paused = state?.paused ?: true
    val queue = (state?.session?.nowPlayingQueue?.size ?: 0) > 1
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { playFocus.requestFocus() } }
    fun send(cmd: String) = Core.scope.launch { runCatching { r.transport(t, cmd) } }
    Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(64.dp)) {
            Icon(if (t.device == CastTarget.Device.Speaker) Ic.Speaker else Ic.Cast, null, tint = C.label3, modifier = Modifier.size(40.dp))
            Text(stringResource(CR.string.cast_casting_to, t.name), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(top = 12.dp))
            Text(playing?.name.orEmpty(), style = Type.title1, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
            playing?.artistLine?.takeIf { it.isNotEmpty() }?.let { Text(it, style = Type.title3, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 6.dp)) }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 32.dp)) {
                if (queue) RoundButton(Ic.Previous, stringResource(CR.string.cast_previous)) { send("PreviousTrack") }
                RoundButton(if (paused) Ic.Play else Ic.Pause, stringResource(if (paused) com.wika.wicaby.tv.R.string.play else com.wika.wicaby.tv.R.string.music_pause), Modifier.focusRequester(playFocus), primary = true) { send("PlayPause") }
                if (queue) RoundButton(Ic.Next, stringResource(com.wika.wicaby.tv.R.string.music_next)) { send("NextTrack") }
                RoundButton(Ic.Stop, stringResource(CR.string.cast_stop)) { Core.scope.launch(Dispatchers.Main) { TvCasting.stop() } }
            }
        }
    }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val accent = LocalAccent.current
    Box(
        modifier.size(if (primary) 64.dp else 52.dp)
            .tvFocus(CircleShape, focusedScale = 1.12f, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) TvFocus.bg else if (primary) accent else C.fill2),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (focused) TvFocus.fg else if (primary) onAccent(accent) else C.label2, modifier = Modifier.size(if (primary) 30.dp else 24.dp))
    }
}
