package com.wika.wicaby.tv.player

import com.wika.wicaby.tv.ui.TvFocus
import com.wika.wicaby.tv.ui.dpadEdges
import com.wika.wicaby.core.syncplay.SyncPlay
import com.wika.wicaby.tv.ui.label
import com.wika.wicaby.tv.ui.rememberSyncGroups
import com.wika.wicaby.tv.ui.syncAct
import com.wika.wicaby.tv.ui.syncGroupName
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import android.content.Intent
import android.net.Uri
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.produceState
import androidx.compose.ui.res.pluralStringResource
import com.wika.wicaby.core.data.AccessSchedules
import com.wika.wicaby.core.data.RemoteSubtitle
import com.wika.wicaby.core.data.SubtitleRules
import com.wika.wicaby.core.player.TrackMemory
import com.wika.wicaby.core.player.SubtitleSearch
import com.wika.wicaby.core.player.SubtitleLook
import com.wika.wicaby.core.player.setFontScale
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import com.wika.wicaby.tv.ui.TvTextField
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.player.ExternalPlayer
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.core.player.AvSync
import com.wika.wicaby.core.player.PlaybackStats
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import com.wika.wicaby.core.data.Chapter
import java.text.NumberFormat
import kotlin.math.abs
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.wika.wicaby.core.player.Aspect
import com.wika.wicaby.core.player.SleepTimer
import com.wika.wicaby.core.player.SteppedSeek
import com.wika.wicaby.core.player.Quality
import com.wika.wicaby.core.player.qualityLabel
import com.wika.wicaby.core.player.qualityShortLabel
import android.view.accessibility.AccessibilityManager
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.input.key.type
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C as MC
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.TvCanvas
import com.wika.wicaby.tv.goFullscreen
import com.wika.wicaby.tv.hideSystemBars
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.songid.ShazamSignature
import com.wika.wicaby.core.songid.SongId
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.player.DisplaySwitcher
import com.wika.wicaby.core.player.LiveDisplayMode
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.core.player.PlayQueue
import com.wika.wicaby.core.player.STILL_WATCHING_AFTER
import com.wika.wicaby.core.player.SegmentKind
import com.wika.wicaby.core.player.SkipRange
import com.wika.wicaby.core.player.buildEngine
import com.wika.wicaby.core.player.upNextAt
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.data.HomeChannels
import com.wika.wicaby.tv.data.WatchNext
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.FocusMemory
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.OverlayHost
import com.wika.wicaby.tv.ui.OverlayLayer
import com.wika.wicaby.tv.ui.livetv.GuideDims
import com.wika.wicaby.tv.ui.livetv.GuideGrid
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.WicabyTheme
import com.wika.wicaby.tv.ui.dpPx
import com.wika.wicaby.tv.ui.episodeLine
import com.wika.wicaby.tv.ui.remembered
import com.wika.wicaby.core.data.thumb
import com.wika.wicaby.tv.ui.tvFocus
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.widget.AssSubtitleView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import com.wika.wicaby.tv.data.TvSettings
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class PlayerActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(newBase)
        AppLanguage.overrideConfiguration(newBase)?.let { applyOverrideConfiguration(it) }
    }

    companion object {
        const val EXTRA_ID = "id"
        const val EXTRA_FROM_START = "fromStart"
        /** Live TV (F2): "beginning" or "live" pre-answers the watch-from-start prompt (deep link `start=`). */
        const val EXTRA_LIVE_START = "liveStart"

        // A trailer of the item on screen: plays from the start and reports nothing.
        const val EXTRA_TRAILER = "trailer"

        // Debug builds only: show the OSD for an item without loading any media.
        const val EXTRA_PREVIEW = "preview"

        // TP-04: a play queue (shuffle, "Play on" with several items); EXTRA_ID is the entry to start with.
        const val EXTRA_QUEUE = "queue"

        // TP-06: an extra server's id when the item comes from one (absent: the primary server).
        const val EXTRA_SERVER = "server"
    }

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null
    private var playback: Playback? = null
    private var display: DisplaySwitcher? = null

    // "Lecteur externe" after a playback error: this activity waits for the other app (onStop
    // does not finish it), then saves the position it hands back and closes. If the TV killed
    // our process meanwhile, the recreated activity only waits for the result (onCreate) and
    // refetches the item it played (saved in onSaveInstanceState).
    private var externalId: String? = null
    private val externalPlayer = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val api = serverApi()
        val id = externalId
        if (api != null && id != null && !intent.getBooleanExtra(EXTRA_TRAILER, false)) {
            val known = playback?.item?.takeIf { it.id == id }
            Core.scope.launch {
                val item = known ?: runCatching { api.item(id) }.getOrNull() ?: return@launch
                if (ExternalPlayer.report(api, item, r.data)) Cache.changed()
            }
        }
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("externalId", externalId)
    }

    // TP-06: the extra server the intent names (gone since: nothing to play), else the primary one.
    private fun serverApi(): com.wika.wicaby.core.data.Api? {
        intent.getStringExtra(EXTRA_SERVER)?.let { return com.wika.wicaby.core.data.Servers.extraOf(it) }
        return Wicaby.app.api
    }

    private fun openExternal(pb: Playback) {
        val api = pb.api
        val item = pb.item ?: return
        val start = pb.player.currentPosition.takeIf { it > 0 } ?: if (pb.trailer) 0 else item.resumeMs
        val intent = ExternalPlayer.intent(this, api, item, start)
        pb.stop()
        externalId = item.id
        if (runCatching { externalPlayer.launch(intent) }.isFailure) finish()
    }

    /** Android TV PiP (§8.7, live.pip): the overlays hide while the video plays in the system's window. */
    private var inPip by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyToCore(this)
        val api = serverApi()
        val id = intent.getStringExtra(EXTRA_ID)
        if (api == null || id == null) {
            finish()
            return
        }
        // Recreated while the external player was open: do not start playback again.
        externalId = savedInstanceState?.getString("externalId")
        if (externalId != null) return

        // A video ends the music session (MU-09): one player at a time.
        com.wika.wicaby.tv.music.Music.release()
        val engine = buildEngine(this, api.authHeaders(), "Wicaby/${BuildConfig.VERSION_NAME} (Android TV)")
        val exo = engine.player
        val ass = engine.ass
        // Ambient mode/screensaver may start whenever we are not actually playing (TV-BU).
        exo.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        })
        player = exo
        // Unique per instance: F2 starts the recording's player before this one is destroyed (Media3 ids must be unique).
        session = MediaSession.Builder(this, exo).setId("player-${System.identityHashCode(this)}").build()

        val preview = BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_PREVIEW, false)
        // The ids go into URLs: the server's ids only.
        val queue = intent.getStringArrayListExtra(EXTRA_QUEUE)?.filter(com.wika.wicaby.core.data.SafeNames::isValidId)
            ?.takeIf { it.size > 1 && id in it }?.let { PlayQueue(it, it.indexOf(id), fromStart = intent.getBooleanExtra(EXTRA_FROM_START, false)) }
        val switcher = DisplaySwitcher(this)
        display = switcher
        val pb = Playback(
            this, api, exo, id, intent.getBooleanExtra(EXTRA_FROM_START, false), preview,
            trailer = intent.getBooleanExtra(EXTRA_TRAILER, false),
            prepareDisplay = { video ->
                val mode = Wicaby.app.displayMode
                // We drive the mode ourselves: keep ExoPlayer's seamless-only hint from fighting it.
                if (mode > 0 && switcher.match(video, matchResolution = mode == 2)) exo.setVideoChangeFrameRateStrategy(MC.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF)
            },
            // After the Stopped report: Home and Detail refetch the new resume point and next episode.
            onSessionEnd = { e ->
                Cache.changed()
                // The launcher's links open on the primary server: an extra server's title stays out of Watch Next.
                if (api === Wicaby.app.api) WatchNext.update(applicationContext, api, e.item, e.positionMs, e.durationMs, e.watched)
                HomeChannels.sync(applicationContext, api)
            },
            // Home rows show fresh resume points next time.
            onStopped = {
                Cache.map.remove("resume")
                Cache.map.remove("nextup")
            },
            onRemoteExit = { finish() },
            queue = queue,
        )
        playback = pb
        // Live (§21.5): off by default on TV until measured on the set (V20); the rate only, across 24/50/60 families.
        if (TvSettings.liveMatchFrameRate.value) LiveDisplayMode(exo, { pb.liveState != null }) { hz ->
            if (switcher.matchLive(hz)) exo.setVideoChangeFrameRateStrategy(MC.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF)
        }
        lifecycleScope.launch {
            Wicaby.app.maxMbps = withContext(Dispatchers.IO) { TvSettings.maxMbpsNow(applicationContext, api.server.address) }
            pb.start(lifecycleScope)
        }

        val canExternal = !preview && ExternalPlayer.available(this, api)
        goFullscreen()
        setContent {
            TvCanvas {
                WicabyTheme(Accents[Wicaby.app.accent.coerceIn(Accents.indices)]) {
                    PlayerScreen(
                        pb, exo, ass, inPip, onExit = { finish() },
                        onExternal = { openExternal(pb) }.takeIf { canExternal },
                    )
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Home with a channel playing and live.pip on: the system's PiP window instead of stopping (onStop then ends it).
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < 26 || playback?.liveState == null || !TvSettings.livePip.value) return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return
        runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build()) }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
    }

    override fun onStop() {
        super.onStop()
        // Leaving the player (Home, another app) ends the session, like the official clients.
        if (!isChangingConfigurations) {
            playback?.stop()
            display?.restore()
            if (externalId == null) finish()
        }
    }

    override fun onDestroy() {
        playback?.stop()
        session?.release()
        player?.release()
        super.onDestroy()
    }
}

/** No live layer is open: Back would run live.backAction. */
private val LiveControl.idle get() = ask == null && !zap.digitsOpen && !menu && !detail && !guide && !banner

private fun isSelect(k: Key) = k == Key.DirectionCenter || k == Key.Enter || k == Key.NumPadEnter || k == Key.Spacebar || k == Key.ButtonA


@Composable
private fun PlayerScreen(pb: Playback, player: ExoPlayer, ass: AssHandler, inPip: Boolean, onExit: () -> Unit, onExternal: (() -> Unit)?) {
    val scope = rememberCoroutineScope()
    var osd by remember { mutableStateOf(true) }
    var panel by remember { mutableStateOf(false) }
    // Which sheet `panel` shows: PANEL_TRACKS, PANEL_CHAPTERS or PANEL_SPEED.
    var panelKind by remember { mutableIntStateOf(PANEL_TRACKS) }
    var nonce by remember { mutableIntStateOf(0) }
    var playing by remember { mutableStateOf(player.isPlaying) }
    var buffering by remember { mutableStateOf(true) }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var buffered by remember { mutableLongStateOf(0L) }
    var scrub by remember { mutableStateOf<Long?>(null) }
    var scrubJob by remember { mutableStateOf<Job?>(null) }
    var skipVisible by remember { mutableStateOf(false) }
    var skipNonce by remember { mutableIntStateOf(0) }
    var stillWatching by remember { mutableStateOf(false) }
    val upNextSeconds = TvSettings.countdown.value
    val autoplay = TvSettings.autoplayNext.value
    var countdown by remember { mutableIntStateOf(upNextSeconds) }
    val root = remember { FocusRequester() }
    val item = pb.item
    var dismissedUpNext by remember(item?.id) { mutableStateOf(false) }
    // Picture format, remembered at the scope set in Réglages (X-05); its name flashes when it changes.
    var aspect by remember { mutableStateOf(Aspect.of(pb.scopeCtx)) }
    LaunchedEffect(pb.scopeCtx) { aspect = Aspect.of(pb.scopeCtx) }
    var aspectFlash by remember { mutableIntStateOf(0) }
    var aspectLabel by remember { mutableStateOf(false) }
    // ↓ moves focus from the invisible key catcher to the control bar's buttons.
    val tracksButton = remember { FocusRequester() }
    val chaptersButton = remember { FocusRequester() }
    val speedButton = remember { FocusRequester() }
    val aspectButton = remember { FocusRequester() }
    val sleepButton = remember { FocusRequester() }
    val qualityButton = remember { FocusRequester() }
    val queueButton = remember { FocusRequester() }
    val togetherButton = remember { FocusRequester() }
    val together = !pb.preview && !pb.trailer && SyncPlay.available(pb.api)
    val songIdButton = remember { FocusRequester() }
    val queue = pb.queue
    val chapters = pb.chapters
    val chapterStarts = remember(chapters) { chapters.map { it.value.startPositionTicks / TICKS_PER_MS } }
    // The control bar, left to right (left/right move along it).
    val buttons = listOfNotNull(
        tracksButton, chaptersButton.takeIf { chapters.isNotEmpty() }, speedButton, sleepButton, songIdButton.takeIf { pb.songIdSource != null }, queueButton.takeIf { queue != null },
        togetherButton.takeIf { together }, qualityButton.takeIf { pb.canSwitchQuality }, aspectButton,
    )
    fun openPanel(kind: Int) {
        panelKind = kind
        panel = true
    }
    var controlsFocused by remember { mutableStateOf(false) }
    var focusControls by remember { mutableIntStateOf(0) }
    // X-04: the merged seek (badge), the play/pause disc, the Back latch on the skip prompt, the sleep timer.
    var pending by remember { mutableStateOf<SteppedSeek.Pending?>(null) }
    var held by remember { mutableStateOf(false) }
    var disc by remember { mutableIntStateOf(0) }
    var discShown by remember { mutableStateOf(false) }
    var backLatch by remember { mutableStateOf(false) }
    var keyLatch by remember { mutableStateOf(false) }
    val sleep by SleepTimer.state.collectAsState()
    // The timer belongs to this player: leaving it ends the timer (episodes advance inside it, so they keep it).
    DisposableEffect(Unit) { onDispose { SleepTimer.cancel() } }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val context = LocalContext.current
    // The prompt waits the accessibility-recommended time (30 s by default).
    val promptMs = remember {
        val am = context.getSystemService(AccessibilityManager::class.java)
        if (Build.VERSION.SDK_INT >= 29 && am != null) am.getRecommendedTimeoutMillis(SleepTimer.PROMPT_MS.toInt(), AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_TEXT).toLong() else SleepTimer.PROMPT_MS
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
        onDispose { player.removeListener(l) }
    }
    LaunchedEffect(Unit) {
        runCatching { root.requestFocus() }
        while (true) {
            val runtime = (pb.item?.runTimeTicks ?: 0) / TICKS_PER_MS
            if (pb.preview) {
                position = pb.item?.resumeMs ?: 0
                duration = runtime
                buffered = position
                buffering = false
            } else if (pb.liveState == null) { // live shows none of these: polling them recomposed the screen (and the guide over it) every second
                position = player.currentPosition
                duration = player.duration.takeIf { it > 0 } ?: runtime
                buffered = player.bufferedPosition
            }
            delay(if (osd) 250 else 1000)
        }
    }
    LaunchedEffect(nonce, playing, panel, scrub, controlsFocused) {
        if (playing && !panel && scrub == null) {
            // Longer while the control bar has focus: the viewer is choosing something.
            delay(if (controlsFocused) 9_000 else 4_500)
            osd = false
        }
    }

    // Trickplay: the frame at the scrub target, kept until the next one is decoded.
    var thumb by remember { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(scrub, pb.scrubPreview) {
        val t = scrub
        val preview = pb.scrubPreview
        if (t == null || preview == null) {
            thumb = null
            return@LaunchedEffect
        }
        runCatching { preview.frame(t) }.getOrNull()?.let { thumb = it.asImageBitmap() }
    }

    // "Passer l'intro" (or the recap, preview, commercial): shown on entering the range, fades
    // after 8 s, back whenever the OSD is woken. Each kind follows its own setting.
    // Only these flip when the position ticks; the screen itself does not recompose every second (mobile does the same).
    val segment by remember(pb) { derivedStateOf { pb.segments.skippableAt(position) } }
    val skipMode = segment?.let { TvSettings.skipMode(it.kind) } ?: TvSettings.SKIP_OFF
    val skippable = segment.takeIf { skipMode != TvSettings.SKIP_OFF }
    // Auto-skipped once per range: seeking back into it plays it.
    var autoSkipped by remember(item?.id) { mutableStateOf(emptySet<SkipRange>()) }
    LaunchedEffect(skippable) {
        if (skippable != null && skipMode == TvSettings.SKIP_AUTO && skippable !in autoSkipped && !pb.preview) {
            autoSkipped = autoSkipped + skippable
            player.seekTo(skippable.endMs)
        }
    }
    // The chip keeps its label while it fades out, after the range has passed.
    var chipKind by remember { mutableStateOf(SegmentKind.Intro) }
    LaunchedEffect(skippable, skipNonce) {
        skipVisible = skippable != null && skipMode == TvSettings.SKIP_ASK
        skippable?.let { chipKind = it.kind }
        if (skipVisible) {
            delay(8_000)
            skipVisible = false
        }
    }

    // Music: the album art instead of a black picture, no "still watching?", the next track at once.
    val audio = item?.isAudio == true
    fun autoAdvance() {
        if (pb.autoCount >= STILL_WATCHING_AFTER && !audio) {
            player.pause()
            stillWatching = true
        } else {
            pb.advance(auto = true)
        }
    }

    val upNext by remember(pb, item?.id) {
        derivedStateOf {
            val at = upNextAt(duration, pb.segments.credits)
            pb.next.takeIf { !audio && !dismissedUpNext && !stillWatching && !pb.preview && at != null && position >= at && position > 0 }
        }
    }
    LaunchedEffect(upNext?.id, sleep?.minutes == null && sleep != null) {
        if (upNext == null || !autoplay || SleepTimer.endOfVideo) return@LaunchedEffect
        var left = upNextSeconds
        countdown = left
        while (left > 0) {
            delay(1_000)
            // The countdown waits while the viewer has paused the credits.
            if (player.isPlaying) left--
            countdown = left
        }
        autoAdvance()
    }
    LaunchedEffect(pb.ended) {
        if (!pb.ended || stillWatching) return@LaunchedEffect
        // Sleep timer "end of this video": stay at the end and ask instead of going on.
        if (SleepTimer.atEnd(promptMs = promptMs)) return@LaunchedEffect
        if (pb.next != null && !dismissedUpNext && (autoplay || audio)) autoAdvance() else onExit()
    }

    fun poke() {
        osd = true
        nonce++
        skipNonce++
    }

    // Wall clock for the sleep chip and "Ends at"; the timer is checked here once a second.
    LaunchedEffect(sleep != null, osd) {
        while (true) {
            now = System.currentTimeMillis()
            // No input on "Still watching?": pause.
            if (SleepTimer.check(now, promptMs) == SleepTimer.Action.EXPIRE) player.pause()
            if (SleepTimer.state.value == null && !osd) break
            delay(1_000)
        }
    }
    LaunchedEffect(disc) {
        if (disc == 0) return@LaunchedEffect
        discShown = true
        delay(600)
        discShown = false
    }

    // Merged seeks: the target moves at once, the player seeks 650 ms after the last press.
    fun seekTo(ms: Long) {
        // Live channels have no timeline: a seek would jump back to 0.
        if (duration <= 0) return poke()
        val target = ms.coerceIn(0, duration.coerceAtLeast(0))
        pending = null
        held = false
        scrub = target
        poke()
        scrubJob?.cancel()
        scrubJob = scope.launch {
            delay(650)
            if (!pb.preview) player.seekTo(target)
            // Hold the target until the next poll, or the knob snaps back to the old position.
            position = target
            scrub = null
        }
    }

    // X-04 stepped seek: presses add to one target ("+40 s"), accelerating while held; the player seeks
    // SteppedSeek.MERGE_MS after the last press, or on key-up after a hold.
    fun commitPending() {
        val p = pending ?: return
        pending = null
        held = false
        if (!pb.preview) player.seekTo(p.target)
        position = p.target
        scrub = null
    }

    fun stepSeek(forward: Boolean, repeat: Boolean) {
        val p = SteppedSeek.press(pending, scrub ?: position, duration, if (forward) 10_000L else -10_000L, repeat)
        pending = p
        if (repeat) held = true
        scrub = p.target
        poke()
        scrubJob?.cancel()
        scrubJob = scope.launch {
            delay(SteppedSeek.MERGE_MS)
            commitPending()
        }
    }

    fun togglePlay(play: Boolean = !player.isPlaying) {
        if (play) player.play() else player.pause()
        // Controls hidden: only the centred disc, so subtitles stay readable.
        if (osd) poke() else disc++
    }

    // Touch: drag or tap on the scrub bar.
    fun scrubTo(ms: Long) {
        if (duration <= 0) return
        scrubJob?.cancel()
        scrub = ms.coerceIn(0, duration.coerceAtLeast(0))
        osd = true
        nonce++
    }

    fun commitScrub() {
        val t = scrub ?: return
        if (!pb.preview) player.seekTo(t)
        position = t
        scrub = null
    }

    fun skipIntro() {
        skippable?.let { if (!pb.preview) player.seekTo(it.endMs) }
        skipVisible = false
    }

    fun cycleAspect() {
        aspect = aspect.next()
        Aspect.remember(pb.scopeCtx, aspect)
        aspectFlash++
        poke()
    }
    // A live channel has no VOD sleep timer (no OSD to set it; its expiry would only pause and keep the
    // tuner): switching to live cancels it. "Fin de ce programme" comes with the TV-3 seam.
    LaunchedEffect(pb.liveState != null) { if (pb.liveState != null) SleepTimer.cancel() }
    // Live TV: banner, digits, mini-guide and the remote's live keys (LiveOverlay.kt).
    val live = if (pb.liveState != null) rememberLiveControl(pb, player, root, onTracks = { openPanel(PANEL_TRACKS) }, onAspect = ::cycleAspect, onExit = onExit, onQuality = { openPanel(PANEL_QUALITY) }) else null

    // Picture-in-guide (§8.7, TV-5): the guide over the player, the same PlayerView resized into the band's hole.
    var pig by remember { mutableStateOf(false) }
    var pigJump by remember { mutableStateOf<String?>(null) }
    var pigViaBack by remember { mutableIntStateOf(0) }
    var slot by remember { mutableStateOf<Rect?>(null) }
    val pigHost = remember { OverlayHost() }
    fun openPig(viaBack: Boolean) {
        val l = live ?: return
        repeat(6) { if (!l.idle) l.back() } // digits, menu, detail, mini-guide, banner: each Back closes one
        pigJump = pb.liveState?.channel?.id
        slot = null
        pig = true
        if (viaBack) pigViaBack++
        if (BuildConfig.DEBUG) Log.d("WicabyLive", "pig open player=${System.identityHashCode(player)} state=${player.playbackState}")
    }
    LaunchedEffect(pig) {
        if (pig) return@LaunchedEffect
        pigHost.close()
        runCatching { root.requestFocus() }
    }
    LaunchedEffect(inPip) {
        if (inPip) {
            pig = false
            panel = false
        }
    }
    // §8.7: a second Back within 2 s of the Back that opened the guide exits. Added two frames after the
    // grid's own Back handler (subcomposed), so it wins for those 2 s.
    val backs = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    LaunchedEffect(pig, pigViaBack) {
        if (!pig || pigViaBack == 0 || backs == null) return@LaunchedEffect
        withFrameNanos { }
        withFrameNanos { }
        val cb = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onExit()
        }
        backs.addCallback(cb)
        try {
            delay(2_000)
        } finally {
            cb.remove()
        }
    }
    LaunchedEffect(aspectFlash) {
        if (aspectFlash == 0) return@LaunchedEffect
        aspectLabel = true
        delay(1_500)
        aspectLabel = false
    }
    // The buttons only exist once the OSD is composed: ask on the next frames.
    LaunchedEffect(focusControls) {
        if (focusControls == 0) return@LaunchedEffect
        repeat(6) {
            delay(32)
            if (runCatching { tracksButton.requestFocus() }.isSuccess && controlsFocused) return@LaunchedEffect
        }
    }
    // The OSD hid itself (or a panel opened and closed): the key catcher takes focus back.
    LaunchedEffect(osd) {
        if (!osd && controlsFocused) runCatching { root.requestFocus() }
    }

    fun onKey(e: KeyEvent): Boolean {
        // GUIDE opens the guide over the video (picture-in-guide) from every live state.
        if (live != null && e.key == Key.Guide) {
            if (e.type == KeyEventType.KeyDown && e.nativeKeyEvent.repeatCount == 0) openPig(viaBack = false)
            return true
        }
        // Live first: it consumes CH±, digits, INFO, colour keys and the D-pad (spec §10.2); Back is the live BackHandler below.
        if (live != null && live.onKey(e)) return true
        if (e.type == KeyEventType.KeyUp) {
            if (held && (e.key == Key.DirectionLeft || e.key == Key.DirectionRight || e.key == Key.MediaRewind || e.key == Key.MediaFastForward)) {
                scrubJob?.cancel()
                commitPending()
            }
            return false
        }
        if (e.type != KeyEventType.KeyDown) return false
        pb.autoCount = 0
        val repeat = e.nativeKeyEvent.repeatCount
        return when {
            isSelect(e.key) && upNext != null -> {
                if (repeat == 0) pb.advance(auto = false)
                true
            }
            isSelect(e.key) && skipVisible -> {
                if (repeat == 0) skipIntro()
                true
            }
            isSelect(e.key) || e.key == Key.MediaPlayPause -> {
                if (repeat == 0) togglePlay()
                true
            }
            e.key == Key.MediaPlay -> { if (repeat == 0) togglePlay(play = true); true }
            e.key == Key.MediaPause -> { if (repeat == 0) togglePlay(play = false); true }
            e.key == Key.MediaNext -> { if (pb.next != null) pb.advance(auto = false); true }
            e.key == Key.MediaPrevious -> { if (repeat == 0) pb.previous(); true }
            // FF/REW step like left/right (B19: whole chapters were too far); the chapters panel still jumps.
            e.key == Key.MediaRewind -> { stepSeek(forward = false, repeat > 0); true }
            e.key == Key.MediaFastForward -> { stepSeek(forward = true, repeat > 0); true }
            e.key == Key.DirectionLeft -> { stepSeek(forward = false, repeat > 0); true }
            e.key == Key.DirectionRight -> { stepSeek(forward = true, repeat > 0); true }
            e.key == Key.Menu || e.key == Key.Captions -> { openPanel(PANEL_TRACKS); true }
            e.key == Key.DirectionDown -> {
                if (repeat == 0) {
                    poke()
                    focusControls++
                }
                true
            }
            e.key == Key.DirectionUp || e.key == Key.Info -> { poke(); true }
            else -> false
        }
    }

    // Keys on the control bar's buttons: ←/→ between them, ↑ back to scrubbing, ↓ on "Audio et
    // sous-titres" opens the panel (↓↓ from the picture), media keys keep working.
    fun onControlsKey(e: KeyEvent, button: FocusRequester): Boolean {
        if (e.type != KeyEventType.KeyDown) return false
        pb.autoCount = 0
        osd = true
        nonce++
        val at = buttons.indexOf(button)
        return when {
            e.key == Key.DirectionUp -> { runCatching { root.requestFocus() }; true }
            e.key == Key.DirectionRight -> { buttons.getOrNull(at + 1)?.let { runCatching { it.requestFocus() } }; true }
            e.key == Key.DirectionLeft -> { buttons.getOrNull(at - 1)?.let { runCatching { it.requestFocus() } }; true }
            e.key == Key.DirectionDown -> { if (button == tracksButton) openPanel(PANEL_TRACKS); true }
            isSelect(e.key) -> false
            else -> onKey(e)
        }
    }

    BackHandler(enabled = panel) {
        panel = false
        runCatching { root.requestFocus() }
    }
    BackHandler(enabled = !panel && osd && playing) { osd = false }
    BackHandler(enabled = !panel && upNext != null) { dismissedUpNext = true }
    BackHandler(enabled = stillWatching) { onExit() }
    // Registered last, so it wins: Back from the buttons first returns to the picture.
    BackHandler(enabled = controlsFocused && !panel && !stillWatching) { runCatching { root.requestFocus() } }
    BackHandler(enabled = live != null && !panel && !pig) {
        val l = live ?: return@BackHandler
        if (l.idle && TvSettings.liveBackAction.value == TvSettings.LIVE_BACK_GUIDE) openPig(viaBack = true) else l.back()
    }
    // The grid's own Back (subcomposed later) wins while it has focus: grid -> header, then this closes.
    BackHandler(enabled = pig) { pig = false }
    // Sleep timer: Back on "Still watching?" counts as Continue; at the end of the video Continue goes on.
    fun sleepContinue() {
        SleepTimer.restart()
        if (pb.ended) { if (pb.next != null) pb.advance(auto = false) else onExit() }
        runCatching { root.requestFocus() }
    }
    // Back on the skip-intro prompt dismisses it and stays in the player. Latched from the press
    // (back started) to the release (back committed), so the prompt fading out in between does not
    // turn the release into an exit. Back reaches the app as a back event, not as a key (predictive back).
    // keyLatch covers the pre-predictive path (Back delivered as onBackPressed on key-up): set on the key-down.
    PredictiveBackHandler(enabled = skipVisible || backLatch || keyLatch) { progress ->
        backLatch = true
        keyLatch = false
        try {
            progress.collect {}
            skipVisible = false
        } finally {
            backLatch = false
            // Compose treats the unconsumed Back key as a focus exit: the key catcher takes focus back.
            runCatching { root.requestFocus() }
        }
    }
    val sleepPromptUntil = sleep?.promptUntil
    BackHandler(enabled = sleepPromptUntil != null) { sleepContinue() }

    Box(
        Modifier.fillMaxSize().background(Color.Black).onPreviewKeyEvent { e ->
            if (e.key == Key.Back) {
                if (e.type == KeyEventType.KeyDown && skipVisible) keyLatch = true
                // The back event follows the key-up synchronously; a latch nothing used ends a frame later.
                else if (e.type == KeyEventType.KeyUp && keyLatch) scope.launch { withFrameNanos { }; keyLatch = false }
            }
            false
        },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = false
                    isFocusable = false
                    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    subtitleView?.addView(AssSubtitleView(ctx, ass))
                    this.player = player
                }
            },
            // Reads the TvSettings states, so a change from the track panel restyles live.
            update = {
                it.resizeMode = aspect.resizeMode
                it.subtitleView?.let { v -> styleSubtitles(v, ass) }
            },
            // Picture-in-guide: size + offset, never animated (animating a SurfaceView's bounds stutters on low-end boxes).
            modifier = slot.takeIf { pig }?.let { r ->
                with(LocalDensity.current) { Modifier.offset { IntOffset(r.left.toInt(), r.top.toInt()) }.size(r.width.toDp(), r.height.toDp()) }
            } ?: Modifier.fillMaxSize().scaledBy(aspect.scale),
        )
        if (audio && live == null && item != null) AudioScreen(item, pb.api, scrub ?: position, duration, pb.queue, pb.next)
        // Invisible key catcher: owns focus whenever the track panel is closed.
        Box(
            Modifier
                .fillMaxSize()
                .focusRequester(root)
                .focusProperties { canFocus = !pig }
                .onKeyEvent(::onKey)
                .focusable()
                // Touch: a tap shows or hides the OSD.
                .pointerInput(Unit) {
                    detectTapGestures {
                        pb.autoCount = 0
                        if (osd && playing) osd = false else poke()
                    }
                },
        )

        // B03: "Reconnexion…" under the spinner while a dropped stream reloads.
        val notice = pb.notice
        if ((buffering || notice != null) && pb.error == null && !pb.preview && !pig) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(Modifier.size(44.dp), C.label)
                if (notice != null) Text(notice, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 12.dp))
            }
        }

        pb.error?.let { msg ->
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(msg, style = Type.title2, color = C.label)
                Text(stringResource(R.string.back_to_exit), style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 8.dp))
                val first = remember { FocusRequester() }
                // Live retunes on its own (LiveOverlay); VOD: Retry, then another player for codecs Media3 cannot play.
                val retry = live == null && item != null
                if (retry || (onExternal != null && item != null)) LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
                Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (retry) Pill(stringResource(R.string.retry), onClick = pb::retry, icon = Ic.Refresh, modifier = Modifier.focusRequester(first))
                    if (onExternal != null && item != null) {
                        Pill(
                            stringResource(com.wika.wicaby.core.R.string.external_player_open), onClick = onExternal, icon = Ic.External,
                            modifier = if (retry) Modifier else Modifier.focusRequester(first),
                        )
                    }
                }
            }
        }

        // Kept composed in PiP and under the guide (its effects follow the session), only not drawn.
        if (live != null) Box(Modifier.fillMaxSize().graphicsLayer { alpha = if (inPip || pig) 0f else 1f }) { LiveOverlay(live, buffering, aspect) }

        // The playing channel's source (IPTV is not the signed-in server).
        val guideApi = pb.api.takeIf { Wicaby.app.api != null }
        AnimatedVisibility(pig && live != null && guideApi != null, enter = fadeIn(tween(220)), exit = fadeOut(tween(160))) {
            if (live != null && guideApi != null) {
                CompositionLocalProvider(LocalOverlay provides pigHost) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            // The guide's background, with a hole where the video tile is.
                            .drawBehind {
                                val r = slot
                                if (r == null) drawRect(C.bg) else clipRect(r.left, r.top, r.right, r.bottom, ClipOp.Difference) { drawRect(C.bg) }
                            }
                            // GUIDE in the guide: back to the video (spec 10.2).
                            .onKeyEvent { e ->
                                if (e.key != Key.Guide) return@onKeyEvent false
                                if (e.type == KeyEventType.KeyDown) pig = false
                                true
                            },
                    ) {
                        GuideGrid(
                            guideApi, live.repo, onEnter = {}, Modifier.fillMaxSize().padding(top = GuideDims.safeTop),
                            jumpTo = pigJump, onJumped = { pigJump = null },
                            onTune = { live.zap.tune(it) }, onSlot = { slot = it },
                        )
                        OverlayLayer(pigHost)
                    }
                }
            }
        }

        AnimatedVisibility(osd && !panel && item != null && live == null, enter = fadeIn(tween(220)), exit = fadeOut(tween(420))) {
            if (item != null) {
                Osd(
                    item, scrub ?: position, duration, buffered, scrub != null, playing || pb.preview,
                    onScrub = ::scrubTo, onScrubEnd = ::commitScrub, onTracks = { openPanel(PANEL_TRACKS) },
                    aspect = aspect, onAspect = ::cycleAspect,
                    tracksButton = tracksButton, aspectButton = aspectButton,
                    onControlsFocus = { controlsFocused = it }, onControlsKey = ::onControlsKey,
                    thumb = thumb, chapterStarts = chapterStarts,
                    chaptersButton = chaptersButton.takeIf { chapters.isNotEmpty() }, onChapters = { openPanel(PANEL_CHAPTERS) },
                    speed = pb.rate, speedButton = speedButton, onSpeed = { openPanel(PANEL_SPEED) },
                    sleepLeft = sleep?.endsAt?.let { (it - now).coerceAtLeast(0) }, sleepButton = sleepButton, onSleep = { openPanel(PANEL_SLEEP) },
                    songIdButton = songIdButton.takeIf { pb.songIdSource != null }, onSongId = { openPanel(PANEL_SONGID) },
                    now = now,
                    qualityButton = qualityButton.takeIf { pb.canSwitchQuality }, qualityCap = pb.qualityCap, onQuality = { openPanel(PANEL_QUALITY) },
                    queueButton = queueButton.takeIf { queue != null }, queuePosition = queue?.let { it.index + 1 to it.ids.size }, onQueue = { openPanel(PANEL_QUEUE) },
                    togetherButton = togetherButton.takeIf { together }, inGroup = SyncPlay.group != null, onTogether = { openPanel(PANEL_TOGETHER) },
                )
            }
        }

        // X-04 play/pause disc (72 dp, 600 ms) while the controls are hidden.
        AnimatedVisibility(discShown, enter = fadeIn(tween(120)), exit = fadeOut(tween(220)), modifier = Modifier.align(Alignment.Center)) {
            Box(Modifier.size(72.dp).clip(CircleShape).background(C.elevated.copy(alpha = 0.88f)), contentAlignment = Alignment.Center) {
                Icon(if (playing) Ic.Play else Ic.Pause, stringResource(if (playing) R.string.play else com.wika.wicaby.core.R.string.sleep_pause), tint = C.label, modifier = Modifier.size(32.dp))
            }
        }
        // X-04 merged seek badge: the distance actually applied ("+40 s"), announced politely.
        pending?.let { p ->
            val sec = SteppedSeek.appliedSeconds(p)
            Text(
                stringResource(com.wika.wicaby.core.R.string.seek_badge, if (sec < 0) "−" else "+", abs(sec)),
                style = Type.title2, color = C.label,
                modifier = Modifier.align(Alignment.Center).clip(RoundedCornerShape(50)).background(C.elevated.copy(alpha = 0.88f))
                    .semantics { liveRegion = LiveRegionMode.Polite }.padding(horizontal = 24.dp, vertical = 10.dp),
            )
        }

        AnimatedVisibility(
            aspectLabel && !panel,
            enter = fadeIn(tween(160)), exit = fadeOut(tween(420)),
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 48.dp),
        ) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(C.elevated.copy(alpha = 0.92f)).padding(horizontal = 20.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Ic.Aspect, null, tint = C.label, modifier = Modifier.size(18.dp))
                Text(stringResource(aspect.label), style = Type.headline, color = C.label)
            }
        }

        // TP-11: the parental hours end within 15 minutes (the server then refuses): the time left, on screen until then.
        val accessLeft by produceState<Long?>(null, pb.api) {
            while (true) {
                value = AccessSchedules.minutesLeft(AccessSchedules.stored(pb.api.server.id, pb.api.userId), System.currentTimeMillis())?.takeIf { it <= 15 }
                delay(15_000)
            }
        }
        AnimatedVisibility(
            accessLeft != null && pb.error == null && !pb.preview && !inPip && !pig,
            enter = fadeIn(tween(220)), exit = fadeOut(tween(420)),
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 48.dp, end = 56.dp),
        ) {
            Text(
                stringResource(com.wika.wicaby.core.R.string.access_schedule_left, accessLeft ?: 0L),
                style = Type.headline, color = C.label,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(C.elevated.copy(alpha = 0.92f))
                    .semantics { liveRegion = LiveRegionMode.Polite }.padding(horizontal = 20.dp, vertical = 10.dp),
            )
        }

        if (PlaybackStats.visible && !inPip && !pig && !pb.preview) StatsOverlay(pb, Modifier.align(Alignment.TopStart).padding(top = 48.dp, start = 56.dp))

        // Above the OSD's scrub bar when it is showing.
        val cornerBottom = if (osd && !panel) 150.dp else 56.dp
        AnimatedVisibility(
            skipVisible && upNext == null && !panel,
            enter = fadeIn(tween(220)),
            exit = fadeOut(tween(600)),
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 56.dp, bottom = cornerBottom),
        ) {
            val label = when (chipKind) {
                SegmentKind.Recap -> com.wika.wicaby.core.R.string.skip_recap
                SegmentKind.Preview -> com.wika.wicaby.core.R.string.skip_preview
                SegmentKind.Commercial -> com.wika.wicaby.core.R.string.skip_commercial
                SegmentKind.Intro -> R.string.skip_intro
            }
            ActionChip(stringResource(label), Modifier.pointerInput(Unit) { detectTapGestures { skipIntro() } })
        }

        AnimatedVisibility(
            upNext != null && !panel,
            enter = fadeIn(tween(260)) + slideInVertically(tween(320)) { it / 4 },
            exit = fadeOut(tween(200)),
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 56.dp, bottom = cornerBottom),
        ) {
            upNext?.let { UpNextCard(pb.api, it, countdown.takeIf { autoplay }, upNextSeconds, onPlay = { pb.advance(auto = false) }, queued = queue != null) }
        }

        AnimatedVisibility(
            panel,
            enter = fadeIn(tween(200)) + slideInVertically(tween(320)) { it / 3 },
            exit = fadeOut(tween(160)) + slideOutVertically(tween(220)) { it / 3 },
        ) {
            val close = {
                panel = false
                runCatching { root.requestFocus() }
                Unit
            }
            when (panelKind) {
                PANEL_CHAPTERS -> ChapterPanel(pb, chapters, position, onSeek = { ms -> close(); seekTo(ms) }, onClose = close)
                PANEL_SPEED -> SpeedPanel(pb.rate, onSelect = { sp -> pb.setSpeed(sp); close() }, onClose = close)
                PANEL_SYNC -> SyncPanel(pb, onClose = close)
                PANEL_SLEEP -> SleepPanel(sleep, onClose = close)
                PANEL_SONGID -> SongIdPanel(pb, onClose = close)
                PANEL_QUALITY -> QualityPanel(pb, onClose = close)
                PANEL_SUBSEARCH -> SubtitleSearchPanel(pb, onClose = close)
                PANEL_AUDIOFX -> AudioFxPanel(onClose = close)
                PANEL_QUEUE -> QueuePanel(pb, onJump = { i -> close(); pb.jump(i) }, onClose = close)
                PANEL_TOGETHER -> TogetherPanel(pb, onClose = close)
                else -> TrackPanel(pb, onClose = close, onSearch = { panelKind = PANEL_SUBSEARCH }, onAudioFx = { panelKind = PANEL_AUDIOFX }, onSync = { panelKind = PANEL_SYNC })
            }
        }

        if (sleepPromptUntil != null && !stillWatching) {
            StillWatching(
                onContinue = ::sleepContinue,
                onStop = {
                    SleepTimer.cancel()
                    player.pause()
                    runCatching { root.requestFocus() }
                },
                sub = stringResource(com.wika.wicaby.core.R.string.still_watching_pausing_in, ((sleepPromptUntil - now + 999) / 1000).coerceAtLeast(0)),
                stopLabel = stringResource(com.wika.wicaby.core.R.string.sleep_pause),
            )
        }

        if (stillWatching) {
            StillWatching(
                onContinue = {
                    stillWatching = false
                    pb.autoCount = 0
                    if (pb.next != null) pb.advance(auto = false) else player.play()
                    runCatching { root.requestFocus() }
                },
                onStop = onExit,
            )
        }
    }
}

// Looks like a focused pill: OK on the remote accepts it without moving focus.
@Composable
private fun ActionChip(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(RoundedCornerShape(50)).background(Color.White).padding(horizontal = 22.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Ic.Next, null, tint = Color.Black, modifier = Modifier.size(20.dp))
        Text(text, style = Type.headline, color = Color.Black, maxLines = 1)
    }
}

// A control-bar button: quiet text at rest, the tvOS white pill when focused (no ring).
@Composable
private fun OsdButton(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, onClick: () -> Unit, modifier: Modifier = Modifier, description: String? = null, value: String? = null) {
    var focused by remember { mutableStateOf(false) }
    val bg = if (focused) TvFocus.bg else Color.Transparent
    val fg = if (focused) TvFocus.fg else C.label2
    Row(
        modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.06f, sheen = false, elevation = 8.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .semantics { if (description != null) contentDescription = description }
            .padding(horizontal = 14.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(icon, null, tint = fg, modifier = Modifier.size(16.dp))
        // Tabular digits: the sleep countdown would otherwise shift the centred button group every second.
        Text(text, style = Type.caption.copy(fontFeatureSettings = "tnum"), color = fg, maxLines = 1)
        // The setting's current value, dimmer: "Qualité · Originale".
        if (value != null) Text("· $value", style = Type.caption, color = if (focused) Color.Black.copy(alpha = 0.55f) else C.label3, maxLines = 1)
    }
}

// The zoom step: the video view grows past the screen, centred (layout, so SurfaceView follows).
private fun Modifier.scaledBy(s: Float): Modifier = if (s == 1f) this else layout { m, c ->
    val w = (c.maxWidth * s).toInt()
    val h = (c.maxHeight * s).toInt()
    val p = m.measure(Constraints.fixed(w, h))
    layout(c.maxWidth, c.maxHeight) { p.place((c.maxWidth - w) / 2, (c.maxHeight - h) / 2) }
}

@Composable
private fun UpNextCard(api: com.wika.wicaby.core.data.Api, next: Item, countdown: Int?, total: Int, onPlay: () -> Unit, queued: Boolean = false) {
    val w = dpPx(400.dp)
    val url = remember(next.id) { api.thumb(next, w) }
    Column(Modifier.width(400.dp).clip(RoundedCornerShape(Radius.lg)).background(C.elevated.copy(alpha = 0.94f))) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(C.elevated2)) {
            if (url != null) AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            if (countdown != null) {
                Box(
                    Modifier.fillMaxWidth().height(4.dp).align(Alignment.BottomStart).background(Color.White.copy(alpha = 0.22f)),
                ) {
                    Box(Modifier.fillMaxWidth(1f - countdown.toFloat() / total).fillMaxHeight().background(LocalAccent.current))
                }
            }
        }
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 18.dp)) {
            Text(stringResource(if (queued) com.wika.wicaby.core.R.string.queue_up_next else R.string.up_next).uppercase(), style = Type.eyebrow, color = C.label3)
            Text(
                episodeLine(next) ?: next.name, style = Type.headline, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp, bottom = 14.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionChip(stringResource(R.string.play_now), Modifier.pointerInput(Unit) { detectTapGestures { onPlay() } })
                Spacer(Modifier.width(14.dp))
                if (countdown != null) Text(stringResource(R.string.up_next_in, countdown), style = Type.callout, color = C.label2)
            }
        }
    }
}

@Composable
private fun StillWatching(onContinue: () -> Unit, onStop: () -> Unit, sub: String? = null, stopLabel: String? = null) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.width(520.dp).clip(RoundedCornerShape(Radius.xl)).background(C.elevated.copy(alpha = 0.96f)).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.still_watching), style = Type.title2, color = C.label)
            Text(
                sub ?: stringResource(R.string.still_watching_sub), style = Type.callout, color = C.label2,
                modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Pill(stringResource(R.string.keep_watching), onClick = onContinue, primary = true, modifier = Modifier.focusRequester(first))
                Pill(stopLabel ?: stringResource(R.string.stop_watching), onClick = onStop)
            }
        }
    }
}

@Composable
private fun Osd(
    item: Item,
    position: Long,
    duration: Long,
    buffered: Long,
    scrubbing: Boolean,
    playing: Boolean,
    onScrub: (Long) -> Unit,
    onScrubEnd: () -> Unit,
    onTracks: () -> Unit,
    aspect: Aspect,
    onAspect: () -> Unit,
    tracksButton: FocusRequester,
    aspectButton: FocusRequester,
    onControlsFocus: (Boolean) -> Unit,
    onControlsKey: (KeyEvent, FocusRequester) -> Boolean,
    thumb: ImageBitmap?,
    chapterStarts: List<Long>,
    chaptersButton: FocusRequester?,
    onChapters: () -> Unit,
    speed: Float,
    speedButton: FocusRequester,
    onSpeed: () -> Unit,
    sleepLeft: Long?,
    sleepButton: FocusRequester,
    onSleep: () -> Unit,
    songIdButton: FocusRequester?,
    onSongId: () -> Unit,
    now: Long,
    qualityButton: FocusRequester?,
    qualityCap: Int?,
    onQuality: () -> Unit,
    queueButton: FocusRequester? = null,
    queuePosition: Pair<Int, Int>? = null,
    onQueue: () -> Unit = {},
    togetherButton: FocusRequester? = null,
    inGroup: Boolean = false,
    onTogether: () -> Unit = {},
) {
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.86f))))
        Box(Modifier.fillMaxWidth().height(120.dp).background(Brush.verticalGradient(0f to Color.Black.copy(alpha = 0.5f), 1f to Color.Transparent)))
        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(start = 56.dp, end = 56.dp, bottom = 40.dp)) {
            val eyebrow = if (item.isEpisode) item.seriesName else item.productionYear?.toString()
            val title = if (item.isEpisode) episodeLine(item) ?: item.name else item.name
            // The remaining time and "Ends at" sit over the scrub bar's right end (X-02 needed the bar's room
            // for the Quality button in French).
            Row(verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f)) {
                    if (eyebrow != null) Text(eyebrow, style = Type.callout, color = C.label2)
                    Text(title, style = Type.title1, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("-" + clock((duration - position).coerceAtLeast(0)), style = Type.mono, color = C.label2, modifier = Modifier.padding(start = 24.dp))
                // "Ends at": stable while playing (position and clock advance together), follows the clock while paused.
                if (duration > 0) {
                    val end = now + ((duration - position).coerceAtLeast(0) / speed.coerceAtLeast(0.1f)).toLong()
                    Text(
                        "  " + stringResource(com.wika.wicaby.core.R.string.ends_at, android.text.format.DateFormat.getTimeFormat(LocalContext.current).format(java.util.Date(end))),
                        style = Type.caption, color = C.label3,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            ScrubBar(position, duration, buffered, scrubbing, onScrub, onScrubEnd, thumb, chapterStarts)
            // Only the two buttons are focusable here, so hasFocus = "the control bar has focus".
            Row(Modifier.onFocusChanged { onControlsFocus(it.hasFocus) }, verticalAlignment = Alignment.CenterVertically) {
                Icon(if (playing) Ic.Pause else Ic.Play, null, tint = C.label, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(clock(position), style = Type.mono, color = C.label)
                Spacer(Modifier.weight(1f))
                OsdButton(
                    Ic.Subtitles, stringResource(R.string.tracks_hint_touch), onTracks,
                    Modifier.focusRequester(tracksButton).onPreviewKeyEvent { onControlsKey(it, tracksButton) },
                )
                if (chaptersButton != null) {
                    val current = chapterStarts.indexOfLast { it <= position }.coerceAtLeast(0)
                    OsdButton(
                        ChaptersIcon, stringResource(R.string.chip_chapters), onChapters,
                        Modifier.padding(start = 8.dp).focusRequester(chaptersButton).onPreviewKeyEvent { onControlsKey(it, chaptersButton) },
                        description = stringResource(com.wika.wicaby.core.R.string.chapter_position, current + 1, chapterStarts.size, clock(chapterStarts.getOrElse(current) { 0L })),
                    )
                }
                val speedText = speedLabel(speed)
                OsdButton(
                    SpeedIcon, if (speed == 1f) stringResource(R.string.chip_speed) else speedText, onSpeed,
                    Modifier.padding(start = 8.dp).focusRequester(speedButton).onPreviewKeyEvent { onControlsKey(it, speedButton) },
                    description = stringResource(R.string.chip_speed) + ", " + speedText,
                )
                val sleepName = stringResource(com.wika.wicaby.core.R.string.sleep_timer)
                OsdButton(
                    MoonIcon, sleepLeft?.let { clock(it) } ?: stringResource(R.string.chip_sleep), onSleep,
                    Modifier.padding(start = 8.dp).focusRequester(sleepButton).onPreviewKeyEvent { onControlsKey(it, sleepButton) },
                    description = listOfNotNull(sleepName, sleepLeft?.let { clock(it) }).joinToString(", "),
                )
                // "What's this song?": a direct play or a downloaded file (core SongId reads the file again).
                if (songIdButton != null) {
                    OsdButton(
                        MusicNoteIcon, stringResource(com.wika.wicaby.core.R.string.song_id_chip), onSongId,
                        Modifier.padding(start = 8.dp).focusRequester(songIdButton).onPreviewKeyEvent { onControlsKey(it, songIdButton) },
                        description = stringResource(com.wika.wicaby.core.R.string.song_id_title),
                    )
                }
                // TP-04: the queue sheet, while a queue plays; "3/12" on the button.
                if (queueButton != null && queuePosition != null) {
                    val (at, of) = queuePosition
                    OsdButton(
                        QueueIcon, "$at/$of", onQueue,
                        Modifier.padding(start = 8.dp).focusRequester(queueButton).onPreviewKeyEvent { onControlsKey(it, queueButton) },
                        description = stringResource(com.wika.wicaby.core.R.string.queue) + ", " + stringResource(com.wika.wicaby.core.R.string.queue_position, at, of),
                    )
                }
                // Jellyfin SyncPlay: "Regarder ensemble", selected while in a group.
                if (togetherButton != null) {
                    val name = stringResource(com.wika.wicaby.core.R.string.syncplay_title)
                    OsdButton(
                        Ic.Group, name, onTogether,
                        Modifier.padding(start = 8.dp).focusRequester(togetherButton).onPreviewKeyEvent { onControlsKey(it, togetherButton) },
                        value = SyncPlay.group?.participants?.size?.toString()?.takeIf { inGroup },
                    )
                }
                Spacer(Modifier.weight(1f))
                // X-02: the Quality sheet, beside the picture format: "Qualité · Originale" / "Qualité · 720p".
                if (qualityButton != null) {
                    val qualityName = stringResource(com.wika.wicaby.core.R.string.quality)
                    val value = qualityShortLabel(LocalContext.current, qualityCap)
                    OsdButton(
                        Ic.Gear, qualityName, onQuality,
                        Modifier.padding(end = 8.dp).focusRequester(qualityButton).onPreviewKeyEvent { onControlsKey(it, qualityButton) },
                        description = qualityName + ", " + qualityLabel(LocalContext.current, qualityCap),
                        value = value,
                    )
                }
                // Bottom-right: Ajuster / Remplir l'écran / Étirer / Zoom; OK cycles.
                OsdButton(
                    Ic.Aspect, stringResource(aspect.label), onAspect,
                    Modifier.focusRequester(aspectButton).onPreviewKeyEvent { onControlsKey(it, aspectButton) },
                    description = stringResource(com.wika.wicaby.core.R.string.aspect_value, stringResource(aspect.label)),
                )
            }
        }
    }
}

@Composable
private fun ScrubBar(
    position: Long,
    duration: Long,
    buffered: Long,
    scrubbing: Boolean,
    onScrub: (Long) -> Unit,
    onScrubEnd: () -> Unit,
    thumb: ImageBitmap?,
    chapterStarts: List<Long>,
) {
    val f = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
    val b = if (duration > 0) (buffered.toFloat() / duration).coerceIn(0f, 1f) else 0f
    fun at(x: Float, width: Int) = (duration * (x / width).coerceIn(0f, 1f)).toLong()
    BoxWithConstraints(
        Modifier
            .fillMaxWidth()
            .pointerInput(duration) {
                detectHorizontalDragGestures(
                    onDragStart = { onScrub(at(it.x, size.width)) },
                    onDragEnd = onScrubEnd,
                    onDragCancel = onScrubEnd,
                ) { change, _ -> onScrub(at(change.position.x, size.width)) }
            }
            .pointerInput(duration) {
                detectTapGestures { onScrub(at(it.x, size.width)); onScrubEnd() }
            }
            // A taller touch target than the 8 dp bar.
            .padding(vertical = 12.dp)
            // Fixed height: growing while scrubbing would push the title and clocks up on every seek.
            .height(44.dp),
        contentAlignment = Alignment.BottomStart,
    ) {
        val w = maxWidth
        Box(
            Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.22f))
                // Chapter starts: thin gaps across the bar.
                .drawWithContent {
                    drawContent()
                    if (duration > 0) chapterStarts.forEach { s ->
                        if (s in 1 until duration) drawRect(Color.Black.copy(alpha = 0.6f), Offset(size.width * s / duration - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
                    }
                },
        ) {
            Box(Modifier.fillMaxWidth(b).fillMaxHeight().background(Color.White.copy(alpha = 0.22f)))
            Box(Modifier.fillMaxWidth(f).fillMaxHeight().clip(CircleShape).background(Color.White))
        }
        if (scrubbing && thumb != null) {
            // 320 px wide over the target, the time label under it.
            val tw = with(LocalDensity.current) { 320.toDp() }
            val th = tw * (thumb.height.toFloat() / thumb.width.coerceAtLeast(1))
            Image(
                thumb, null, contentScale = ContentScale.Crop,
                modifier = Modifier
                    .offset(x = (w * f - tw / 2).coerceIn(0.dp, (w - tw).coerceAtLeast(0.dp)), y = (-48).dp)
                    // The frame is taller than this 44 dp box: let it overflow upwards instead of being clamped and cropped.
                    .wrapContentSize(Alignment.BottomStart, unbounded = true)
                    .size(tw, th)
                    .clip(RoundedCornerShape(Radius.sm))
                    .background(Color.Black),
            )
        }
        if (scrubbing) {
            Text(
                clock(position), style = Type.mono, color = Color.Black,
                modifier = Modifier
                    .offset(x = (w * f - 34.dp).coerceIn(0.dp, w - 68.dp), y = (-18).dp)
                    .clip(RoundedCornerShape(Radius.xs))
                    .background(Color.White)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
    }
}

@Composable
private fun TrackPanel(pb: Playback, onClose: () -> Unit, onSearch: () -> Unit, onAudioFx: () -> Unit, onSync: () -> Unit) {
    val memory = remember { FocusMemory(null) }
    val audio = pb.streams.filter { it.type == "Audio" }
    val subs = pb.streams.filter { it.type == "Subtitle" }
    val off = stringResource(R.string.subtitles_off)
    // X-03: "Rechercher des sous-titres…" ends the subtitle column, unless the policy is known to forbid it.
    val allowed by produceState(true, pb.item?.id) { value = SubtitleSearch.allowed(pb.api) }
    val searchRow = if (pb.canSearchSubtitles && allowed) listOf(SEARCH_ROW to stringResource(com.wika.wicaby.core.R.string.subsearch_row)) else emptyList()
    // TP-01: "Effets audio…" ends the audio column.
    val fxRow = if (audio.isEmpty()) emptyList() else listOf(AUDIO_FX_ROW to stringResource(com.wika.wicaby.core.R.string.audio_fx_row))
    // Audio delay and subtitle offset.
    val syncRow = listOf(SYNC_ROW to stringResource(com.wika.wicaby.core.R.string.sync_row))
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)).pointerInput(Unit) { detectTapGestures { onClose() } })
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(280.dp)
                // The text stays 56 dp in (inside the 48 dp overscan margin); five columns need the room.
                .padding(start = 32.dp, end = 32.dp, bottom = 32.dp)
                .clip(RoundedCornerShape(Radius.xl))
                .background(C.elevated.copy(alpha = 0.96f))
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            // Weights: the short columns keep their uppercase titles ("TAILLE DU TEXTE", "INFOS DE LECTURE") on one line.
            TrackColumn(
                stringResource(R.string.audio), Modifier.weight(1.3f), memory, "a",
                audio.map { it.index to label(it) } + fxRow + syncRow, pb.audioIndex ?: audio.firstOrNull { it.isDefault }?.index,
                { i -> if (i == AUDIO_FX_ROW) onAudioFx() else if (i == SYNC_ROW) onSync() else pb.selectAudio(i) }, defaultColumn = true,
            )
            TrackColumn(
                stringResource(R.string.subtitles), Modifier.weight(1.3f), memory, "s",
                listOf(-1 to off) + subs.map { it.index to label(it) } + searchRow, pb.subtitleIndex ?: -1,
                { i -> if (i == SEARCH_ROW) onSearch() else pb.selectSubtitle(i) }, defaultColumn = audio.isEmpty(),
            )
            // Quick subtitle look, the same prefs as Réglages > Lecture > Sous-titres.
            TrackColumn(
                stringResource(R.string.subtitle_size), Modifier.weight(1f), memory, "z",
                listOf(R.string.size_small, R.string.size_normal, R.string.size_large, R.string.size_xlarge).mapIndexed { i, r -> i to stringResource(r) },
                TvSettings.subtitleSize.value, { TvSettings.subtitleSize.value = it }, defaultColumn = false,
            )
            TrackColumn(
                stringResource(R.string.subtitle_position), Modifier.weight(1f), memory, "p",
                SUB_POSITION_LABELS.mapIndexed { i, r -> i to stringResource(r) },
                TvSettings.subtitlePosition.value, { TvSettings.subtitlePosition.value = it }, defaultColumn = false,
            )
            // Playback info: the stats panel (top left); stays on for the next videos.
            TrackColumn(
                stringResource(com.wika.wicaby.core.R.string.stats_title), Modifier.weight(1.1f), memory, "i",
                listOf(0 to stringResource(R.string.off), 1 to stringResource(R.string.on)),
                if (PlaybackStats.visible) 1 else 0, { PlaybackStats.visible = it == 1 }, defaultColumn = false,
            )
        }
    }
}

private const val SEARCH_ROW = -2
private const val AUDIO_FX_ROW = -3
private const val SYNC_ROW = -4

internal val SUB_POSITION_LABELS = listOf(R.string.sub_pos_bottom, R.string.sub_pos_slightly_raised, R.string.sub_pos_raised)

// X-03 subtitle search (from the subtitle column): language pills, the title filter (on-screen keyboard, or
// voice when a speech handler resolves), the results. The first result takes focus; OK downloads it (the
// row spins), then the player reloads with the new track and toasts. Back closes only this sheet.
@Composable
private fun SubtitleSearchPanel(pb: Playback, onClose: () -> Unit) {
    val api = pb.api
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val search = remember { SubtitleSearch(ctx, pb, api, scope) }
    LaunchedEffect(Unit) { search.open() }
    val first = remember { FocusRequester() }
    val shown = search.shown
    LaunchedEffect(search.results) {
        if (search.results.isNullOrEmpty()) return@LaunchedEffect
        repeat(8) {
            delay(32)
            if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
    val voiceIntent = remember { Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM) }
    val canVoice = remember { voiceIntent.resolveActivity(ctx.packageManager) != null }
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let(search::filter)
    }
    val langLabel = stringResource(com.wika.wicaby.core.R.string.subsearch_language)
    Sheet(stringResource(com.wika.wicaby.core.R.string.subsearch_title), onClose) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.semantics { contentDescription = langLabel }.dpadEdges()) {
            items(SubtitleSearch.LANGUAGES) { (code, _) ->
                Pill(SubtitleSearch.languageName(code), onClick = { search.pickLanguage(code) }, selected = code == search.language)
            }
        }
        Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TvTextField(search.title, search::filter, stringResource(com.wika.wicaby.core.R.string.subsearch_title_filter), Modifier.weight(1f))
            if (canVoice) Pill(stringResource(com.wika.wicaby.core.R.string.subsearch_voice), onClick = { voice.launch(voiceIntent) })
        }
        val failure = search.failure
        val note = when {
            failure == SubtitleRules.Failure.NO_PROVIDER -> com.wika.wicaby.core.R.string.subsearch_no_provider
            failure == SubtitleRules.Failure.FORBIDDEN -> com.wika.wicaby.core.R.string.subsearch_forbidden
            failure != null -> com.wika.wicaby.core.R.string.subsearch_failed
            shown?.isEmpty() == true -> com.wika.wicaby.core.R.string.subsearch_empty
            else -> null
        }
        if (note != null) {
            Text(stringResource(note), style = Type.body, color = C.label2, modifier = Modifier.padding(top = 14.dp, start = 6.dp).semantics { liveRegion = LiveRegionMode.Polite })
        } else if (shown == null) {
            Spinner(Modifier.padding(top = 18.dp, start = 6.dp).size(22.dp))
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 260.dp).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(shown.orEmpty(), key = { _, r -> r.id }) { i, r ->
                var focused by remember { mutableStateOf(false) }
                val bg = if (focused) TvFocus.bg else Color.Transparent
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(if (i == 0) Modifier.focusRequester(first) else Modifier)
                        .tvFocus(RoundedCornerShape(Radius.sm), focusedScale = 1.02f, sheen = false, elevation = 6.dp, onFocusChange = { focused = it }, onClick = { search.pick(r, onClose) })
                        .background(bg)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(r.name ?: r.id, style = Type.body, color = if (focused) TvFocus.fg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(subtitleMeta(r), style = Type.caption, color = if (focused) TvFocus.fg.copy(alpha = 0.7f) else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box(Modifier.width(26.dp)) { if (search.busy == r.id) Spinner(Modifier.size(16.dp), color = if (focused) TvFocus.fg else C.label2) }
                }
            }
        }
    }
}

// "Open Subtitles · SRT · ★ 8,7 · 1 520 téléchargements · Correspondance parfaite": the flags are text.
@Composable
private fun subtitleMeta(r: RemoteSubtitle): String {
    val nf = NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 1 }
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
private fun label(s: MediaStream): String =
    listOfNotNull(s.displayTitle ?: s.title ?: s.language ?: stringResource(R.string.track_unknown, s.index), TrackMemory.badge(s)).joinToString(" · ")

@Composable
private fun TrackColumn(
    title: String,
    modifier: Modifier,
    memory: FocusMemory,
    prefix: String,
    options: List<Pair<Int, String>>,
    selected: Int?,
    onSelect: (Int) -> Unit,
    defaultColumn: Boolean,
    busy: Int? = null,
) {
    val accent = LocalAccent.current
    // Only composed rows can take focus: open scrolled to the selected one, else focus the first.
    val selRow = options.indexOfFirst { it.first == selected }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = selRow.coerceAtLeast(0))
    Column(modifier) {
        Text(title.uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 14.dp, bottom = 10.dp))
        LazyColumn(state = list, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(options, key = { _, o -> o.first }) { row, (index, text) ->
                var focused by remember { mutableStateOf(false) }
                val bg = if (focused) TvFocus.bg else Color.Transparent
                val isSel = index == selected
                Row(
                    Modifier
                        .fillMaxWidth()
                        .remembered(memory, "$prefix$index", default = defaultColumn && (isSel || (selRow < 0 && row == 0)))
                        .tvFocus(RoundedCornerShape(Radius.sm), focusedScale = 1.02f, sheen = false, elevation = 6.dp, onFocusChange = { focused = it }, onClick = { onSelect(index) })
                        .background(bg)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(26.dp)) {
                        if (index == busy) Spinner(Modifier.size(16.dp), color = if (focused) TvFocus.fg else C.label2)
                        else if (isSel) Icon(Ic.Check, null, tint = if (focused) TvFocus.fg else accent, modifier = Modifier.size(18.dp))
                    }
                    Text(text, style = Type.body, color = if (focused) TvFocus.fg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

private fun styleSubtitles(view: SubtitleView, ass: AssHandler) {
    val sizeIndex = TvSettings.subtitleSize.value
    view.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * SubtitleLook.size(sizeIndex))
    view.setBottomPaddingFraction(SubtitleLook.bottomPadding(TvSettings.subtitlePosition.value))
    view.setApplyEmbeddedStyles(false)
    val fg = SubtitleLook.color(TvSettings.subtitleColor.value)
    val font = SubtitleLook.font(TvSettings.subtitleFont.value)
    val face = if (font == "geist") ResourcesCompat.getFont(view.context, com.wika.wicaby.core.R.font.geist_medium) else Typeface.create(font, Typeface.NORMAL)
    val clear = android.graphics.Color.TRANSPARENT
    view.setStyle(
        when (TvSettings.subtitleStyle.value) {
            1 -> CaptionStyleCompat(fg, clear, clear, CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, android.graphics.Color.BLACK, face)
            2 -> CaptionStyleCompat(fg, 0xB3000000.toInt(), clear, CaptionStyleCompat.EDGE_TYPE_NONE, clear, face)
            else -> CaptionStyleCompat(fg, clear, clear, CaptionStyleCompat.EDGE_TYPE_OUTLINE, android.graphics.Color.BLACK, face)
        },
    )
    // libass: the size only, and only with the ASS override on (its render may not exist yet).
    ass.setFontScale(SubtitleLook.assFontScale(sizeIndex, TvSettings.subtitleOverrideAss.value))
}

private const val PANEL_TRACKS = 0
private const val PANEL_CHAPTERS = 1
private const val PANEL_SPEED = 2
private const val PANEL_SLEEP = 3
private const val PANEL_QUALITY = 4
private const val PANEL_SUBSEARCH = 5
private const val PANEL_AUDIOFX = 6
private const val PANEL_QUEUE = 7
private const val PANEL_SYNC = 8
private const val PANEL_TOGETHER = 9
private const val PANEL_SONGID = 10

// X-02 Quality sheet, laid out like the track panel: Version (2 or more sources, never live) and Quality
// (Original, then the presets). OK reloads in place with a spinner on the row; the sheet closes once the
// switch took and stays open on a failure (its toast says so).
@Composable
private fun QualityPanel(pb: Playback, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val res = androidx.compose.ui.platform.LocalResources.current
    val memory = remember { FocusMemory(null) }
    val versions = pb.versions
    val labels = remember(pb.item?.id) { pb.versionLabels() }
    val rows = remember(pb.item?.id, pb.sourceId) { pb.qualityRows() }
    val tag = stringResource(if (pb.playMethod == "Transcode") com.wika.wicaby.core.R.string.play_method_transcode else com.wika.wicaby.core.R.string.play_method_direct)
    val cap = pb.qualityCap?.takeIf { it < Quality.ORIGINAL }
    val versionSel = versions.indexOfFirst { it.id == pb.sourceId }
    val rowSel = rows.indexOfFirst { it.maxBitrate == cap }
    // The method tag waits for the new stream. The row being switched to: column ('v' or 'q') and index.
    var busy by remember { mutableStateOf<Pair<Char, Int>?>(null) }
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) { if (done) onClose() }
    fun pick(column: Char, i: Int, sourceId: String?, maxBitrate: Int?) {
        if (pb.switching) return
        busy = column to i
        pb.switchQuality(sourceId, maxBitrate) { ok -> busy = null; done = ok }
    }
    val original = stringResource(com.wika.wicaby.core.R.string.quality_original)
    val sizeOf = { size: Long?, percent: Int? ->
        size?.let { b -> android.text.format.Formatter.formatShortFileSize(ctx, b).let { f -> percent?.let { res.getString(com.wika.wicaby.core.R.string.quality_size, f, it) } ?: f } }
    }
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)).pointerInput(Unit) { detectTapGestures { onClose() } })
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(320.dp)
                .padding(start = 48.dp, end = 48.dp, bottom = 32.dp)
                .clip(RoundedCornerShape(Radius.xl))
                .background(C.elevated.copy(alpha = 0.96f))
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(32.dp),
        ) {
            if (versions.isNotEmpty()) {
                TrackColumn(
                    stringResource(com.wika.wicaby.core.R.string.quality_version), Modifier.weight(1f), memory, "v",
                    versions.mapIndexed { i, v -> i to listOfNotNull(labels.getOrNull(i) ?: v.id, tag.takeIf { i == versionSel && !pb.switching }, sizeOf(v.size, null)).joinToString(" · ") },
                    versionSel, { i -> if (i != versionSel) pick('v', i, versions[i].id, cap) }, defaultColumn = true,
                    busy = busy?.takeIf { it.first == 'v' }?.second,
                )
            }
            TrackColumn(
                stringResource(com.wika.wicaby.core.R.string.quality), Modifier.weight(1.3f), memory, "q",
                rows.mapIndexed { i, r ->
                    val name = if (r.maxBitrate == null) listOfNotNull(original, r.height?.let { "${it}p" }).joinToString(" · ") else qualityLabel(ctx, r.maxBitrate)
                    i to listOfNotNull(name, tag.takeIf { i == rowSel && !pb.switching }, sizeOf(r.size, r.percent)).joinToString(" · ")
                },
                rowSel, { i -> if (i != rowSel) pick('q', i, null, rows[i].maxBitrate) }, defaultColumn = versions.isEmpty(),
                busy = busy?.takeIf { it.first == 'q' }?.second,
            )
        }
    }
}

// Jellyfin SyncPlay: in a group, who is in it and Leave; otherwise a new group on this video (at this
// position) or one of the server's groups.
@Composable
private fun TogetherPanel(pb: Playback, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    FocusOnOpen(first)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val group = SyncPlay.group
    val groups = rememberSyncGroups(pb.api).value
    Sheet(stringResource(com.wika.wicaby.core.R.string.syncplay_title), onClose) {
        if (group != null) {
            Text(
                stringResource(com.wika.wicaby.core.R.string.syncplay_members, group.participants.joinToString(", ")),
                style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 12.dp),
            )
        } else if (groups?.isEmpty() == true) {
            Text(stringResource(com.wika.wicaby.core.R.string.syncplay_none), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 12.dp))
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.dpadEdges()) {
            if (group != null) {
                item { Pill(stringResource(com.wika.wicaby.core.R.string.syncplay_leave), icon = Ic.Logout, onClick = { SyncPlay.leave(); onClose() }, modifier = Modifier.focusRequester(first)) }
            } else {
                item {
                    Pill(stringResource(com.wika.wicaby.core.R.string.syncplay_new), icon = Ic.Group, modifier = Modifier.focusRequester(first), onClick = {
                        syncAct(scope, context, onClose) { SyncPlay.create(pb.api, syncGroupName(), pb.itemId, pb.player.currentPosition) }
                    })
                }
                items(groups.orEmpty()) { g ->
                    Pill(g.label(), icon = Ic.Person, onClick = { syncAct(scope, context, onClose) { SyncPlay.join(pb.api, g.id) } })
                }
            }
        }
    }
}

private val SLEEP_MINUTES = listOf(5, 10, 15, 30, 45, 60, 90, 120)

// X-04 sleep timer sheet: +15 min and Cancel while a timer runs, then end of this video and the durations.
@Composable
private fun SleepPanel(sleep: SleepTimer.State?, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    FocusOnOpen(first)
    val pick = { action: () -> Unit -> action(); onClose() }
    Sheet(stringResource(com.wika.wicaby.core.R.string.sleep_timer), onClose) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.dpadEdges()) {
            if (sleep != null) {
                if (sleep.endsAt != null) item { Pill(stringResource(com.wika.wicaby.core.R.string.sleep_extend), onClick = { pick { SleepTimer.extend() } }, modifier = Modifier.focusRequester(first)) }
                item { Pill(stringResource(com.wika.wicaby.core.R.string.sleep_cancel), onClick = { pick { SleepTimer.cancel() } }, modifier = if (sleep.endsAt == null) Modifier.focusRequester(first) else Modifier) }
            }
            item {
                val on = sleep != null && sleep.minutes == null
                Pill(stringResource(com.wika.wicaby.core.R.string.sleep_end_of_video), onClick = { pick { SleepTimer.start(null) } }, modifier = if (sleep == null) Modifier.focusRequester(first) else Modifier, selected = on)
            }
            items(SLEEP_MINUTES) { m ->
                Pill(stringResource(com.wika.wicaby.core.R.string.sleep_minutes, m), onClick = { pick { SleepTimer.start(m) } }, selected = sleep?.minutes == m)
            }
        }
    }
}

// "What's this song?" (core SongId): the notice before the first use, then the card: cover, title, artist, album, search
// links, and the track in this server's music with Play Later (queued after this video).
@Composable
private fun SongIdPanel(pb: Playback, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }
    var noticeSeen by remember { mutableStateOf(SongId.noticeSeen) }
    var outcome by remember { mutableStateOf<SongId.Outcome?>(null) }
    var busy by remember { mutableStateOf(false) }
    // null: not looked up yet; false: not in the library.
    var found by remember { mutableStateOf<Any?>(null) }
    var queued by remember { mutableStateOf(false) }
    fun identify() {
        if (!noticeSeen) {
            SongId.noticeSeen = true
            noticeSeen = true
        }
        busy = true
        outcome = null
        found = null
        scope.launch {
            outcome = SongId.identify(ctx, Core.http, pb.songIdSource, pb.player.currentPosition)
            busy = false
        }
    }
    LaunchedEffect(Unit) { if (noticeSeen) identify() }
    FocusOnOpen(first)
    Sheet(stringResource(com.wika.wicaby.core.R.string.song_id_title), onClose) {
        val song = outcome?.song
        when {
            !noticeSeen -> Column {
                Text(stringResource(com.wika.wicaby.core.R.string.song_id_notice), style = Type.body, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 16.dp))
                Pill(stringResource(com.wika.wicaby.core.R.string.song_id_identify), onClick = ::identify, modifier = Modifier.focusRequester(first), primary = true)
            }
            busy -> Text(stringResource(com.wika.wicaby.core.R.string.song_id_listening), style = Type.body, color = C.label2, modifier = Modifier.padding(start = 6.dp).focusRequester(first).focusable())
            song != null -> Column {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 6.dp, bottom = 16.dp)) {
                    if (song.coverUrl != null) AsyncImage(song.coverUrl, null, contentScale = ContentScale.Crop, modifier = Modifier.size(96.dp).clip(RoundedCornerShape(Radius.md)))
                    Column(Modifier.padding(start = 16.dp)) {
                        Text(song.title, style = Type.title2, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(song.artist, style = Type.body, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        song.album?.let { Text(it, style = Type.caption, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
                // A TV may have no browser: a link is offered only when something opens it.
                val links = remember(song) {
                    ShazamSignature.links(song).map { (id, url) -> SONG_LINK_NAMES.getValue(id) to Intent(Intent.ACTION_VIEW, Uri.parse(url)) }
                        .filter { it.second.resolveActivity(ctx.packageManager) != null }
                }
                LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.dpadEdges()) {
                    item {
                        val f = found
                        when {
                            f is Item -> Pill(
                                stringResource(if (queued) com.wika.wicaby.core.R.string.song_id_queued else com.wika.wicaby.core.R.string.song_id_play_later),
                                onClick = { if (!queued) queued = pb.enqueue(listOf(f.id), playNext = false) },
                                modifier = Modifier.focusRequester(first), primary = true,
                            )
                            f == false -> Pill(stringResource(com.wika.wicaby.core.R.string.song_id_not_in_library), onClick = {}, modifier = Modifier.focusRequester(first))
                            else -> Pill(
                                stringResource(com.wika.wicaby.core.R.string.song_id_find_in_library),
                                onClick = { scope.launch { found = runCatching { SongId.findInLibrary(pb.api, song) }.getOrNull() ?: false } },
                                modifier = Modifier.focusRequester(first), icon = Ic.Search,
                            )
                        }
                    }
                    items(links) { (name, intent) ->
                        Pill(name, onClick = { runCatching { ctx.startActivity(intent) } }, icon = Ic.External)
                    }
                }
            }
            else -> Column {
                val err = when (outcome?.error) {
                    SongId.Error.NOMATCH -> com.wika.wicaby.core.R.string.song_id_error_nomatch
                    SongId.Error.RATE_LIMITED -> com.wika.wicaby.core.R.string.song_id_error_rate_limited
                    SongId.Error.UNAVAILABLE -> com.wika.wicaby.core.R.string.song_id_error_unavailable
                    else -> com.wika.wicaby.core.R.string.song_id_error_failed
                }
                Text(stringResource(err), style = Type.body, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 16.dp))
                Pill(stringResource(com.wika.wicaby.core.R.string.song_id_identify), onClick = ::identify, modifier = Modifier.focusRequester(first))
            }
        }
    }
}

// Brand names, not translated.
private val SONG_LINK_NAMES = mapOf("shazam" to "Shazam", "spotify" to "Spotify", "youtube" to "YouTube", "apple" to "Apple Music")

private val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

@Composable
private fun speedLabel(s: Float): String =
    stringResource(com.wika.wicaby.core.R.string.speed_value, NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 2 }.format(s))

// A bottom sheet over the picture, like the track panel.
@Composable
private fun Sheet(title: String, onClose: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)).pointerInput(Unit) { detectTapGestures { onClose() } })
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(start = 48.dp, end = 48.dp, bottom = 32.dp)
                .clip(RoundedCornerShape(Radius.xl))
                .background(C.elevated.copy(alpha = 0.96f))
                .padding(24.dp),
        ) {
            Text(title.uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 6.dp, bottom = 14.dp))
            content()
        }
    }
}

// Focus goes to [target] once it is composed (lazy rows compose a frame late).
@Composable
private fun FocusOnOpen(target: FocusRequester) {
    LaunchedEffect(Unit) {
        repeat(8) {
            delay(32)
            if (runCatching { target.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
}

// Chapter cards (still, name, start); the current one has focus, OK seeks to it.
@Composable
private fun ChapterPanel(pb: Playback, chapters: List<IndexedValue<Chapter>>, position: Long, onSeek: (Long) -> Unit, onClose: () -> Unit) {
    val api = pb.api
    val item = pb.item ?: return
    val current = remember { chapters.indexOfLast { it.value.startPositionTicks / TICKS_PER_MS <= position }.coerceAtLeast(0) }
    val first = remember { FocusRequester() }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (current - 1).coerceAtLeast(0))
    FocusOnOpen(first)
    Sheet(stringResource(com.wika.wicaby.core.R.string.chapters), onClose) {
        LazyRow(state = list, modifier = Modifier.dpadEdges(), horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)) {
            items(chapters.size, key = { chapters[it].index }) { i ->
                val (index, ch) = chapters[i]
                val start = ch.startPositionTicks / TICKS_PER_MS
                var focused by remember { mutableStateOf(false) }
                val a11y = stringResource(com.wika.wicaby.core.R.string.chapter_position, i + 1, chapters.size, clock(start))
                val name = ch.name?.takeIf { it.isNotBlank() }
                Column(
                    Modifier
                        .width(240.dp)
                        .then(if (i == current) Modifier.focusRequester(first) else Modifier)
                        .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.05f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = { onSeek(start) })
                        .background(if (focused) TvFocus.bg else Color.Transparent)
                        .semantics { contentDescription = listOfNotNull(a11y, name).joinToString(", ") }
                        .padding(8.dp),
                ) {
                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.sm)).background(C.elevated2)) {
                        if (ch.imageTag != null) AsyncImage(api.chapterImage(item.id, index, ch.imageTag), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    }
                    Text(name ?: a11y, style = Type.callout, color = if (focused) TvFocus.fg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                    Text(clock(start), style = Type.mono, color = if (focused) TvFocus.fg.copy(alpha = 0.62f) else C.label2)
                }
            }
        }
    }
}

@Composable
private fun SpeedPanel(current: Float, onSelect: (Float) -> Unit, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    FocusOnOpen(first)
    // A bitstream (HDMI passthrough) plays at 1x only: the other speeds stay focusable but dimmed and inert, as in AudioFxPanel.
    val bitstream = AudioFx.bitstream
    Sheet(stringResource(com.wika.wicaby.core.R.string.speed), onClose) {
        if (bitstream) Text(stringResource(com.wika.wicaby.core.R.string.speed_bitstream), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SPEEDS.forEach { sp ->
                val selected = abs(sp - current) < 0.01f
                val off = bitstream && sp != 1f
                Pill(
                    speedLabel(sp), onClick = { if (!off) onSelect(sp) },
                    modifier = (if (selected) Modifier.focusRequester(first) else Modifier).then(if (off) Modifier.alpha(0.4f).semantics { disabled() } else Modifier),
                    selected = selected,
                )
            }
        }
    }
}

// Audio delay (50 ms steps) and subtitle offset (100 ms steps), each with a reset; "Whole series" on an episode.
// Values apply at once and are remembered per video (Playback.adjustDelay, AvSync).
@Composable
private fun SyncPanel(pb: Playback, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    FocusOnOpen(first)
    Sheet(stringResource(com.wika.wicaby.core.R.string.sync_title), onClose) {
        Text(stringResource(com.wika.wicaby.core.R.string.sync_hint), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SyncRow(stringResource(com.wika.wicaby.core.R.string.sync_audio), pb.audioDelayMs, AvSync.AUDIO_STEP_MS, first) { pb.adjustDelay(audio = true, deltaMs = it) }
            SyncRow(stringResource(com.wika.wicaby.core.R.string.sync_subtitles), pb.subtitleDelayMs, AvSync.SUBTITLE_STEP_MS, null) { pb.adjustDelay(audio = false, deltaMs = it) }
            if (pb.canSyncSeries) {
                Pill(stringResource(com.wika.wicaby.core.R.string.sync_series), onClick = { pb.toggleSyncSeries() }, icon = if (pb.syncSeries) Ic.Check else null, selected = pb.syncSeries)
            }
        }
    }
}

// "Audio delay  +50 ms   [-50 ms] [+50 ms] [Reset]"; [onStep] gets +-step, or null to reset.
@Composable
private fun SyncRow(title: String, ms: Int, step: Int, focus: FocusRequester?, onStep: (Int?) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = Type.headline, color = C.label, modifier = Modifier.width(260.dp).padding(start = 6.dp))
        Text(syncLabel(ms), style = Type.mono, color = C.label, modifier = Modifier.width(110.dp).semantics { liveRegion = LiveRegionMode.Polite })
        Pill(syncLabel(-step), onClick = { onStep(-step) }, modifier = focus?.let { Modifier.focusRequester(it) } ?: Modifier)
        Pill(syncLabel(step), onClick = { onStep(step) })
        Pill(stringResource(com.wika.wicaby.core.R.string.sync_reset), onClick = { onStep(null) })
    }
}

// "+50 ms", "−100 ms", "0 ms" (a real minus sign).
@Composable
private fun syncLabel(ms: Int): String =
    stringResource(com.wika.wicaby.core.R.string.sync_ms, (if (ms > 0) "+" else if (ms < 0) "−" else "") + NumberFormat.getInstance(Core.locale).format(abs(ms)))

// The playback info panel (top left), refreshed every second while shown. Sofa-sized text; nothing in it
// takes focus, so the D-pad keeps driving the player.
@Composable
private fun StatsOverlay(pb: Playback, modifier: Modifier) {
    val ctx = LocalContext.current
    val rows by produceState(emptyList<Pair<String, String>>(), pb) {
        while (true) {
            value = PlaybackStats.rows(ctx, pb.stats())
            delay(1_000)
        }
    }
    Column(modifier.clip(RoundedCornerShape(Radius.lg)).background(Color.Black.copy(alpha = 0.72f)).padding(horizontal = 18.dp, vertical = 14.dp)) {
        Text(stringResource(com.wika.wicaby.core.R.string.stats_title).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(bottom = 8.dp))
        rows.forEach { (label, value) ->
            Row {
                Text(label, style = Type.callout, color = C.label2, modifier = Modifier.width(180.dp))
                Text(value, style = Type.callout, color = Color.White, modifier = Modifier.widthIn(max = 480.dp))
            }
        }
    }
}

// TP-01 audio effects (core AudioFx): OK toggles one, live. A bitstream track (HDMI passthrough) cannot be
// processed: the pills stay focusable (D-pad, Back) but dimmed and inert, with the reason above them.
@Composable
private fun AudioFxPanel(onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    FocusOnOpen(first)
    val bitstream = AudioFx.bitstream
    Sheet(stringResource(com.wika.wicaby.core.R.string.audio_fx), onClose) {
        if (bitstream) Text(stringResource(com.wika.wicaby.core.R.string.audio_fx_bitstream), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 6.dp, bottom = 14.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = (if (bitstream) Modifier.alpha(0.4f) else Modifier).dpadEdges()) {
            itemsIndexed(TvSettings.audioFx) { i, (label, s) ->
                val on = s.value
                Pill(
                    stringResource(label), onClick = { if (!bitstream) s.value = !on },
                    modifier = (if (i == 0) Modifier.focusRequester(first) else Modifier).semantics { if (bitstream) disabled() },
                    icon = if (on) Ic.Check else null, selected = on,
                )
            }
        }
    }
}

// Player-only glyphs (Material "list" and "speed"), filled like the rest of Ic.
private fun glyph(d: String) = androidx.compose.ui.graphics.vector.ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    .addPath(androidx.compose.ui.graphics.vector.addPathNodes(d), fill = androidx.compose.ui.graphics.SolidColor(Color.White))
    .build()

private val ChaptersIcon = glyph("M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z")
private val MoonIcon = glyph("M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z")
private val SpeedIcon = glyph("M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z")

// TP-04 queue sheet: the entries in order, the playing one marked and focused. OK plays an entry now;
// right reaches its remove button. Titles load by batches of 100 (Ids=).
@Composable
private fun QueuePanel(pb: Playback, onJump: (Int) -> Unit, onClose: () -> Unit) {
    val api = pb.api
    val q = pb.queue ?: return
    val known = remember { mutableStateMapOf<String, Item>() }
    LaunchedEffect(q.ids.size) {
        q.ids.filter { it !in known }.distinct().chunked(100).forEach { chunk ->
            runCatching { api.items("Ids" to chunk.joinToString(",")) }.getOrNull()?.items?.forEach { known[it.id] = it }
        }
    }
    val first = remember { FocusRequester() }
    // After a removal, focus goes to the row that took its place.
    var refocus by remember { mutableStateOf<Int?>(null) }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (q.index - 1).coerceAtLeast(0))
    FocusOnOpen(first)
    val removeLabel = stringResource(com.wika.wicaby.core.R.string.queue_remove)
    Sheet(stringResource(com.wika.wicaby.core.R.string.queue), onClose) {
        LazyColumn(state = list, modifier = Modifier.heightIn(max = 400.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            itemsIndexed(q.ids) { i, id ->
                val current = i == q.index
                val entry = known[id]
                val row = remember { FocusRequester() }
                val remove = remember { FocusRequester() }
                LaunchedEffect(refocus, current) {
                    if (refocus != i) return@LaunchedEffect
                    refocus = null
                    runCatching { (if (current) row else remove).requestFocus() }
                }
                var focused by remember { mutableStateOf(false) }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        Modifier
                            .weight(1f)
                            .focusRequester(row)
                            .then(if (current) Modifier.focusRequester(first) else Modifier)
                            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.02f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = { onJump(i) })
                            .background(if (focused) TvFocus.bg else Color.Transparent)
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.width(36.dp)) {
                            if (current) Icon(Ic.Play, null, tint = if (focused) TvFocus.fg else LocalAccent.current, modifier = Modifier.size(18.dp))
                            else Text("${i + 1}", style = Type.mono, color = if (focused) TvFocus.fg.copy(alpha = 0.62f) else C.label3)
                        }
                        val title = entry?.let { e -> listOfNotNull(e.seriesName?.takeIf { e.isEpisode }, episodeLine(e) ?: e.name).joinToString(" · ") } ?: "…"
                        Text(title, style = Type.callout, color = if (focused) TvFocus.fg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (current) {
                        Spacer(Modifier.width(46.dp))
                    } else {
                        Pill(
                            null, icon = CloseIcon, modifier = Modifier.focusRequester(remove).semantics { contentDescription = removeLabel },
                            onClick = {
                                pb.removeAt(i)
                                refocus = i.coerceAtMost(q.ids.size - 1)
                            },
                        )
                    }
                }
            }
        }
    }
}

private val MusicNoteIcon = glyph("M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z")
private val QueueIcon = glyph("M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z")
private val CloseIcon = glyph("M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z")
