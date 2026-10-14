package com.wika.wicaby.mobile.player

import android.app.Activity
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.res.pluralStringResource
import com.wika.wicaby.core.data.RemoteSubtitle
import com.wika.wicaby.core.data.SubtitleRules
import com.wika.wicaby.core.player.SubtitleSearch
import com.wika.wicaby.mobile.ui.WicabyField
import android.content.Context
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.provider.Settings
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.Player
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import com.wika.wicaby.core.player.Aspect
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.core.player.AvSync
import com.wika.wicaby.core.player.PlaybackStats
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.data.thumb
import com.wika.wicaby.core.livetv.LiveSession
import com.wika.wicaby.core.livetv.ZapPolicy
import com.wika.wicaby.core.player.Bif
import com.wika.wicaby.core.player.Engine
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.core.player.STILL_WATCHING_AFTER
import com.wika.wicaby.core.player.SegmentKind
import com.wika.wicaby.core.player.SkipRange
import com.wika.wicaby.core.player.SleepTimer
import com.wika.wicaby.core.player.qualityLabel
import com.wika.wicaby.core.player.upNextAt
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.cast.CastButton
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.formatNumber
import com.wika.wicaby.mobile.ui.dpPx
import com.wika.wicaby.mobile.ui.episodeLine
import com.wika.wicaby.mobile.ui.pressScale
import io.github.peerless2012.ass.media.widget.AssSubtitleView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

// Plex mobile default; the TV app waits 15 s.
private const val UP_NEXT_SECONDS = 10
private const val TAP_SEEK_MS = 10_000L

// A full-width horizontal swipe moves this far.
private const val SWIPE_SPAN_MS = 100_000f

private enum class Sheet { Tracks, Speed, Sleep, Quality, SubSearch, Sync }
private enum class Drag { None, Ignore, Seek, Brightness, Volume, Pinch, Zap, MiniGuide }
private class TapSeek(val side: Int, val seconds: Int, val at: Offset, val nonce: Int)
// Text as resource ids: resolved in composition, so they follow the app language.
private class Hud(val icon: ImageVector, val level: Float?, val label: Int? = null, val description: Int? = null)

@Composable
fun PlayerScreen(pb: Playback, engine: Engine, inPip: Boolean, onExit: () -> Unit, onPip: () -> Unit, onExternal: (() -> Unit)? = null) {
    val player = engine.player
    val context = LocalContext.current
    val activity = context as Activity
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var controls by remember { mutableStateOf(true) }
    var nonce by remember { mutableIntStateOf(0) }
    var playing by remember { mutableStateOf(player.isPlaying) }
    var buffering by remember { mutableStateOf(true) }
    val position = remember { mutableLongStateOf(player.currentPosition) }
    val duration = remember { mutableLongStateOf(0L) }
    val buffered = remember { mutableLongStateOf(0L) }
    // Where a drag (screen swipe or scrub bar) would land, shown big in the middle.
    var preview by remember { mutableStateOf<Long?>(null) }
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    var hud by remember { mutableStateOf<Hud?>(null) }
    var hudNonce by remember { mutableIntStateOf(0) }
    var tapSeek by remember { mutableStateOf<TapSeek?>(null) }
    var skipVisible by remember { mutableStateOf(false) }
    var skipNonce by remember { mutableIntStateOf(0) }
    var stillWatching by remember { mutableStateOf(false) }
    var countdown by remember { mutableIntStateOf(UP_NEXT_SECONDS) }
    // X-04 sleep timer (core SleepTimer) and the wall clock for its chip and "Ends at".
    val sleep by SleepTimer.state.collectAsState()
    val now = remember { mutableLongStateOf(System.currentTimeMillis()) }
    val item = pb.item
    // Picture format (Ajuster / Remplir l’écran / Étirer / Zoom), remembered at the scope set in Réglages (X-05).
    var aspect by remember { mutableStateOf(Aspect.of(pb.scopeCtx)) }
    LaunchedEffect(pb.scopeCtx) { aspect = Aspect.of(pb.scopeCtx) }
    val bif by produceState<Bif?>(null, item?.id, pb.offline) {
        value = null
        val id = item?.id ?: return@produceState
        if (!pb.offline) value = Bif.load(pb.api, id)
    }

    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING || state == Player.STATE_IDLE
            }
        }
        player.addListener(l)
        buffering = player.playbackState == Player.STATE_BUFFERING || player.playbackState == Player.STATE_IDLE
        onDispose { player.removeListener(l) }
    }
    val fast by rememberUpdatedState(controls || preview != null)
    LaunchedEffect(player, pb) {
        while (true) {
            position.longValue = player.currentPosition
            duration.longValue = player.duration.takeIf { it > 0 } ?: ((pb.item?.runTimeTicks ?: 0) / TICKS_PER_MS)
            buffered.longValue = player.bufferedPosition
            delay(if (fast) 200 else 500)
        }
    }
    var castSheet by remember { mutableStateOf(false) }
    LaunchedEffect(nonce, playing, sheet, preview, castSheet) {
        if (playing && sheet == null && preview == null && !castSheet) {
            delay(3_500)
            controls = false
        }
    }
    LaunchedEffect(hudNonce) {
        delay(700)
        hud = null
    }
    LaunchedEffect(tapSeek?.nonce) {
        delay(800)
        tapSeek = null
    }

    fun poke() {
        controls = true
        nonce++
        skipNonce++
        pb.autoCount = 0
    }

    // Only these flip when the position ticks; the screen itself does not recompose 5×/s.
    val segment by remember(pb) { derivedStateOf { pb.segments.skippableAt(position.longValue) } }
    // "Passer l'intro" (or the recap, preview, commercial): shown on entering the range, fades
    // after 8 s, back whenever the controls are woken. Each kind follows its own setting.
    val skipMode = segment?.let { SkipSettings.mode(context, it.kind) } ?: SkipSettings.OFF
    val skippable = segment.takeIf { skipMode != SkipSettings.OFF }
    // Auto-skipped once per range: seeking back into it plays it.
    var autoSkipped by remember(item?.id) { mutableStateOf(emptySet<SkipRange>()) }
    LaunchedEffect(skippable) {
        if (skippable != null && skipMode == SkipSettings.AUTO && skippable !in autoSkipped) {
            autoSkipped = autoSkipped + skippable
            player.seekTo(skippable.endMs)
        }
    }
    // The chip keeps its label while it fades out, after the range has passed.
    var chipKind by remember { mutableStateOf(SegmentKind.Intro) }
    LaunchedEffect(skippable, skipNonce) {
        skipVisible = skippable != null && skipMode == SkipSettings.ASK
        skippable?.let { chipKind = it.kind }
        if (skipVisible) {
            delay(8_000)
            skipVisible = false
        }
    }
    val upNext by remember(pb) {
        derivedStateOf {
            val at = upNextAt(duration.longValue, pb.segments.credits)
            pb.next.takeIf { !pb.upNextDismissed && !stillWatching && at != null && position.longValue >= at && position.longValue > 0 }
        }
    }

    fun autoAdvance() {
        if (pb.autoCount >= STILL_WATCHING_AFTER) {
            player.pause()
            stillWatching = true
        } else {
            pb.advance(auto = true)
        }
    }
    LaunchedEffect(upNext?.id) {
        // "End of this video" takes priority over autoplay.
        if (upNext == null || SleepTimer.endOfVideo) return@LaunchedEffect
        val from = pb.item?.id
        var left = UP_NEXT_SECONDS
        countdown = left
        while (left > 0) {
            delay(1_000)
            // The countdown waits while the credits are paused.
            if (player.isPlaying) left--
            countdown = left
        }
        // Screen off, the holder may already have advanced on STATE_ENDED: never skip an episode.
        if (pb.item?.id == from) autoAdvance()
    }
    LaunchedEffect(pb.ended) {
        if (!pb.ended || stillWatching) return@LaunchedEffect
        if (SleepTimer.atEnd()) return@LaunchedEffect // asks "Still watching?" instead of going on
        if (pb.next != null && !pb.upNextDismissed) autoAdvance() else onExit()
    }

    fun seekTo(ms: Long) = player.seekTo(ms.coerceIn(0, duration.longValue.coerceAtLeast(0)))

    LaunchedEffect(sleep != null, controls) {
        while (true) {
            now.longValue = System.currentTimeMillis()
            if (SleepTimer.check(now.longValue) == SleepTimer.Action.EXPIRE) player.pause()
            if (SleepTimer.state.value == null && !controls) break
            delay(1_000)
        }
    }
    fun sleepContinue() {
        SleepTimer.restart()
        if (pb.ended) { if (pb.next != null) pb.advance(auto = false) else onExit() }
    }

    // The OSD button cycles all four; a pinch steps Fit → Fill → Zoom and back to Fit. Both flash the name.
    fun setAspect(a: Aspect) {
        aspect = a
        Aspect.remember(pb.scopeCtx, a)
        hud = Hud(Ic.Scan, null, a.label)
        hudNonce++
    }

    fun togglePlay() {
        if (player.isPlaying) player.pause() else player.play()
        poke()
    }

    // Cast (CA-03 handoff, §2.4): send from here, pause on the 204, close only once the target shows the item;
    // otherwise play on. A channel goes without position, version nor tracks. Not for downloads nor trailers.
    // The queue is this item then the up-next episode (the only queue this player has), StartIndex 0.
    val castApi = pb.api
    // Not for a file source (caps castSend): nothing of it leaves the device.
    val castButton: (@Composable () -> Unit)? = if (item == null || pb.offline || pb.trailer || pb.preview || !castApi.server.caps.castSend) null else {
        {
            CastButton(castApi, item, send = { rt, t ->
                val live = pb.liveState != null
                val id = pb.itemId
                if (live && LiveSession.shared.policy(castApi.server.id) == ZapPolicy.BBM) {
                    // §1 Live TV: this server reported "tuner busy". Release our tuner (Stopped, then the sweep) before the
                    // target tunes; on failure the channel re-tunes here (what "Reprendre ici" does).
                    onExit()
                    LiveSession.shared.sweep()
                    val r = runCatching {
                        rt.play(t, listOf(id), startIndex = 0)
                        rt.awaitPlaying(t, id)
                    }
                    if (r.getOrNull() != true) PlayerActivity.start(context.applicationContext, id, fromStart = false)
                    r.getOrThrow()
                } else {
                    val queue = if (live) listOf(id) else listOfNotNull(id, pb.next?.id?.takeUnless { pb.upNextDismissed })
                    rt.play(
                        t, queue, startIndex = 0, positionTicks = (player.currentPosition * TICKS_PER_MS).takeUnless { live }, msid = pb.sourceId.takeUnless { live },
                        audio = pb.audioIndex.takeUnless { live }, sub = (pb.subtitleIndex ?: -1).takeUnless { live },
                    )
                    player.pause()
                    rt.awaitPlaying(t, id).also { if (!it) player.play() }
                }
            }, onCast = onExit, onSheet = { castSheet = it }) { _, onClick -> RoundIcon(Ic.Cast, stringResource(com.wika.wicaby.core.R.string.cast_button), onClick) }
        }
    }
    BackHandler(enabled = sheet != null) { sheet = null }
    BackHandler(enabled = sheet == null) { onExit() }

    // Swipe gestures: brightness and volume start from the current levels.
    val audio = remember { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    val maxVolume = remember { audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1) }
    val dragState = remember { DragState() }

    // Live (M-2): a horizontal swipe zaps instead of seeking; swipe up from the bottom opens the mini-guide.
    val live by remember(pb) { derivedStateOf { pb.liveState != null } }
    // X-04: the timer belongs to this session. Live has none (its expiry would only pause and keep the
    // tuner; "Fin de ce programme" comes with the M-2 seam), and leaving the session ends it; an
    // activity destroyed while the session plays on in the background keeps it.
    LaunchedEffect(live) { if (live) SleepTimer.cancel() }
    DisposableEffect(pb) { onDispose { if (PlayerHolder.playback !== pb) SleepTimer.cancel() } }
    val zap = remember(pb, live) { if (live) LiveZap.of(context, pb) else null }
    val zapNow by rememberUpdatedState(zap)
    val zapDrag = remember { ZapDrag() }
    var miniGuide by remember { mutableStateOf(false) }
    BackHandler(enabled = miniGuide) { miniGuide = false }
    // Back on the sleep timer's "Still watching?" counts as Continue.
    BackHandler(enabled = sleep?.promptUntil != null) { sleepContinue() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = false
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    subtitleView?.addView(AssSubtitleView(ctx, engine.ass))
                    this.player = player
                }
            },
            update = { it.resizeMode = aspect.resizeMode },
            modifier = Modifier.fillMaxSize().scaledBy(aspect.scale),
        )
        if (inPip) return@Box

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val edge = with(LocalDensity.current) { 40.dp.toPx() }
            Box(
                Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onTap = { at ->
                                val side = if (at.x < size.width * 0.4f) -1 else if (at.x > size.width * 0.6f) 1 else 0
                                val t = tapSeek
                                // Right after a double tap, single taps on the same side keep seeking (YouTube).
                                if (t != null && side == t.side) {
                                    seekTo(player.currentPosition + side * TAP_SEEK_MS)
                                    tapSeek = TapSeek(side, t.seconds + 10, at, t.nonce + 1)
                                } else if (controls && playing) {
                                    controls = false
                                } else {
                                    poke()
                                }
                            },
                            onDoubleTap = { at ->
                                val side = if (at.x < size.width * 0.4f) -1 else if (at.x > size.width * 0.6f) 1 else 0
                                // Live: no timeshift on Android, the sides do nothing.
                                if (side == 0) togglePlay() else if (zapNow == null) {
                                    pb.autoCount = 0
                                    seekTo(player.currentPosition + side * TAP_SEEK_MS)
                                    val t = tapSeek
                                    tapSeek = TapSeek(side, if (t?.side == side) t.seconds + 10 else 10, at, (t?.nonce ?: 0) + 1)
                                }
                            },
                        )
                    }
                    .pointerInput(Unit) {
                        val slop = viewConfiguration.touchSlop
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            var mode = Drag.None
                            var total = Offset.Zero
                            var zoom = 1f
                            while (true) {
                                val ev = awaitPointerEvent()
                                val pressed = ev.changes.filter { it.pressed }
                                if (pressed.isEmpty()) break
                                if (pressed.size >= 2 && (mode == Drag.None || mode == Drag.Pinch)) {
                                    mode = Drag.Pinch
                                    zoom *= ev.calculateZoom()
                                    ev.changes.forEach { it.consume() }
                                    continue
                                }
                                if (mode == Drag.Pinch) continue
                                val c = ev.changes.firstOrNull { it.id == down.id } ?: break
                                if (!c.pressed) break
                                total += c.positionChange()
                                if (mode == Drag.None && total.getDistance() > slop) {
                                    mode = when {
                                        abs(total.x) > abs(total.y) -> when {
                                            zapNow == null -> Drag.Seek
                                            down.position.x in size.width * 0.2f..size.width * 0.8f -> Drag.Zap
                                            else -> Drag.Ignore
                                        }
                                        zapNow != null && total.y < 0 && down.position.y > size.height * 0.8f -> Drag.MiniGuide
                                        // Top and bottom edges belong to the system bars.
                                        down.position.y < edge || down.position.y > size.height - edge -> Drag.Ignore
                                        down.position.x < size.width / 2 -> Drag.Brightness
                                        else -> Drag.Volume
                                    }
                                    dragState.startPos = player.currentPosition
                                    dragState.brightness = activity.window.attributes.screenBrightness.takeIf { it >= 0 }
                                        ?: (Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) / 255f)
                                    dragState.volume = audio.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / maxVolume
                                    dragState.lastY = 0f
                                }
                                if (mode == Drag.None || mode == Drag.Ignore) continue
                                c.consume()
                                pb.autoCount = 0
                                when (mode) {
                                    Drag.Zap -> zapDrag.move(zapNow ?: break, total.x, c)
                                    Drag.Seek -> preview = (dragState.startPos + total.x / size.width * SWIPE_SPAN_MS).toLong().coerceIn(0, duration.longValue.coerceAtLeast(0))
                                    Drag.Brightness -> {
                                        dragState.brightness = (dragState.brightness - (total.y - dragState.lastY) / (size.height * 0.8f)).coerceIn(0.01f, 1f)
                                        activity.window.attributes = activity.window.attributes.apply { screenBrightness = dragState.brightness }
                                        hud = Hud(Ic.Sun, dragState.brightness, description = R.string.brightness)
                                        hudNonce++
                                    }
                                    Drag.Volume -> {
                                        dragState.volume = (dragState.volume - (total.y - dragState.lastY) / (size.height * 0.8f)).coerceIn(0f, 1f)
                                        // No FLAG_PLAY_SOUND, no system UI: the HUD is the feedback.
                                        audio.setStreamVolume(AudioManager.STREAM_MUSIC, (dragState.volume * maxVolume).roundToInt(), 0)
                                        hud = Hud(Ic.Volume, dragState.volume, description = R.string.volume)
                                        hudNonce++
                                    }
                                    else -> {}
                                }
                                dragState.lastY = total.y
                            }
                            when (mode) {
                                Drag.Seek -> preview?.let {
                                    seekTo(it)
                                    preview = null
                                }
                                Drag.Zap -> zapDrag.end(size.width.toFloat(), density).takeIf { it != 0 }?.let { zapNow?.press(it) }
                                Drag.MiniGuide -> if (total.y < -size.height * 0.1f) miniGuide = true
                                Drag.Pinch -> if (zoom > 1.08f || zoom < 0.92f) {
                                    setAspect(aspect.pinch(out = zoom > 1f))
                                }
                                else -> {}
                            }
                        }
                    },
            )

            tapSeek?.let { t -> TapSeekRipple(t, maxWidth) }
        }

        // B03: "Reconnexion…" under the spinner while a dropped stream reloads.
        val notice = pb.notice
        if ((buffering || notice != null) && pb.error == null && preview == null) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(Modifier.size(44.dp), G.label)
                if (notice != null) Text(notice, style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 12.dp))
            }
        }

        pb.error?.let { msg ->
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(msg, style = Type.title2, color = G.label)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillButton(stringResource(R.string.back), onExit)
                    // Live retunes on its own (LiveOverlay).
                    if (!live && item != null) PillButton(stringResource(R.string.retry), pb::retry)
                    // Codecs Media3 cannot play: VLC or MX Player may.
                    if (onExternal != null && item != null) PillButton(stringResource(com.wika.wicaby.core.R.string.external_player_open), onExternal, icon = Ic.External)
                }
            }
        }

        if (PlaybackStats.visible && preview == null) StatsOverlay(pb, Modifier.align(Alignment.TopStart).windowInsetsPadding(WindowInsets.displayCutout).padding(start = 16.dp, top = 72.dp))

        // Not over an error: its own message and Back button sit where the transport controls are.
        AnimatedVisibility(controls && item != null && preview == null && pb.error == null || sheet != null || castSheet, enter = fadeIn(tween(200)), exit = fadeOut(tween(320))) {
            if (item != null) {
                Osd(
                    item, playing, { position.longValue }, { duration.longValue }, { buffered.longValue },
                    onBack = onExit, onTracks = { sheet = Sheet.Tracks }, onSpeed = { sheet = Sheet.Speed }, onPip = onPip,
                    onSleep = if (live) null else { { sheet = Sheet.Sleep } },
                    onQuality = if (pb.canSwitchQuality) { { sheet = Sheet.Quality } } else null, qualityCap = pb.qualityCap,
                    sleepLeft = sleep?.endsAt?.let { (it - now.longValue).coerceAtLeast(0) },
                    now = { now.longValue }, speed = { player.playbackParameters.speed }, live = live,
                    aspect = aspect, onAspect = { setAspect(aspect.next()); poke() },
                    onPlayPause = ::togglePlay,
                    onSeekBy = { d ->
                        seekTo(player.currentPosition + d)
                        poke()
                    },
                    onNext = pb.next?.let { { pb.advance(auto = false) } },
                    onScrub = { preview = it },
                    onScrubEnd = {
                        preview?.let { seekTo(it) }
                        preview = null
                        poke()
                    },
                    offline = pb.offline,
                    cast = castButton,
                )
            }
        }

        preview?.let { SeekPreview(it, it - position.longValue, bif, Modifier.align(Alignment.Center)) }

        hud?.let { h -> LevelHud(h, Modifier.align(Alignment.TopCenter).padding(top = 28.dp)) }

        LiveLayer(pb, zap, zapDrag, controls && sheet == null, miniGuide, { miniGuide = it; poke() })

        // Above the scrub bar while the controls show.
        val cornerBottom = if (controls) 104.dp else 28.dp
        AnimatedVisibility(
            skipVisible && upNext == null && sheet == null,
            enter = fadeIn(tween(220)), exit = fadeOut(tween(500)),
            modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.displayCutout).padding(end = 24.dp, bottom = cornerBottom),
        ) {
            val label = when (chipKind) {
                SegmentKind.Recap -> com.wika.wicaby.core.R.string.skip_recap
                SegmentKind.Preview -> com.wika.wicaby.core.R.string.skip_preview
                SegmentKind.Commercial -> com.wika.wicaby.core.R.string.skip_commercial
                SegmentKind.Intro -> R.string.skip_intro
            }
            ActionChip(stringResource(label)) {
                skippable?.let { seekTo(it.endMs) }
                skipVisible = false
            }
        }
        AnimatedVisibility(
            upNext != null && sheet == null,
            enter = fadeIn(tween(260)) + slideInVertically(tween(320)) { it / 4 }, exit = fadeOut(tween(200)),
            modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.displayCutout).padding(end = 24.dp, bottom = cornerBottom),
        ) {
            upNext?.let { UpNextCard(pb.api, it, countdown, onPlay = { pb.advance(auto = false) }, onDismiss = { pb.upNextDismissed = true }) }
        }

        PlayerSheet(sheet == Sheet.Tracks, { sheet = null }) { TracksSheet(pb, onSearch = { sheet = Sheet.SubSearch }, onSync = { sheet = Sheet.Sync }) }
        PlayerSheet(sheet == Sheet.Sync, { sheet = null }) { SyncSheet(pb) }
        PlayerSheet(sheet == Sheet.SubSearch, { sheet = null }) { SubtitleSearchSheet(pb) { sheet = null } }
        PlayerSheet(sheet == Sheet.Speed, { sheet = null }) {
            SpeedSheet(player.playbackParameters.speed) {
                pb.setSpeed(it)
                sheet = null
            }
        }

        PlayerSheet(sheet == Sheet.Sleep, { sheet = null }) {
            SleepSheet(sleep) { sheet = null }
        }
        PlayerSheet(sheet == Sheet.Quality, { sheet = null }) {
            QualitySheet(pb) { sheet = null }
        }

        sleep?.promptUntil?.takeIf { !stillWatching }?.let { until ->
            StillWatching(
                onContinue = ::sleepContinue,
                onStop = {
                    SleepTimer.cancel()
                    player.pause()
                },
                sub = stringResource(com.wika.wicaby.core.R.string.still_watching_pausing_in, ((until - now.longValue + 999) / 1000).coerceAtLeast(0)),
                stopLabel = stringResource(com.wika.wicaby.core.R.string.sleep_pause),
            )
        }

        if (stillWatching) {
            StillWatching(
                onContinue = {
                    stillWatching = false
                    pb.autoCount = 0
                    if (pb.next != null) pb.advance(auto = false) else player.play()
                },
                onStop = onExit,
            )
        }
    }
}

private class DragState {
    var startPos = 0L
    var brightness = 0.5f
    var volume = 0.5f
    var lastY = 0f
}

// Double-tap feedback: a soft lobe on that side with an expanding ring from the finger.
@Composable
private fun BoxScope.TapSeekRipple(t: TapSeek, width: androidx.compose.ui.unit.Dp) {
    val ring = remember(t.nonce) { Animatable(0f) }
    LaunchedEffect(t.nonce) { ring.animateTo(1f, tween(450)) }
    val left = t.side < 0
    val shape = if (left) RoundedCornerShape(topEndPercent = 50, bottomEndPercent = 50) else RoundedCornerShape(topStartPercent = 50, bottomStartPercent = 50)
    Box(
        Modifier.align(if (left) Alignment.CenterStart else Alignment.CenterEnd).fillMaxHeight().width(width * 0.4f).clip(shape).background(Color.White.copy(alpha = 0.08f)),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val origin = if (left) t.at else Offset(t.at.x - (this.size.width / 0.4f * 0.6f), t.at.y)
            drawCircle(Color.White.copy(alpha = 0.16f * (1f - ring.value)), radius = this.size.height * 0.6f * ring.value, center = origin)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(if (left) Ic.Rewind else Ic.Forward, null, tint = Color.White, modifier = Modifier.size(28.dp))
            Text(stringResource(if (left) R.string.seek_back_seconds else R.string.seek_forward_seconds, t.seconds), style = Type.callout, color = Color.White)
        }
    }
}

@Composable
private fun LevelHud(h: Hud, modifier: Modifier) {
    Row(
        modifier.clip(CircleShape).background(G.elevated.copy(alpha = 0.92f)).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(h.icon, h.description?.let { stringResource(it) }, tint = G.label, modifier = Modifier.size(20.dp))
        if (h.level != null) {
            Box(Modifier.width(140.dp).height(4.dp).clip(CircleShape).background(G.fill4)) {
                Box(Modifier.fillMaxWidth(h.level).fillMaxHeight().background(G.label))
            }
        }
        if (h.label != null) Text(stringResource(h.label), style = Type.callout, color = G.label)
    }
}

@Composable
private fun SeekPreview(ms: Long, delta: Long, bif: Bif?, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (bif != null) BifThumb(bif, ms)
        Column(
            Modifier.padding(top = 10.dp).clip(RoundedCornerShape(Radius.md)).background(G.elevated.copy(alpha = 0.88f)).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(clock(ms), style = Type.mono.copy(fontSize = 26.sp, lineHeight = 30.sp), color = Color.White)
            Text(stringResource(if (delta >= 0) R.string.seek_delta_forward else R.string.seek_delta_back, clock(abs(delta))), style = Type.mono, color = G.label2)
        }
    }
}

// Emby trickplay frame for [ms]; keeps the previous frame up while the next one decodes.
@Composable
private fun BifThumb(bif: Bif, ms: Long) {
    val index = bif.indexAt(ms) ?: return
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(index) {
        frame = withContext(Dispatchers.Default) { bif.jpeg(index)?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } } ?: frame
    }
    val f = frame ?: return
    Image(
        f, null, contentScale = ContentScale.Crop,
        modifier = Modifier.width(220.dp).aspectRatio(f.width.toFloat() / f.height.coerceAtLeast(1)).clip(RoundedCornerShape(Radius.sm)).background(G.elevated2),
    )
}

@Composable
private fun RoundIcon(icon: ImageVector, description: String?, onClick: () -> Unit, size: Int = 44, iconSize: Int = 22, fill: Color = Color.Transparent, label: String? = null, on: Boolean? = null) {
    val source = remember { MutableInteractionSource() }
    // [on]: a toggle, lit while on (and announced as selected).
    Box(
        Modifier.size(size.dp).pressScale(source).clip(CircleShape).background(if (on == true) Color.White.copy(alpha = 0.22f) else fill)
            .clickable(source, null, role = Role.Button, onClick = onClick).semantics { if (on != null) selected = on },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = Color.White, modifier = Modifier.size(iconSize.dp))
        if (label != null) Text(label, style = Type.caption.copy(fontSize = 9.sp), color = Color.White, modifier = Modifier.offset(y = 1.dp))
    }
}

@Composable
private fun Osd(
    item: Item,
    playing: Boolean,
    position: () -> Long,
    duration: () -> Long,
    buffered: () -> Long,
    onBack: () -> Unit,
    onTracks: () -> Unit,
    onSpeed: () -> Unit,
    onPip: () -> Unit,
    onPlayPause: () -> Unit,
    onSeekBy: (Long) -> Unit,
    onNext: (() -> Unit)?,
    onScrub: (Long) -> Unit,
    onScrubEnd: () -> Unit,
    offline: Boolean,
    aspect: Aspect,
    onAspect: () -> Unit,
    onSleep: (() -> Unit)?,
    sleepLeft: Long?,
    now: () -> Long,
    speed: () -> Float,
    live: Boolean,
    onQuality: (() -> Unit)?,
    qualityCap: Int?,
    cast: (@Composable () -> Unit)?,
) {
    Box(Modifier.fillMaxSize()) {
        // Video scrims (content, not chrome): keep the white controls legible on bright frames.
        Box(Modifier.fillMaxWidth().height(130.dp).background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.62f), Color.Transparent))))
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(170.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.72f)))))
        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.displayCutout).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundIcon(Ic.Back, stringResource(R.string.back), onBack)
            Column(Modifier.weight(1f).padding(start = 6.dp, end = 12.dp)) {
                val eyebrow = if (item.isEpisode) item.seriesName else item.productionYear?.toString()
                val title = if (item.isEpisode) episodeLine(item) ?: item.name else item.name
                if (eyebrow != null) Text(if (offline) stringResource(R.string.eyebrow_offline, eyebrow) else eyebrow, style = Type.footnote, color = G.label2, maxLines = 1)
                Text(title, style = Type.headline, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (onNext != null) RoundIcon(Ic.Next, stringResource(R.string.up_next), onNext, iconSize = 18)
            RoundIcon(Ic.Captions, stringResource(R.string.subtitles), onTracks)
            // Playback info: the stats panel (top left); stays on for the next videos.
            RoundIcon(Ic.Info, stringResource(com.wika.wicaby.core.R.string.stats_title), { PlaybackStats.visible = !PlaybackStats.visible }, on = PlaybackStats.visible)
            RoundIcon(Ic.Gauge, stringResource(com.wika.wicaby.core.R.string.speed), onSpeed)
            RoundIcon(Ic.Scan, stringResource(com.wika.wicaby.core.R.string.aspect_value, stringResource(aspect.label)), onAspect)
            // X-02: the gear plus the current label ("Originale", "720p · 2 Mb/s").
            if (onQuality != null) {
                val source = remember { MutableInteractionSource() }
                Row(
                    Modifier.height(44.dp).pressScale(source).clip(CircleShape).clickable(source, null, role = Role.Button, onClick = onQuality).padding(horizontal = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Ic.Settings, stringResource(com.wika.wicaby.core.R.string.quality), tint = Color.White, modifier = Modifier.size(22.dp))
                    Text(qualityLabel(LocalContext.current, qualityCap), style = Type.footnote, color = Color.White, maxLines = 1)
                }
            }
            if (onSleep != null) {
                val name = stringResource(com.wika.wicaby.core.R.string.sleep_timer)
                RoundIcon(MoonIcon, listOfNotNull(name, sleepLeft?.let { clock(it) }).joinToString(", "), onSleep, label = sleepLeft?.let { clock(it) })
            }
            cast?.invoke()
            RoundIcon(Ic.Pip, stringResource(R.string.pip), onPip)
        }
        Row(Modifier.align(Alignment.Center), horizontalArrangement = Arrangement.spacedBy(44.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundIcon(Ic.Back10, stringResource(R.string.rewind_10), { onSeekBy(-TAP_SEEK_MS) }, size = 56, iconSize = 30, label = formatNumber(TAP_SEEK_MS / 1000))
            RoundIcon(if (playing) Ic.Pause else Ic.Play, stringResource(if (playing) R.string.pause else R.string.play), onPlayPause, size = 76, iconSize = 34, fill = Color.Black.copy(alpha = 0.32f))
            RoundIcon(Ic.Fwd10, stringResource(R.string.forward_10), { onSeekBy(TAP_SEEK_MS) }, size = 56, iconSize = 30, label = formatNumber(TAP_SEEK_MS / 1000))
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.displayCutout).padding(start = 24.dp, end = 24.dp, bottom = 14.dp)) {
            ScrubBar(position, duration, buffered, onScrub, onScrubEnd)
            Row(Modifier.fillMaxWidth()) {
                TimeText { clock(position()) }
                Spacer(Modifier.weight(1f))
                val remainingFormat = stringResource(R.string.seek_delta_back)
                TimeText { remainingFormat.format(clock((duration() - position()).coerceAtLeast(0))) }
            }
            // "Ends at": stable while playing, follows the clock while paused, takes the speed into account; not in live.
            if (!live) {
                val endsAt = stringResource(com.wika.wicaby.core.R.string.ends_at, "%s")
                val timeFormat = android.text.format.DateFormat.getTimeFormat(LocalContext.current)
                Row(Modifier.fillMaxWidth()) {
                    Spacer(Modifier.weight(1f))
                    TimeText {
                        val left = (duration() - position()).coerceAtLeast(0)
                        if (duration() <= 0) "" else endsAt.format(timeFormat.format(java.util.Date(now() + (left / speed().coerceAtLeast(0.1f)).toLong())))
                    }
                }
            }
        }
    }
}

// Reads the clock in its own scope so only this text recomposes on each tick.
@Composable
private fun TimeText(text: () -> String) {
    Text(text(), style = Type.mono, color = G.label2)
}

@Composable
private fun ScrubBar(position: () -> Long, duration: () -> Long, buffered: () -> Long, onScrub: (Long) -> Unit, onScrubEnd: () -> Unit) {
    var drag by remember { mutableStateOf<Float?>(null) }
    val accent = LocalAccent.current
    val scrub by rememberUpdatedState(onScrub)
    val end by rememberUpdatedState(onScrubEnd)
    Box(
        Modifier
            .fillMaxWidth()
            .height(36.dp)
            .pointerInput(Unit) {
                fun at(x: Float) = (x / size.width).coerceIn(0f, 1f)
                detectHorizontalDragGestures(
                    onDragStart = { drag = at(it.x); scrub((duration() * drag!!).toLong()) },
                    onDragEnd = { drag = null; end() },
                    onDragCancel = { drag = null; end() },
                ) { change, _ ->
                    change.consume()
                    drag = at(change.position.x)
                    scrub((duration() * drag!!).toLong())
                }
            }
            .pointerInput(Unit) {
                detectTapGestures { scrub((duration() * (it.x / size.width).coerceIn(0f, 1f)).toLong()); end() }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        val d = duration().coerceAtLeast(1)
        val f = drag ?: (position().toFloat() / d).coerceIn(0f, 1f)
        val b = (buffered().toFloat() / d).coerceIn(0f, 1f)
        val h = if (drag != null) 6.dp else 4.dp
        Box(Modifier.fillMaxWidth().height(h).clip(CircleShape).background(Color.White.copy(alpha = 0.22f))) {
            Box(Modifier.fillMaxWidth(b).fillMaxHeight().background(Color.White.copy(alpha = 0.2f)))
            Box(Modifier.fillMaxWidth(f).fillMaxHeight().clip(CircleShape).background(accent))
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val knob = if (drag != null) 18.dp else 12.dp
            Box(Modifier.offset(x = maxWidth * f - knob / 2).size(knob).clip(CircleShape).background(Color.White))
        }
    }
}

@Composable
private fun ActionChip(text: String, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Row(
        Modifier.pressScale(source).clip(CircleShape).background(Color.White).clickable(source, null, role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Ic.Next, null, tint = Color.Black, modifier = Modifier.size(18.dp))
        Text(text, style = Type.headline, color = Color.Black, maxLines = 1)
    }
}

@Composable
private fun UpNextCard(api: com.wika.wicaby.core.data.Api, next: Item, countdown: Int, onPlay: () -> Unit, onDismiss: () -> Unit) {
    val px = dpPx(300.dp)
    val url = remember(next.id) { api.thumb(next, px) }
    Column(Modifier.width(300.dp).clip(RoundedCornerShape(Radius.lg)).background(G.elevated.copy(alpha = 0.95f))) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(G.elevated2)) {
            if (url != null) AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.align(Alignment.TopEnd).padding(8.dp)) { RoundIcon(Ic.Close, stringResource(R.string.close), onDismiss, size = 32, iconSize = 16, fill = Color.Black.copy(alpha = 0.45f)) }
            Box(Modifier.fillMaxWidth().height(3.dp).align(Alignment.BottomStart).background(Color.White.copy(alpha = 0.22f))) {
                Box(Modifier.fillMaxWidth(1f - countdown.toFloat() / UP_NEXT_SECONDS).fillMaxHeight().background(LocalAccent.current))
            }
        }
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 14.dp)) {
            Text(stringResource(R.string.up_next).uppercase(), style = Type.eyebrow, color = G.label3)
            Text(episodeLine(next) ?: next.name, style = Type.headline, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp, bottom = 12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionChip(stringResource(R.string.play_now), onPlay)
                Spacer(Modifier.width(12.dp))
                Text(stringResource(R.string.up_next_in, countdown), style = Type.callout, color = G.label2)
            }
        }
    }
}

@Composable
private fun StillWatching(onContinue: () -> Unit, onStop: () -> Unit, sub: String? = null, stopLabel: String? = null) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)).clickable(interactionSource = null, indication = null) {}, contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp).clip(RoundedCornerShape(Radius.xl)).background(G.elevated).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.still_watching), style = Type.title2, color = G.label)
            Text(sub ?: stringResource(R.string.still_watching_sub), style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 6.dp, bottom = 22.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PillButton(stringResource(R.string.keep_watching), onContinue, primary = true)
                PillButton(stopLabel ?: stringResource(R.string.stop_watching), onStop)
            }
        }
    }
}

// In-window sheet: a Dialog window would bring the system bars back over the video.
@Composable
private fun BoxScope.PlayerSheet(visible: Boolean, onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    AnimatedVisibility(visible, enter = fadeIn(tween(180)), exit = fadeOut(tween(180))) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)).clickable(interactionSource = null, indication = null, onClick = onClose))
    }
    AnimatedVisibility(
        visible,
        enter = slideInVertically(tween(300)) { it } + fadeIn(tween(200)),
        exit = slideOutVertically(tween(240)) { it } + fadeOut(tween(200)),
        modifier = Modifier.align(Alignment.BottomCenter),
    ) {
        Column(
            Modifier
                .widthIn(max = 680.dp)
                .fillMaxWidth()
                .heightIn(max = 330.dp)
                .clip(RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl))
                .background(G.elevated)
                .clickable(interactionSource = null, indication = null) {}
                .padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).padding(vertical = 10.dp).width(36.dp).height(4.dp).clip(CircleShape).background(G.fill4))
            content()
        }
    }
}

@Composable
private fun TracksSheet(pb: Playback, onSearch: () -> Unit, onSync: () -> Unit) {
    val audio = pb.streams.filter { it.type == "Audio" }
    val subs = pb.streams.filter { it.type == "Subtitle" }
    val off = stringResource(R.string.subtitles_off)
    // X-03: "Rechercher des sous-titres…" ends the subtitle column, unless the policy is known to forbid it.
    val allowed by produceState(true, pb.item?.id) { value = SubtitleSearch.allowed(pb.api) }
    val searchRow = if (pb.canSearchSubtitles && allowed) listOf(SEARCH_ROW to stringResource(com.wika.wicaby.core.R.string.subsearch_row)) else emptyList()
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        // "Synchronisation..." (audio delay, subtitle offset) ends the audio column.
        TrackColumn(
            stringResource(R.string.audio), audio.map { it.index to label(it) } + (SYNC_ROW to stringResource(com.wika.wicaby.core.R.string.sync_row)),
            pb.audioIndex ?: audio.firstOrNull { it.isDefault }?.index, { i -> if (i == SYNC_ROW) onSync() else pb.selectAudio(i) }, Modifier.weight(1f),
        )
        TrackColumn(
            stringResource(R.string.subtitles), listOf(-1 to off) + subs.map { it.index to label(it) } + searchRow, pb.subtitleIndex ?: -1,
            { i -> if (i == SEARCH_ROW) onSearch() else pb.selectSubtitle(i) }, Modifier.weight(1f),
        )
    }
}

private const val SEARCH_ROW = -2
private const val SYNC_ROW = -4

// Audio delay (50 ms steps) and subtitle offset (100 ms steps), each with a reset; "Whole series" on an episode.
// Values apply at once and are remembered per video (Playback.adjustDelay, AvSync).
@Composable
private fun SyncSheet(pb: Playback) {
    Text(stringResource(com.wika.wicaby.core.R.string.sync_title).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 12.dp, bottom = 6.dp))
    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SyncRow(stringResource(com.wika.wicaby.core.R.string.sync_audio), pb.audioDelayMs, AvSync.AUDIO_STEP_MS) { pb.adjustDelay(audio = true, deltaMs = it) }
        SyncRow(stringResource(com.wika.wicaby.core.R.string.sync_subtitles), pb.subtitleDelayMs, AvSync.SUBTITLE_STEP_MS) { pb.adjustDelay(audio = false, deltaMs = it) }
        if (pb.canSyncSeries) PillButton(stringResource(com.wika.wicaby.core.R.string.sync_series), { pb.toggleSyncSeries() }, icon = if (pb.syncSeries) Ic.Check else null, selected = pb.syncSeries, compact = true)
        Text(stringResource(com.wika.wicaby.core.R.string.sync_hint), style = Type.footnote, color = G.label2)
    }
}

// "Audio delay  +50 ms   [-50 ms] [+50 ms] [Reset]"; [onStep] gets +-step, or null to reset.
@Composable
private fun SyncRow(title: String, ms: Int, step: Int, onStep: (Int?) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.callout, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(syncLabel(ms), style = Type.mono, color = G.label2, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        PillButton(syncLabel(-step), { onStep(-step) }, compact = true)
        PillButton(syncLabel(step), { onStep(step) }, compact = true)
        PillButton(stringResource(com.wika.wicaby.core.R.string.sync_reset), { onStep(null) }, compact = true)
    }
}

// "+50 ms", "−100 ms", "0 ms" (a real minus sign).
@Composable
private fun syncLabel(ms: Int): String =
    stringResource(com.wika.wicaby.core.R.string.sync_ms, (if (ms > 0) "+" else if (ms < 0) "−" else "") + formatNumber(abs(ms)))

// The playback info panel (top left), refreshed every second while shown.
@Composable
private fun StatsOverlay(pb: Playback, modifier: Modifier) {
    val ctx = LocalContext.current
    val rows by produceState(emptyList<Pair<String, String>>(), pb) {
        while (true) {
            value = PlaybackStats.rows(ctx, pb.stats())
            delay(1_000)
        }
    }
    Column(modifier.widthIn(max = 420.dp).clip(RoundedCornerShape(Radius.md)).background(Color.Black.copy(alpha = 0.72f)).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text(stringResource(com.wika.wicaby.core.R.string.stats_title).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(bottom = 6.dp))
        rows.forEach { (label, value) ->
            Row {
                Text(label, style = Type.caption, color = G.label2, modifier = Modifier.width(118.dp))
                Text(value, style = Type.caption, color = Color.White)
            }
        }
    }
}

// X-03 subtitle search: language chips, the title filter, the results. A tap downloads (the row spins),
// then the player reloads with the new track and toasts; the sheet closes. Back closes only the sheet.
@Composable
private fun SubtitleSearchSheet(pb: Playback, onDone: () -> Unit) {
    val api = pb.api
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val search = remember { SubtitleSearch(ctx, pb, api, scope) }
    LaunchedEffect(Unit) { search.open() }
    val shown = search.shown
    Text(stringResource(com.wika.wicaby.core.R.string.subsearch_title).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(SubtitleSearch.LANGUAGES) { (code, _) ->
            PillButton(SubtitleSearch.languageName(code), onClick = { search.pickLanguage(code) }, selected = code == search.language, compact = true)
        }
    }
    WicabyField(search.title, search::filter, stringResource(com.wika.wicaby.core.R.string.subsearch_title_filter), Modifier.padding(top = 8.dp))
    val failure = search.failure
    val note = when {
        failure == SubtitleRules.Failure.NO_PROVIDER -> com.wika.wicaby.core.R.string.subsearch_no_provider
        failure == SubtitleRules.Failure.FORBIDDEN -> com.wika.wicaby.core.R.string.subsearch_forbidden
        failure != null -> com.wika.wicaby.core.R.string.subsearch_failed
        shown?.isEmpty() == true -> com.wika.wicaby.core.R.string.subsearch_empty
        else -> null
    }
    if (note != null) Text(stringResource(note), style = Type.body, color = G.label2, modifier = Modifier.padding(12.dp))
    else if (shown == null) Spinner(Modifier.padding(12.dp).size(22.dp))
    LazyColumn(Modifier.padding(top = 4.dp)) {
        items(shown.orEmpty(), key = { it.id }) { r ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm)).clickable { search.pick(r, onDone) }.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(r.name ?: r.id, style = Type.body, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(subtitleMeta(r), style = Type.caption, color = G.label2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.width(28.dp)) { if (search.busy == r.id) Spinner(Modifier.size(18.dp)) }
            }
        }
    }
}

// "Open Subtitles · SRT · ★ 8,7 · 1 520 téléchargements · Correspondance parfaite": the flags are text.
@Composable
private fun subtitleMeta(r: RemoteSubtitle): String {
    val nf = java.text.NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 1 }
    return listOfNotNull(
        r.providerName,
        r.format?.uppercase(),
        r.communityRating?.takeIf { it > 0 }?.let { "★ " + nf.format(it) },
        r.downloadCount?.takeIf { it > 0 }?.let { pluralStringResource(com.wika.wicaby.core.R.plurals.subsearch_downloads, it, it) },
        stringResource(com.wika.wicaby.core.R.string.subsearch_perfect).takeIf { r.isHashMatch },
        stringResource(com.wika.wicaby.core.R.string.subsearch_forced).takeIf { r.forcedFlag },
        stringResource(com.wika.wicaby.core.R.string.subsearch_sdh).takeIf { r.sdhFlag },
        stringResource(com.wika.wicaby.core.R.string.subsearch_machine).takeIf { r.machineFlag },
    ).joinToString(" · ")
}

@Composable
private fun label(s: MediaStream): String = s.displayTitle ?: s.title ?: s.language ?: stringResource(R.string.track_unknown, s.index)

@Composable
private fun TrackColumn(title: String, options: List<Pair<Int, String>>, selected: Int?, onSelect: (Int) -> Unit, modifier: Modifier, busy: Int? = null) {
    Column(modifier) {
        Text(title.uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 12.dp, bottom = 6.dp))
        LazyColumn {
            items(options, key = { it.first }) { (index, text) -> OptionRow(text, index == selected, busy = index == busy) { onSelect(index) } }
        }
    }
}

@Composable
private fun OptionRow(text: String, selected: Boolean, busy: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm)).background(if (selected) G.fill2 else Color.Transparent).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(28.dp)) {
            if (busy) Spinner(Modifier.size(18.dp)) else if (selected) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.size(18.dp))
        }
        Text(text, style = Type.body, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// X-02 quality sheet: Version (2 or more sources, never live) and Quality (Original, then the presets).
// A tap reloads in place with a spinner on the row; the sheet closes once the switch took and stays open
// on a failure (its toast says so).
@Composable
private fun QualitySheet(pb: Playback, onDone: () -> Unit) {
    val item = pb.item ?: return
    val ctx = LocalContext.current
    val res = androidx.compose.ui.platform.LocalResources.current
    val versions = pb.versions
    val labels = remember(item.id) { pb.versionLabels() }
    val rows = remember(item.id, pb.sourceId) { pb.qualityRows() }
    val tag = stringResource(if (pb.playMethod == "Transcode") com.wika.wicaby.core.R.string.play_method_transcode else com.wika.wicaby.core.R.string.play_method_direct)
    val cap = pb.qualityCap?.takeIf { it < com.wika.wicaby.core.player.Quality.ORIGINAL }
    val versionSel = versions.indexOfFirst { it.id == pb.sourceId }
    val rowSel = rows.indexOfFirst { it.maxBitrate == cap }
    // The method tag waits for the new stream. The row being switched to: column ('v' or 'q') and index.
    var busy by remember { mutableStateOf<Pair<Char, Int>?>(null) }
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) { if (done) onDone() }
    fun pick(column: Char, i: Int, sourceId: String?, maxBitrate: Int?) {
        if (pb.switching) return
        busy = column to i
        pb.switchQuality(sourceId, maxBitrate) { ok -> busy = null; done = ok }
    }
    val original = stringResource(com.wika.wicaby.core.R.string.quality_original)
    val sizeOf = { size: Long?, percent: Int? ->
        size?.let { b -> android.text.format.Formatter.formatShortFileSize(ctx, b).let { f -> percent?.let { res.getString(com.wika.wicaby.core.R.string.quality_size, f, it) } ?: f } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        if (versions.isNotEmpty()) {
            TrackColumn(
                stringResource(com.wika.wicaby.core.R.string.quality_version),
                versions.mapIndexed { i, v -> i to listOfNotNull(labels.getOrNull(i) ?: v.id, tag.takeIf { i == versionSel && !pb.switching }, sizeOf(v.size, null)).joinToString(" · ") },
                versionSel, { i -> if (i != versionSel) pick('v', i, versions[i].id, cap) }, Modifier.weight(1f),
                busy = busy?.takeIf { it.first == 'v' }?.second,
            )
        }
        TrackColumn(
            stringResource(com.wika.wicaby.core.R.string.quality),
            rows.mapIndexed { i, r ->
                val name = if (r.maxBitrate == null) listOfNotNull(original, r.height?.let { "${it}p" }).joinToString(" · ") else qualityLabel(ctx, r.maxBitrate)
                i to listOfNotNull(name, tag.takeIf { i == rowSel && !pb.switching }, sizeOf(r.size, r.percent)).joinToString(" · ")
            },
            rowSel, { i -> if (i != rowSel) pick('q', i, null, rows[i].maxBitrate) }, Modifier.weight(1.3f),
            busy = busy?.takeIf { it.first == 'q' }?.second,
        )
    }
}

// X-04 sleep timer sheet: +15 min and Cancel while a timer runs, then end of this video and the durations.
@Composable
private fun SleepSheet(sleep: SleepTimer.State?, onDone: () -> Unit) {
    Text(stringResource(com.wika.wicaby.core.R.string.sleep_timer).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 12.dp, bottom = 6.dp))
    val pick = { action: () -> Unit -> action(); onDone() }
    LazyColumn {
        if (sleep != null) {
            if (sleep.endsAt != null) item { OptionRow(stringResource(com.wika.wicaby.core.R.string.sleep_extend), false) { pick { SleepTimer.extend() } } }
            item { OptionRow(stringResource(com.wika.wicaby.core.R.string.sleep_cancel), false) { pick { SleepTimer.cancel() } } }
        }
        item { OptionRow(stringResource(com.wika.wicaby.core.R.string.sleep_end_of_video), sleep != null && sleep.minutes == null) { pick { SleepTimer.start(null) } } }
        items(listOf(5, 10, 15, 30, 45, 60, 90, 120), key = { it }) { m ->
            OptionRow(stringResource(com.wika.wicaby.core.R.string.sleep_minutes, m), sleep?.minutes == m) { pick { SleepTimer.start(m) } }
        }
    }
}

// Lucide "moon" at the house stroke (docs/design.md), for the sleep timer button.
private val MoonIcon = ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    .addPath(
        androidx.compose.ui.graphics.vector.addPathNodes("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"),
        stroke = androidx.compose.ui.graphics.SolidColor(Color.White), strokeLineWidth = 1.5f,
        strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round, strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
    )
    .build()

@Composable
private fun SpeedSheet(current: Float, onSelect: (Float) -> Unit) {
    Text(stringResource(com.wika.wicaby.core.R.string.speed).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(start = 12.dp, bottom = 6.dp))
    // A bitstream (HDMI passthrough) plays at 1x only: the reason, and the other speeds dimmed and inert.
    val bitstream = AudioFx.bitstream
    if (bitstream) Text(stringResource(com.wika.wicaby.core.R.string.speed_bitstream), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 6.dp))
    LazyColumn {
        items(listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f), key = { it }) { s ->
            val off = bitstream && s != 1f
            Box(if (off) Modifier.alpha(0.4f).semantics { disabled() } else Modifier) {
                OptionRow(if (s == 1f) stringResource(R.string.speed_normal) else stringResource(com.wika.wicaby.core.R.string.speed_value, formatNumber(s, maxFractionDigits = 2)), abs(current - s) < 0.01f) { if (!off) onSelect(s) }
            }
        }
    }
}

// The zoom step: the video view grows past the screen, centred (layout, so SurfaceView follows).
private fun Modifier.scaledBy(s: Float): Modifier = if (s == 1f) this else layout { m, c ->
    val w = (c.maxWidth * s).toInt()
    val h = (c.maxHeight * s).toInt()
    val p = m.measure(Constraints.fixed(w, h))
    layout(c.maxWidth, c.maxHeight) { p.place((c.maxWidth - w) / 2, (c.maxHeight - h) / 2) }
}

// Live seam: the peek card while swiping or tuning, the chips with the controls, the mini-guide sheet.
@Composable
private fun BoxScope.LiveLayer(pb: Playback, zap: com.wika.wicaby.core.livetv.ZapController?, drag: ZapDrag, controls: Boolean, miniGuide: Boolean, onMiniGuide: (Boolean) -> Unit) {
    val repo = LiveZap.repo
    if (zap == null || repo == null) return
    val st = pb.liveState
    val pending by zap.state.collectAsState()
    val peek = drag.target ?: pending.pending?.let { id -> zap.entries.firstOrNull { it.id == id } } ?: st?.pending
    if (peek != null) PeekCard(repo, peek, drag.dx, tuning = drag.target == null && st?.tuning == true, Modifier.align(Alignment.Center))
    AnimatedVisibility(controls && !miniGuide, enter = fadeIn(tween(200)), exit = fadeOut(tween(320)), modifier = Modifier.align(Alignment.BottomStart)) {
        LiveChips(zap, { onMiniGuide(true) }, Modifier.windowInsetsPadding(WindowInsets.displayCutout).padding(start = 24.dp, bottom = 84.dp))
    }
    MiniGuideSheet(miniGuide, repo, st?.channel?.id, onTune = zap::tune, onClose = { onMiniGuide(false) })
}
