package com.wika.wicaby.mobile.cast

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.cast.CastRemote
import com.wika.wicaby.core.cast.SessionState
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Group
import com.wika.wicaby.mobile.ui.GroupDivider
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.SelectorRow
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.trackName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import com.wika.wicaby.core.R as CoreR

private val TICKS_10S = 10_000 * TICKS_PER_MS
private val TICKS_30S = 30_000 * TICKS_PER_MS

// The bar at the bottom of the page while casting: what plays where, play/pause, a tap opens the panel.
@Composable
fun MiniController(api: Api, modifier: Modifier = Modifier) {
    val (t, rt) = Casting.of(api) ?: return
    var open by remember { mutableStateOf(false) }
    if (open) return RemotePanel(api, onOther = null, onDismiss = { open = false })
    // Not while the panel mirrors: one SessionsStart per socket.
    val state by remember(t) { rt.mirror(t) }.collectAsState(null)
    val scope = rememberCoroutineScope()
    Row(
        modifier.fillMaxWidth().padding(12.dp).clip(RoundedCornerShape(Radius.lg)).background(G.elevated)
            .clickable(role = Role.Button) { open = true }.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ic.Cast, null, tint = G.label2, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(CoreR.string.cast_casting_to, t.name), style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(state?.session?.nowPlayingItem?.name ?: stringResource(R.string.play_on_waiting), style = Type.body, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val paused = state?.paused ?: true
        RemoteButton(if (paused) Ic.Play else Ic.Pause, stringResource(if (paused) R.string.play else R.string.pause), state?.itemId != null) {
            scope.launch { runCatching { rt.transport(t, "PlayPause") } }
        }
    }
}

// The expanded remote (§2.3): transport and seek always; Next/Previous with a queue; volume, mute, audio and
// subtitles only when the target lists them, otherwise disabled and read "unavailable" by TalkBack.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemotePanel(api: Api, onOther: (() -> Unit)?, onDismiss: () -> Unit) {
    val (t, rt) = Casting.of(api) ?: return onDismiss()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val failed = stringResource(R.string.play_on_failed)
    val state by remember(t) { rt.mirror(t) }.collectAsState(null)
    fun send(block: suspend () -> Unit) {
        scope.launch { if (runCatching { block() }.isFailure) Toast.makeText(context, failed, Toast.LENGTH_SHORT).show() }
    }

    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Remote(api, t, rt, state, ::send)
            Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(CoreR.string.cast_play_here), {
                    onDismiss()
                    // Outlives the sheet, whose scope ends with it.
                    Core.scope.launch(Dispatchers.Main) { Casting.playHere(context, api) }
                }, icon = Ic.Play, modifier = Modifier.weight(1f))
                PillButton(stringResource(CoreR.string.cast_stop), {
                    Core.scope.launch { runCatching { rt.transport(t, "Stop") } }
                    Casting.stop()
                    onDismiss()
                }, icon = Ic.Stop, modifier = Modifier.weight(1f))
            }
            if (onOther != null) {
                Text(
                    stringResource(R.string.play_on_other), style = Type.callout, color = G.label2,
                    modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 16.dp).clip(RoundedCornerShape(50)).clickable(role = Role.Button, onClick = onOther).padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun Remote(api: Api, t: CastTarget, rt: CastRemote, state: SessionState?, send: (suspend () -> Unit) -> Unit) {
    val s = state?.session
    val playing = s?.nowPlayingItem
    val ps = s?.playState
    val durationTicks = playing?.runTimeTicks ?: 0
    val positionTicks = state?.positionTicks ?: 0
    val unavailable = stringResource(CoreR.string.cast_unavailable)
    var drag by remember { mutableStateOf<Float?>(null) }
    // The last Seek sent, shown (and used as the -10/+30 base) until the mirror reports near it or 3 s pass.
    var sentTicks by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(positionTicks) { if (sentTicks?.let { abs(positionTicks - it) < 2_000 * TICKS_PER_MS } == true) sentTicks = null }
    LaunchedEffect(sentTicks) { if (sentTicks != null) { delay(3_000); sentTicks = null } }
    val shownTicks = sentTicks ?: positionTicks
    fun seek(ticks: Long) { sentTicks = ticks; send { rt.transport(t, "Seek", ticks) } }

    Text(stringResource(CoreR.string.cast_casting_to, t.name).uppercase(), style = Type.eyebrow, color = G.label3)
    Text(
        playing?.name ?: stringResource(R.string.play_on_waiting), style = Type.title3, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 6.dp, bottom = 12.dp),
    )
    Slider(
        value = drag ?: (shownTicks / TICKS_PER_MS).toFloat(),
        onValueChange = { drag = it },
        onValueChangeFinished = {
            drag?.let { ms -> seek(ms.toLong() * TICKS_PER_MS) }
            drag = null
        },
        valueRange = 0f..(durationTicks / TICKS_PER_MS).coerceAtLeast(1).toFloat(),
        enabled = playing != null && durationTicks > 0,
        colors = SliderDefaults.colors(thumbColor = G.label, activeTrackColor = G.label, inactiveTrackColor = G.fill3, disabledThumbColor = G.label3, disabledActiveTrackColor = G.label3),
    )
    Row(Modifier.fillMaxWidth()) {
        Text(clock(drag?.toLong() ?: (shownTicks / TICKS_PER_MS)), style = Type.mono, color = G.label2, modifier = Modifier.weight(1f))
        Text(clock(durationTicks / TICKS_PER_MS), style = Type.mono, color = G.label2)
    }
    val on = playing != null
    val queue = on && (s?.nowPlayingQueue?.size ?: 0) > 1
    val paused = state?.paused ?: true
    Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        RemoteButton(Ic.Next, stringResource(CoreR.string.cast_previous), queue, unavailable.takeIf { on }, mirrored = true) { send { rt.transport(t, "PreviousTrack") } }
        RemoteButton(Ic.Back10, stringResource(R.string.play_on_back), on) { seek((shownTicks - TICKS_10S).coerceAtLeast(0)) }
        RemoteButton(if (paused) Ic.Play else Ic.Pause, stringResource(if (paused) R.string.play else R.string.pause), on, primary = true) { send { rt.transport(t, "PlayPause") } }
        RemoteButton(Ic.Fwd10, stringResource(R.string.play_on_forward), on) {
            seek((shownTicks + TICKS_30S).let { if (durationTicks > 0) it.coerceAtMost(durationTicks) else it })
        }
        RemoteButton(Ic.Next, stringResource(R.string.play_on_next), queue, unavailable.takeIf { on }) { send { rt.transport(t, "NextTrack") } }
    }

    // Volume: SetVolume for the slider, Mute/Unmute (or ToggleMute) for the button.
    val muted = ps?.isMuted == true
    val canMute = t.supports(if (muted) "Unmute" else "Mute") || t.supports("ToggleMute")
    val canVolume = t.supports("SetVolume")
    var volume by remember { mutableStateOf<Float?>(null) }
    // Same for the volume: the value sent stays until the mirror echoes it.
    var sentVolume by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(ps?.volumeLevel) { if (sentVolume?.let { abs((ps?.volumeLevel ?: -10) - it) <= 2 } == true) sentVolume = null }
    LaunchedEffect(sentVolume) { if (sentVolume != null) { delay(3_000); sentVolume = null } }
    Row(Modifier.fillMaxWidth().padding(top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        RemoteButton(Ic.Volume, stringResource(if (muted) CoreR.string.cast_unmute else CoreR.string.cast_mute), canMute, unavailable, dim = muted) {
            val name = if (t.supports(if (muted) "Unmute" else "Mute")) (if (muted) "Unmute" else "Mute") else "ToggleMute"
            send { rt.command(t, name) }
        }
        Spacer(Modifier.width(12.dp))
        val label = stringResource(R.string.volume)
        Slider(
            value = volume ?: (sentVolume ?: ps?.volumeLevel ?: 100).toFloat(),
            onValueChange = { volume = it },
            onValueChangeFinished = {
                volume?.let { v -> val n = v.toInt().coerceIn(0, 100); sentVolume = n; send { rt.command(t, "SetVolume", mapOf("Volume" to n.toString())) } }
                volume = null
            },
            valueRange = 0f..100f,
            enabled = canVolume,
            modifier = Modifier.weight(1f).semantics {
                contentDescription = label
                if (!canVolume) stateDescription = unavailable
            },
            colors = SliderDefaults.colors(thumbColor = G.label, activeTrackColor = G.label, inactiveTrackColor = G.fill3, disabledThumbColor = G.label3, disabledActiveTrackColor = G.label3),
        )
    }

    // Audio and subtitle tracks of the version the target plays (one item fetch per item).
    val itemId = playing?.id
    val streams by produceState(emptyList<MediaStream>(), itemId, ps?.mediaSourceId) {
        value = itemId?.let { id ->
            runCatching { api.item(id) }.getOrNull()?.let { item ->
                (item.mediaSources.firstOrNull { it.id == ps?.mediaSourceId } ?: item.mediaSources.firstOrNull())?.mediaStreams
            }
        }.orEmpty()
    }
    val audio = streams.filter { it.type == "Audio" }
    val subs = streams.filter { it.type == "Subtitle" }
    if (audio.size > 1 || subs.isNotEmpty()) {
        Group(Modifier.padding(top = 20.dp)) {
            if (audio.size > 1) {
                SelectorRow(
                    stringResource(R.string.audio), audio.map { trackName(it) }, audio.indexOfFirst { it.index == ps?.audioStreamIndex }.coerceAtLeast(0),
                    unavailable.takeUnless { t.supports("SetAudioStreamIndex") },
                ) { i -> send { rt.command(t, "SetAudioStreamIndex", mapOf("Index" to audio[i].index.toString())) } }
            }
            if (subs.isNotEmpty()) {
                if (audio.size > 1) GroupDivider()
                SelectorRow(
                    stringResource(R.string.subtitles), listOf(stringResource(R.string.subtitles_off)) + subs.map { trackName(it) },
                    subs.indexOfFirst { it.index == ps?.subtitleStreamIndex } + 1,
                    unavailable.takeUnless { t.supports("SetSubtitleStreamIndex") },
                ) { i -> send { rt.command(t, "SetSubtitleStreamIndex", mapOf("Index" to (if (i == 0) -1 else subs[i - 1].index).toString())) } }
            }
        }
    }
}

// [unavailable]: the reason read by TalkBack when the target cannot do it (null: disabled only because nothing plays).
@Composable
private fun RemoteButton(
    icon: ImageVector, label: String, enabled: Boolean, unavailable: String? = null,
    primary: Boolean = false, mirrored: Boolean = false, dim: Boolean = false, onClick: () -> Unit,
) {
    val size = if (primary) 64.dp else 48.dp
    Box(
        Modifier.size(size).clip(CircleShape).background(if (primary) G.label else G.fill2)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .then(if (!enabled && unavailable != null) Modifier.semantics { stateDescription = unavailable } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon, label, tint = if (primary) G.bg else if (enabled && !dim) G.label else G.label3,
            modifier = Modifier.size(if (primary) 28.dp else 22.dp).graphicsLayer { if (mirrored) scaleX = -1f },
        )
    }
}
