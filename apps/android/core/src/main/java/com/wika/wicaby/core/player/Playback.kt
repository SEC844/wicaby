package com.wika.wicaby.core.player

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.AccessSchedules
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Chapter
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.PendingProgress
import com.wika.wicaby.core.data.PlaybackInfo
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.files.FilesApi
import com.wika.wicaby.core.data.RemoteSubtitle
import com.wika.wicaby.core.data.SubtitleRules
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.VideoRange
import com.wika.wicaby.core.data.Versions
import com.wika.wicaby.core.data.deviceProfile
import com.wika.wicaby.core.livetv.LiveHost
import com.wika.wicaby.core.livetv.LiveOpen
import com.wika.wicaby.core.livetv.LiveSession
import com.wika.wicaby.core.livetv.LiveState
import com.wika.wicaby.core.livetv.LiveTuner
import com.wika.wicaby.core.livetv.ServerLiveApi
import com.wika.wicaby.core.livetv.ZapEntry
import com.wika.wicaby.core.net.AddressSwitch
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.origin
import com.wika.wicaby.core.trakt.TraktService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// A downloaded copy: the item as it was fetched (streams, chapters) and the file to play.
class LocalMedia(val item: Item, val uri: Uri)

// What the app does when a play session ends (Watch Next on TV, cache invalidation...).
class SessionEnd(val item: Item, val positionMs: Long, val durationMs: Long, val watched: Boolean)

private fun subtitleMime(codec: String?) = when (codec?.lowercase()) {
    "srt", "subrip" -> MimeTypes.APPLICATION_SUBRIP
    "ass", "ssa" -> MimeTypes.TEXT_SSA
    "vtt", "webvtt" -> MimeTypes.TEXT_VTT
    "ttml" -> MimeTypes.APPLICATION_TTML
    else -> null
}

private const val EXT_PREFIX = "wicaby-ext-"

// Negotiates PlaybackInfo, feeds ExoPlayer and reports to the server. Plays one item at a
// time; advance() moves to the next episode in place, as a new play session. A downloaded
// item plays from its file; whatever the server could not be told is queued in OfflineProgress.
class Playback(
    private val context: Context,
    val api: Api, // TP-06: the server the item plays from (the player's panels use it)
    val player: ExoPlayer,
    itemId: String,
    private val fromStart: Boolean,
    val preview: Boolean = false,
    private val prepareDisplay: suspend (MediaStream?) -> Unit = {},
    private val local: suspend (String) -> LocalMedia? = { null },
    private val onSessionEnd: suspend (SessionEnd) -> Unit = {},
    private val onStopped: () -> Unit = {},
    // Called once [ended] is set, from the player's thread (mobile: the off-screen next episode).
    private val onEnded: () -> Unit = {},
    // A trailer plays from the start and reports nothing: no watched state, no resume point,
    // no Watch Next entry, no next episode.
    val trailer: Boolean = false,
    // A remote Stop or GoHome: close the player screen (default: just stop).
    private val onRemoteExit: (() -> Unit)? = null,
    // TP-04: a shuffle or a multi-item "Play on": its entries follow each other instead of the next episode.
    queue: PlayQueue? = null,
) {
    var itemId = itemId
        private set
    var item by mutableStateOf<Item?>(null)
    var error by mutableStateOf<String?>(null)
    var streams by mutableStateOf<List<MediaStream>>(emptyList())
    var audioIndex by mutableStateOf<Int?>(null)
    var subtitleIndex by mutableStateOf<Int?>(null)
    var segments by mutableStateOf(Segments())
    var next by mutableStateOf<Item?>(null)
    // Set by the constructor, or by the first remote PlayNext / PlayLast (enqueue).
    var queue by mutableStateOf(queue)
        private set
    var ended by mutableStateOf(false)
    // The up-next card was closed for this episode: no automatic next one.
    var upNextDismissed by mutableStateOf(false)
    var offline by mutableStateOf(false)
        private set
    // Scrub thumbnails (Emby BIF or Jellyfin tiles); null when the item has none.
    var scrubPreview by mutableStateOf<ScrubPreview?>(null)
        private set
    var rate by mutableStateOf(1f)
        private set
    // X-05: the keys speed and aspect are remembered under (ScopedPrefs); null until the item is known.
    var scopeCtx by mutableStateOf<ScopedPrefs.Ctx?>(null)
        private set
    // Audio delay and subtitle offset in ms (AvSync): remembered per item, or for the series while [syncSeries].
    var audioDelayMs by mutableIntStateOf(0)
        private set
    var subtitleDelayMs by mutableIntStateOf(0)
        private set
    var syncSeries by mutableStateOf(false)
        private set
    private var syncKeys: AvSync.Keys? = null
    /** "Whole series" applies: an episode, not live, a trailer or a preview. */
    val canSyncSeries get() = syncKeys?.series != null
    private val probe = StatsProbe()

    // Real chapters (Emby's intro/credits markers left out), with their index in Item.chapters (chapter images).
    val chapters: List<IndexedValue<Chapter>>
        get() = item?.chapters.orEmpty().withIndex().filter { it.value.isChapter }.sortedBy { it.value.startPositionTicks }
    // A TvChannel plays through LiveTuner (livetv/LiveSession.kt): ladder, ledger, zaps in this player.
    var liveState by mutableStateOf<LiveState?>(null)
        private set
    private var live: LiveTuner? = null
    private var liveStreamId: String? = null

    // Episodes started by the countdown in a row; any input resets it ("Toujours là ?").
    var autoCount = 0
    private var source: MediaSource? = null
    // The MediaSource (version) asked for in PlaybackInfo.
    var sourceId by mutableStateOf<String?>(null)
        private set
    private var playSessionId: String? = null
    var playMethod by mutableStateOf("DirectPlay")
        private set
    // X-02: the bitrate cap picked in the player (Quality.ORIGINAL for Original), kept for the next
    // episodes of this player; null = the settings cap. switching: a reload is in flight.
    var qualityCap by mutableStateOf<Int?>(null)
        private set
    var switching by mutableStateOf(false)
        private set
    private var started = false
    private var stopped = false
    private var applyTracksPending = false
    private lateinit var scope: CoroutineScope

    // B03: "Reconnexion…" while a dropped stream is reloaded; the players show it with the spinner.
    var notice by mutableStateOf<String?>(null)
        private set
    // B01: the server's conversion, asked once per item after a direct play failed; every later load of the
    // item keeps it (and the lower cap after an OutOfMemoryError).
    private var fellBack = false
    private var forceTranscode = false
    private var fallbackCap: Int? = null
    private val backoff = Backoff(SystemClock::elapsedRealtime)
    private var recovery: Job? = null

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (live != null) return // live reports, end and recovery: LiveTuner
            if (state == Player.STATE_READY) {
                notice = null
                backoff.reset()
            }
            if (state == Player.STATE_READY && !started) {
                started = true
                report("/Sessions/Playing", null)
                // File sources (D5): the duration and the container title, learnt here, kept with the progress.
                (api as? FilesApi)?.tags(itemId, player.duration, player.mediaMetadata.title?.toString())
            }
            if (state == Player.STATE_ENDED) {
                ended = true
                onEnded()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (started && player.playbackState == Player.STATE_READY) report("/Sessions/Playing/Progress", if (isPlaying) "Unpause" else "Pause")
        }

        override fun onTracksChanged(tracks: Tracks) {
            // A file source has no server to list the embedded tracks: they come from the file itself.
            if (api.server.isFiles && !tracks.isEmpty) fileStreams(tracks, streams).let { if (it != streams) streams = it }
            // 0.10.2: a trailer in VC-1 played as sound over black on a TV. Direct play only (a conversion is h264).
            if (live == null && !fellBack && playMethod != "Transcode" && !tracks.isEmpty && Recovery.undecodableVideo(tracks)) {
                if (BuildConfig.DEBUG) Log.w("Wicaby", "no decoder for the video on $playMethod")
                if (!fallBack(Recovery.Fix.TRANSCODE)) fail(context.getString(R.string.files_error_cannot_decode))
            }
            if (applyTracksPending && !tracks.isEmpty) {
                applyTracksPending = false
                applyTracks()
            }
        }

        override fun onPlayerError(e: PlaybackException) {
            // An X-02 reload ends the old stream's encode under it.
            if (live != null || switching) return
            // TP-11: a stream cut off once the allowed hours end.
            refusal(null)?.let { return fail(it) }
            if (!recover(e)) fail(context.getString(R.string.playback_error_code, e.errorCodeName))
        }
    }

    // B01/B03: the server's conversion once, or a reload at the position with backoff. False: show the error.
    private fun recover(e: PlaybackException): Boolean {
        val status = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
        val fix = Recovery.decide(e.errorCode, e.cause, status, playMethod, fellBack)
        if (BuildConfig.DEBUG) Log.w("Wicaby", "player error ${e.errorCodeName} on $playMethod: $fix", e)
        return fallBack(fix)
    }

    // Applies a [Recovery.Fix]: false when there is nothing to do (show the error).
    private fun fallBack(fix: Recovery.Fix): Boolean {
        if (preview || offline || stopped || item == null) return false
        // A file source cannot convert (caps transcode): say so instead of asking a server for a conversion.
        if (!api.server.caps.transcode && (fix == Recovery.Fix.TRANSCODE || fix == Recovery.Fix.TRANSCODE_LOW)) {
            fail(context.getString(R.string.files_error_cannot_decode))
            return true
        }
        when (fix) {
            Recovery.Fix.NONE -> return false
            Recovery.Fix.TRANSCODE, Recovery.Fix.TRANSCODE_LOW -> {
                fellBack = true
                forceTranscode = true
                if (fix == Recovery.Fix.TRANSCODE_LOW) fallbackCap = Recovery.LOW_BITRATE
                Toast.makeText(context, R.string.player_transcode_fallback, Toast.LENGTH_SHORT).show()
                reloadAt(player.currentPosition, 0)
            }
            Recovery.Fix.RELOAD -> {
                val wait = backoff.next() ?: return false
                notice = context.getString(R.string.player_reconnecting)
                reloadAt(player.currentPosition, wait)
            }
        }
        return true
    }

    // A new PlaybackInfo and stream at [pos] with the same tracks, after [waitMs]. The old session's Stopped goes
    // out once the new one resolved (switchFrom), the new one's Playing at READY. A network failure on the way
    // waits the next backoff step; a refusal or the end of the backoff shows the error.
    private fun reloadAt(pos: Long, waitMs: Long) {
        recovery?.cancel()
        recovery = scope.launch {
            var wait = waitMs
            while (true) {
                delay(wait)
                try {
                    load(pos, audioIndex, subtitleIndex) { endSession(switching = true) }
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (BuildConfig.DEBUG) Log.w("Wicaby", "reload at $pos", e)
                    val transient = e is java.io.IOException && ((e as? ApiException)?.status ?: 500) >= 500
                    wait = (if (transient) backoff.next() else null) ?: return@launch fail(refusal(e) ?: context.getString(R.string.playback_error))
                    notice = context.getString(R.string.player_reconnecting)
                }
            }
        }
    }

    // The error screen: no recovery left, and no session left playing on the server (#1673's ghost session).
    private fun fail(message: String) {
        recovery?.cancel()
        backoff.reset()
        notice = null
        error = message
        endSession(switching = true)
    }

    /** The error's Retry: the item again where it stopped (from open() when nothing was loaded). Not live. */
    fun retry() {
        if (live != null || stopped || !::scope.isInitialized) return
        error = null
        backoff.reset()
        if (source == null) scope.launch { open(itemId, fromStart) } else reloadAt(player.currentPosition, 0)
    }

    fun start(scope: CoroutineScope) {
        this.scope = scope
        player.addListener(listener)
        player.addAnalyticsListener(probe)
        if (!preview && !trailer) RemoteControl.target = remoteTarget
        scope.launch { open(itemId, fromStart) }
        // A bitstream (HDMI passthrough) plays at 1x only: the sink cannot stretch it and the speed would
        // not apply. Back to 1x (the remembered speed is kept) when one starts; the speed sheets say why.
        scope.launch {
            snapshotFlow { AudioFx.bitstream && rate != 1f }.collect { if (it) { rate = 1f; player.setPlaybackSpeed(1f) } }
        }
        // TP-11: the parental hours as they are now, for the countdown and a refusal's message.
        if (!preview) scope.launch { AccessSchedules.refresh(api) }
        scope.launch {
            while (isActive) {
                delay(10_000)
                if (!started || stopped || notice != null) continue
                // A paused transcode is killed after ~60 s without news (Jellyfin); the ping keeps it.
                if (player.playWhenReady) report("/Sessions/Playing/Progress", "TimeUpdate") else ping()
            }
        }
    }

    private suspend fun open(id: String, fromStart: Boolean) {
        try {
            val copy = runCatching { local(id) }.getOrNull()
            val it = copy?.item ?: api.item(id)
            item = it
            if ((api as? FilesApi)?.changed(id) == true) Toast.makeText(context, R.string.files_resume_changed, Toast.LENGTH_LONG).show()
            val server = api.server.id
            recallSync(if (preview || trailer || (it.type == "TvChannel" && copy == null)) null else AvSync.Keys("$server:${it.id}", it.seriesId?.let { s -> "$server:$s" }))
            // "Play on Wicaby" from another app: its position, version and tracks win (a channel still goes live).
            val remote = if (preview || trailer) null else RemoteControl.take(id)
            if (it.type == "TvChannel" && copy == null && !preview && !trailer) {
                scopeCtx = ScopedPrefs.Ctx(global = true)
                return startLive(it)
            }
            // Downloads use the global value.
            scopeCtx = ScopedPrefs.ctx(api, it, global = copy != null)
            // The version picked on the detail page (remembered per item), else the first.
            val chosen = remote?.mediaSourceId?.let { ms -> it.mediaSources.firstOrNull { s -> s.id == ms } } ?: Versions.selected(it)
            sourceId = chosen?.id
            streams = chosen?.mediaStreams.orEmpty()
            if (!preview) {
                val start = remote?.startMs ?: if (fromStart || trailer) 0 else it.resumeMs
                // Audio/subtitles picked on the detail page go into the first PlaybackInfo.
                val pick = Versions.pick(it.id, chosen?.id)
                // X-05: the tracks picked earlier in this series, when nothing else asked for some.
                val series = it.seriesId
                val mem = if (remote == null && pick == null && !trailer && series != null) TrackMemory.pick(TrackMemory.get(series), streams) else null
                if (copy != null) loadLocal(copy, start) else load(start, remote?.audio ?: pick?.audio ?: mem?.first, remote?.subtitle ?: pick?.subtitle ?: mem?.second)
                val changed = chosen != null && ((mem?.first ?: chosen.defaultAudioStreamIndex) != chosen.defaultAudioStreamIndex ||
                    (mem?.second ?: Versions.defaultSubtitleIndex(chosen)) != Versions.defaultSubtitleIndex(chosen))
                if (copy == null && changed && series != null && tracksToasted.add(series)) {
                    Toast.makeText(context, R.string.tracks_applied, Toast.LENGTH_SHORT).show()
                }
                if (!trailer) {
                    ScopedPrefs.recall(ScopedPrefs.SPEED, scopeCtx)?.let { v -> (v as? JsonPrimitive)?.floatOrNull }?.takeIf { r -> r in 0.25f..4f }?.let { r ->
                        rate = r
                        player.setPlaybackSpeed(r)
                    }
                }
            }
            if (trailer) return
            // Off the open path: a large index.bif must not delay segments, Up Next or reporting.
            if (!preview) {
                val src = sourceId
                scope.launch {
                    val p = runCatching { ScrubPreview.load(api, it, src) }.getOrNull()
                    if (item?.id == it.id && sourceId == src) scrubPreview = p
                }
            }
            segments = if (api.server.isEmby) embySegments(it.chapters) else runCatching { jellyfinSegments(api.mediaSegments(it.id)) }.getOrDefault(Segments())
            next = nextFor(it)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.w("Wicaby", "open $id", e)
            error = refusal(e) ?: context.getString(R.string.playback_error)
        }
    }

    // TP-11: "Accès refusé…" with the allowed hours when [e] is a refusal of them (null: judged on the kept hours).
    private fun refusal(e: Throwable?): String? = AccessSchedules.explain(context, api.server.id, api.userId, e)

    private fun startLive(ch: Item) {
        val mbps = Core.maxMbps
        val maxBitrate = qualityCap ?: if (mbps <= 0) 200_000_000 else mbps * 1_000_000
        // Read per tune: the Quality sheet changes the cap (X-02).
        val profile = { _: Int -> deviceProfile(context, live?.maxBitrate?.toInt() ?: maxBitrate, jellyfin = !api.server.isEmby, presetHeight(qualityCap)) }
        live = LiveTuner(LiveSession.shared, ServerLiveApi(api), api.server.id, ExoLivePort(player), liveHost, scope, maxBitrate.toLong(), profile)
        tune(ZapEntry(ch.id, "", ch.name, ch.imageTags["Primary"]))
        if (BuildConfig.DEBUG) debugZaps()
    }

    // Debug builds, until the remotes are wired (TV-3, M-2): `adb shell am broadcast -a com.wika.wicaby.DEBUG_TUNE
    // --es ids ch1,ch2 [--ei gapMs 150]` tunes each channel in turn in this player (S10, S15, S16 on an emulator).
    private var debugReceiver: BroadcastReceiver? = null

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun debugZaps() {
        if (debugReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val ids = i.getStringExtra("ids")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: return
                val gap = i.getIntExtra("gapMs", 150).toLong()
                scope.launch {
                    for (id in ids) {
                        tune(ZapEntry(id, "", id))
                        delay(gap)
                    }
                }
            }
        }
        val f = IntentFilter("com.wika.wicaby.DEBUG_TUNE")
        // Exported: adb's shell user sends it (debug builds only).
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else context.registerReceiver(r, f)
        debugReceiver = r
    }

    /** Live: tune another channel in this player (zap, digits, mini-guide). */
    fun tune(channel: ZapEntry) {
        live?.tune(channel)
    }

    private val liveHost = object : LiveHost {
        override val streams get() = this@Playback.streams
        override val audioIndex get() = this@Playback.audioIndex
        override val subtitleIndex get() = this@Playback.subtitleIndex

        override fun loading(open: LiveOpen, audio: Int?, subtitle: Int?) {
            this@Playback.streams = open.source.ms.mediaStreams
            this@Playback.audioIndex = audio
            this@Playback.subtitleIndex = subtitle
            applyTracksPending = true
            error = null
        }

        override fun reporting(open: LiveOpen?, channel: ZapEntry) {
            source = open?.source?.ms
            playSessionId = open?.playSessionId
            liveStreamId = open?.liveStreamId
            if (open == null) return
            playMethod = open.playMethod.name
            this@Playback.itemId = channel.id
            item = item?.copy(id = channel.id, name = channel.name, imageTags = channel.logoTag?.let { mapOf("Primary" to it) }.orEmpty())
            started = true
        }

        override fun failed(message: String, cause: Throwable?) {
            // TP-11: a channel refused outside the parental hours (the server's wording, else the kept hours).
            error = refusal(cause) ?: refusal(null) ?: message
        }

        override fun state(s: LiveState?) {
            liveState = s
        }
    }

    // The queue's next entry while there is a queue, else the next episode.
    private suspend fun nextFor(it: Item): Item? {
        val q = queue ?: return if (it.isEpisode) runCatching { api.nextEpisode(it) }.getOrNull() else null
        return q.nextId?.let { id -> runCatching { api.item(id) }.getOrNull() }
    }

    // After the queue changed: the up-next card names what now follows.
    private fun refreshNext() {
        val it = item ?: return
        if (next?.id == queue?.nextId) return
        scope.launch {
            val n = nextFor(it)
            if (item?.id == it.id) next = n
        }
    }

    /** Remote PlayNext / PlayLast: into the queue (started from this item and its next episode); false on live or a trailer. */
    fun enqueue(ids: List<String>, playNext: Boolean): Boolean {
        if (live != null || trailer || preview || !::scope.isInitialized) return false
        val q = queue ?: PlayQueue(listOfNotNull(itemId, next?.id)).also { queue = it }
        q.add(playNext, ids)
        refreshNext()
        return true
    }

    /** The queue sheet: plays entry [i] now, as a new session. */
    fun jump(i: Int) {
        val q = queue ?: return
        if (i == q.index) return
        val id = q.jump(i) ?: return
        autoCount = 0
        switchTo(id, next?.takeIf { it.id == id })
    }

    /** The queue sheet: drops entry [i] (never the one playing). */
    fun removeAt(i: Int) {
        if (queue?.remove(i) == true) refreshNext()
    }

    /** Desktop: the previous queue entry within the first 5 s, else back to the start (remote, media keys). */
    fun previous() {
        val q = queue
        if (q != null && q.index > 0 && player.currentPosition <= 5_000) jump(q.index - 1) else if (live == null) player.seekTo(0)
    }

    // Ends this episode's session and starts the next one in the same player.
    fun advance(auto: Boolean) {
        val n = next ?: return
        val q = queue
        // The queue moves with it; a stale card (entry removed meanwhile) plays the entry that follows now.
        val id = if (q != null) q.jump(q.index + 1) ?: return else n.id
        autoCount = if (auto) autoCount + 1 else 0
        switchTo(id, n.takeIf { it.id == id })
    }

    private fun switchTo(id: String, known: Item?) {
        recovery?.cancel()
        notice = null
        backoff.reset()
        fellBack = false
        forceTranscode = false
        fallbackCap = null
        endSession()
        player.stop()
        player.clearMediaItems()
        item = known
        next = null
        ended = false
        upNextDismissed = false
        segments = Segments()
        scrubPreview = null
        error = null
        source = null
        sourceId = null
        playSessionId = null
        audioIndex = null
        subtitleIndex = null
        offline = false
        itemId = id
        scope.launch { open(id, fromStart = queue?.fromStart == true) }
    }

    private suspend fun loadLocal(copy: LocalMedia, startMs: Long) {
        val it = copy.item
        offline = true
        source = it.mediaSources.firstOrNull() ?: MediaSource(id = it.id)
        playSessionId = null
        playMethod = "DirectPlay"
        audioIndex = source?.defaultAudioStreamIndex
        subtitleIndex = source?.defaultSubtitleStreamIndex
        play(MediaItem.Builder().setUri(copy.uri).setMediaId(it.id).setMediaMetadata(metadata(it)).build(), startMs)
    }

    private fun metadata(it: Item) = MediaMetadata.Builder().setTitle(it.name).setArtist(if (it.isAudio) it.artistLine else it.seriesName).setAlbumTitle(it.album).build()

    private suspend fun play(media: MediaItem, startMs: Long) {
        prepareDisplay(streams.firstOrNull { s -> s.type == "Video" })
        probe.clear()
        applyTracksPending = true
        started = false
        player.setMediaItem(media, startMs)
        player.prepare()
        player.play()
    }

    // switchFrom (X-02): runs once the new PlaybackInfo resolved, before anything of the old session
    // changes. Until then a failure throws instead of showing an error, so the old stream plays on.
    private suspend fun load(startMs: Long, audio: Int?, subtitle: Int?, switchFrom: (() -> Unit)? = null) {
        val it = item ?: return
        val mbps = Core.maxMbps
        val cap = qualityCap
        val maxBitrate = (cap ?: if (mbps <= 0) 200_000_000 else mbps * 1_000_000).let { m -> fallbackCap?.let { f -> minOf(f, m) } ?: m }
        val ticks = startMs * TICKS_PER_MS
        val wanted = sourceId ?: it.mediaSources.firstOrNull()?.id
        // A picked preset below the source must transcode, or the server would direct play it anyway.
        val src = it.mediaSources.firstOrNull { s -> s.id == wanted }
        val video = src?.mediaStreams?.firstOrNull { s -> s.type == "Video" }
        val force = forceTranscode || Quality.PRESETS.firstOrNull { p -> p.bitrate == cap }
            ?.let { p -> !Quality.coversSource(p, src?.bitrate, Quality.heightClass(video?.width, video?.height)) } == true
        val profile = deviceProfile(context, maxBitrate, jellyfin = !api.server.isEmby, presetHeight(cap))
        if (BuildConfig.DEBUG) Log.d("Wicaby", "DeviceProfile $profile")
        val body = buildJsonObject {
            put("DeviceProfile", profile)
            put("UserId", api.userId)
            put("MaxStreamingBitrate", maxBitrate)
            put("StartTimeTicks", ticks)
            put("IsPlayback", true)
            put("AutoOpenLiveStream", true)
            wanted?.let { id -> put("MediaSourceId", id) }
            audio?.let { a -> put("AudioStreamIndex", a) }
            subtitle?.let { s -> put("SubtitleStreamIndex", s) }
            put("EnableDirectPlay", !force)
            put("EnableDirectStream", !force)
            put("EnableTranscoding", true)
            put("AllowVideoStreamCopy", !force)
            put("AllowAudioStreamCopy", true)
        }
        val info: PlaybackInfo = api.post(
            "/Items/${it.id}/PlaybackInfo", body.toString(),
            "UserId" to api.userId, "StartTimeTicks" to ticks, "IsPlayback" to true, "AutoOpenLiveStream" to true,
            "MaxStreamingBitrate" to maxBitrate, "AudioStreamIndex" to audio, "SubtitleStreamIndex" to subtitle, "MediaSourceId" to wanted,
        )
        fun fail(message: String) {
            if (switchFrom != null) throw IllegalStateException(message) else error = message
        }
        if (info.errorCode != null) return fail(context.getString(R.string.playback_error_code, info.errorCode.toString()))
        val ps = info.mediaSources.firstOrNull { s -> s.id == wanted } ?: info.mediaSources.firstOrNull()
            ?: return fail(context.getString(R.string.no_playable_source))

        var hls = false
        val method: String
        val url = when {
            ps.supportsDirectPlay && !force -> {
                method = "DirectPlay"
                // No api_key in the URL (it ends up in logs and proxies): Core.http's ServerAuthInterceptor
                // sends the auth headers to the active server, and only to it.
                api.url(
                    // A music track: the audio route (both servers).
                    if (it.isAudio) "/Audio/${it.id}/stream" else "/Videos/${it.id}/stream", "static" to true, "MediaSourceId" to ps.id, "PlaySessionId" to info.playSessionId,
                    "DeviceId" to api.deviceId,
                )
            }
            ps.transcodingUrl != null -> {
                val u = ps.transcodingUrl
                method = if (u.contains("videocodec=copy", true)) "DirectStream" else "Transcode"
                hls = ps.transcodingSubProtocol.equals("hls", true) || u.contains(".m3u8", true)
                api.resolve(u)
            }
            else -> return fail(context.getString(R.string.no_playable_source))
        }
        switchFrom?.invoke()
        source = ps
        playSessionId = info.playSessionId
        playMethod = method
        streams = ps.mediaStreams.ifEmpty { streams }
        audioIndex = audio ?: ps.defaultAudioStreamIndex
        subtitleIndex = subtitle ?: ps.defaultSubtitleStreamIndex
        val subs = streams.filter { s -> s.type == "Subtitle" && s.deliveryUrl != null && (s.isExternal || s.deliveryMethod == "External") }
            .mapNotNull { s ->
                val mime = subtitleMime(s.codec) ?: return@mapNotNull null
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(api.resolve(s.deliveryUrl!!)))
                    .setMimeType(mime)
                    .setLanguage(s.language)
                    .setLabel(s.displayTitle ?: s.title)
                    .setId("$EXT_PREFIX${s.index}")
                    .build()
            }
        val media = MediaItem.Builder()
            .setUri(url)
            .setMediaId(it.id)
            .apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(subs)
            .setMediaMetadata(metadata(it))
            .build()
        play(media, startMs)
    }

    // Emby lists streams in container order, as ExoPlayer does, so the n-th
    // audio (or embedded subtitle) stream maps to the n-th track group.
    private fun applyTracks() {
        val groups = player.currentTracks.groups
        val b = player.trackSelectionParameters.buildUpon()
        audioIndex?.let { ai ->
            val pos = streams.filter { it.type == "Audio" && !it.isExternal }.indexOfFirst { it.index == ai }
            groups.filter { it.type == C.TRACK_TYPE_AUDIO }.getOrNull(pos)?.let { b.setOverrideForType(TrackSelectionOverride(it.mediaTrackGroup, 0)) }
        }
        val si = subtitleIndex
        if (si == null || si < 0) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            val text = groups.filter { it.type == C.TRACK_TYPE_TEXT }
            fun extId(g: Tracks.Group) = g.mediaTrackGroup.getFormat(0).id.orEmpty() + "|" + g.mediaTrackGroup.id
            val s = streams.firstOrNull { it.index == si }
            val g = if (s != null && (s.isExternal || s.deliveryMethod == "External")) {
                text.firstOrNull { extId(it).contains("$EXT_PREFIX$si") }
            } else {
                val embedded = streams.filter { it.type == "Subtitle" && !it.isExternal && it.deliveryMethod != "External" }
                text.filterNot { extId(it).contains(EXT_PREFIX) }.getOrNull(embedded.indexOfFirst { it.index == si })
            }
            g?.let { b.setOverrideForType(TrackSelectionOverride(it.mediaTrackGroup, 0)) }
        }
        player.trackSelectionParameters = b.build()
    }

    fun selectAudio(index: Int) {
        audioIndex = index
        rememberTrack("audio", index)
        reselect("AudioTrackChange")
    }

    fun selectSubtitle(index: Int) {
        subtitleIndex = index
        rememberTrack("subtitle", index)
        reselect("SubtitleTrackChange")
    }

    // X-05: a pick during an episode becomes the series default (-1 = subtitles off). Not on live.
    private fun rememberTrack(kind: String, index: Int) {
        if (preview || trailer || live != null) return
        val series = item?.seriesId ?: return
        TrackMemory.record(series, kind, streams.firstOrNull { it.index == index && index >= 0 }, streams)
    }

    private fun reselect(event: String) {
        if (preview) return
        // Live: the tracks of the stream as it is (a reload would re-tune).
        if (playMethod == "DirectPlay" || live != null) {
            applyTracks()
            report("/Sessions/Playing/Progress", event)
        } else {
            // The server muxes the chosen tracks into the transcode: restart it in place.
            val pos = player.currentPosition
            endEncoding()
            scope.launch { runCatching { load(pos, audioIndex, subtitleIndex) }.onFailure { e -> error = refusal(e) ?: context.getString(R.string.playback_error) } }
        }
    }

    /** 0.5–2×; reported at once as PlaybackRate (Emby reads it, Jellyfin ignores it). Not on live. */
    fun setSpeed(s: Float) {
        if (live != null || (s != 1f && AudioFx.bitstream)) return
        rate = s
        player.setPlaybackSpeed(s)
        if (!preview && !trailer) ScopedPrefs.remember(ScopedPrefs.SPEED, scopeCtx, JsonPrimitive(s))
        if (started) report("/Sessions/Playing/Progress", "TimeUpdate")
    }

    // The item's remembered delays (0 without [keys]: live, a trailer, a preview), applied to the engine.
    private fun recallSync(keys: AvSync.Keys?) {
        syncKeys = keys
        val doc = keys?.let { ScopedPrefs.doc() }
        audioDelayMs = if (doc != null && keys != null) AvSync.read(doc, AvSync.AUDIO, keys) else 0
        subtitleDelayMs = if (doc != null && keys != null) AvSync.read(doc, AvSync.SUBTITLE, keys) else 0
        syncSeries = doc != null && keys != null && AvSync.seriesWide(doc, keys)
        AvSync.apply(this, audioDelayMs, subtitleDelayMs)
    }

    /** The sync sheet: one step ([deltaMs] = ±AUDIO_STEP_MS or ±SUBTITLE_STEP_MS), or back to 0 when null. */
    fun adjustDelay(audio: Boolean, deltaMs: Int?) {
        val ms = if (deltaMs == null) 0 else AvSync.clamp((if (audio) audioDelayMs else subtitleDelayMs) + deltaMs)
        if (audio) audioDelayMs = ms else subtitleDelayMs = ms
        AvSync.apply(this, audioDelayMs, subtitleDelayMs)
        val keys = syncKeys ?: return
        ScopedPrefs.update { AvSync.write(it, if (audio) AvSync.AUDIO else AvSync.SUBTITLE, keys, ms, syncSeries, System.currentTimeMillis()) }
    }

    /** "Whole series" on or off: the other episodes without their own values use these. */
    fun toggleSyncSeries() {
        val keys = syncKeys?.takeIf { it.series != null } ?: return
        val on = !syncSeries
        syncSeries = on
        ScopedPrefs.update { AvSync.setSeriesWide(it, keys, on, audioDelayMs, subtitleDelayMs, System.currentTimeMillis()) }
    }

    /** The stats panel, now: what Media3 decodes, how, and what the server said about the source. */
    fun stats(): PlaybackStats.Snapshot {
        val v = player.videoFormat
        val a = player.audioFormat
        val s = source
        // The server's description of the video holds while it is not re-encoded.
        val sv = if (playMethod == "Transcode") null else streams.firstOrNull { it.type == "Video" }
        val url = s?.transcodingUrl?.takeIf { playMethod != "DirectPlay" }
        val fps = v?.frameRate?.takeIf { it > 0 } ?: sv?.realFrameRate
        val nf = java.text.NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 3 }
        val bitstream = AudioFx.bitstream && a != null
        val dropped = player.videoDecoderCounters?.let { c -> c.ensureUpdated(); c.droppedBufferCount } ?: 0
        return PlaybackStats.Snapshot(
            container = s?.container,
            hls = url?.contains(".m3u8", ignoreCase = true) == true,
            video = v?.let { f ->
                // The decoder's colour info wins; the server's range only when Media3 has none.
                val transfer = f.colorInfo?.colorTransfer ?: Format.NO_VALUE
                PlaybackStats.line(
                    PlaybackStats.codecName(f.sampleMimeType), PlaybackStats.profile(f.codecs) ?: sv?.profile, PlaybackStats.level(f.codecs)?.let { "L$it" },
                    if (f.width > 0 && f.height > 0) "${f.width}×${f.height}" else null, fps?.let { nf.format(it) },
                    PlaybackStats.hdr(f.sampleMimeType, transfer) ?: sv?.takeIf { transfer == Format.NO_VALUE }?.let { VideoRange.of(it).badge },
                )
            },
            bitDepth = v?.let { f -> f.colorInfo?.lumaBitdepth?.takeIf { it > 0 } ?: sv?.bitDepth },
            videoDecoder = probe.videoDecoder,
            audio = a?.let { f ->
                PlaybackStats.line(PlaybackStats.codecName(f.sampleMimeType), PlaybackStats.channels(f.channelCount), f.sampleRate.takeIf { it > 0 }?.let { nf.format(it / 1000.0) + " kHz" })
            },
            audioDecoder = if (bitstream) null else probe.audioDecoder,
            passthrough = bitstream,
            bitrate = PlaybackStats.transcodeBitrate(url) ?: s?.bitrate?.toLong(),
            method = playMethod,
            reasons = PlaybackStats.reasons(url),
            bufferMs = player.totalBufferedDuration,
            dropped = dropped,
            subtitle = streams.firstOrNull { it.type == "Subtitle" && it.index == subtitleIndex }?.let { PlaybackStats.subtitleFormat(it.codec) },
            server = api.server.name,
            link = link(),
            offline = offline,
        )
    }

    // The stats panel's path to the server: the address in use (B09), forwarded by the mesh node or not.
    private fun link(): PlaybackStats.Link? {
        val t = Core.transport
        val u = ((t as? AddressSwitch)?.inUse(api.server) ?: api.server.address).toHttpUrlOrNull() ?: return null
        // Called on the main thread every second: only reads what the mesh already forwards, never dials.
        val mesh = t !== ServerTransport.Direct && Core.mesh.forwarding(origin(u))
        return PlaybackStats.link(mesh, u.host)
    }

    /** X-02 Quality sheet rows for the version playing: Original first, then the presets coversSource keeps. */
    fun qualityRows(): List<Quality.Row> {
        val it = item ?: return emptyList()
        // Live: every preset (a channel's bitrate is unknown before it plays).
        if (live != null) return Quality.rows(null, null, null, 0)
        val s = it.mediaSources.firstOrNull { m -> m.id == sourceId } ?: it.mediaSources.firstOrNull()
        val v = s?.mediaStreams?.firstOrNull { m -> m.type == "Video" }
        return Quality.rows(s?.bitrate, Quality.heightClass(v?.width, v?.height), s?.size, (it.runTimeTicks ?: 0L) / TICKS_PER_MS)
    }

    /** The Quality sheet can switch: an online session (no download, trailer or preview). Live: the cap only. */
    // Not for a source that cannot convert (caps transcode: file sources).
    val canSwitchQuality get() = !offline && !preview && !trailer && item != null && api.server.caps.transcode

    /** The sheet's Version column: 2 or more sources, never on live. */
    val versions: List<MediaSource> get() = if (live != null) emptyList() else item?.mediaSources?.takeIf { it.size > 1 }.orEmpty()

    /** One label per version, from the detail page's picker (Versions.labels). */
    fun versionLabels(): List<String> = item?.let { Versions.labels(it) }.orEmpty()

    /**
     * X-02: reload in place at the current position with another version ([sourceId], null = this one)
     * and bitrate cap ([maxBitrate], null = Original), with the same tracks. The old stream plays on until
     * the new PlaybackInfo resolves; a failure there leaves it playing, with a toast. Live re-tunes the
     * channel with the cap (make-before-break). [onDone] gets whether the switch took.
     */
    fun switchQuality(sourceId: String?, maxBitrate: Int?, onDone: (Boolean) -> Unit = {}) {
        val it = item ?: return
        if (!canSwitchQuality || switching) return
        live?.let { t -> return switchLive(t, maxBitrate, onDone) }
        val target = it.mediaSources.firstOrNull { s -> s.id == (sourceId ?: this.sourceId) } ?: it.mediaSources.firstOrNull() ?: return
        val prevCap = qualityCap
        val prevSource = this.sourceId
        val newVersion = target.id != (source?.id ?: prevSource)
        val audio = if (newVersion) sameTrack(streams, target.mediaStreams, audioIndex) else audioIndex
        val subtitle = when {
            (subtitleIndex ?: -1) < 0 -> -1
            newVersion -> sameTrack(streams, target.mediaStreams, subtitleIndex)
            else -> subtitleIndex
        }
        val pos = player.currentPosition
        qualityCap = maxBitrate ?: Quality.ORIGINAL
        this.sourceId = target.id
        switching = true
        scope.launch {
            var stopped = false
            try {
                load(pos, audio, subtitle) {
                    stopped = true
                    endSession(switching = true)
                }
                if (newVersion) it.seriesId?.let { s -> Versions.rememberForSeries(s, target) }
                val label = if (newVersion) Versions.labels(it).getOrNull(it.mediaSources.indexOf(target)) ?: target.id else qualityLabel(context, maxBitrate)
                Toast.makeText(context, context.getString(R.string.quality_switched, label), Toast.LENGTH_SHORT).show()
                switching = false
                onDone(true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w("Wicaby", "quality switch", e)
                if (stopped) {
                    error = refusal(e) ?: context.getString(R.string.playback_error)
                } else {
                    qualityCap = prevCap
                    this@Playback.sourceId = prevSource
                    Toast.makeText(context, R.string.quality_failed, Toast.LENGTH_SHORT).show()
                }
                switching = false
                onDone(false)
            }
        }
    }

    // Live: the same channel again with the new cap; a preset starts at the rung without direct play,
    // Original at direct play. A failed tune keeps (or restores) the stream that was playing.
    private fun switchLive(t: LiveTuner, maxBitrate: Int?, onDone: (Boolean) -> Unit) {
        val ch = liveState?.channel ?: return
        val before = t.adopted
        val prevCap = qualityCap
        val prevMax = t.maxBitrate
        qualityCap = maxBitrate ?: Quality.ORIGINAL
        t.maxBitrate = qualityCap!!.toLong()
        switching = true
        scope.launch {
            t.tune(ch, startRung = if (maxBitrate == null) 0 else 1).join()
            val ok = t.adopted.let { a -> a != null && a !== before }
            if (ok) {
                Toast.makeText(context, context.getString(R.string.quality_switched, qualityLabel(context, maxBitrate)), Toast.LENGTH_SHORT).show()
            } else {
                qualityCap = prevCap
                t.maxBitrate = prevMax
                Toast.makeText(context, R.string.quality_failed, Toast.LENGTH_SHORT).show()
            }
            switching = false
            onDone(ok)
        }
    }

    /** X-03: server VOD video (not live, a trailer, a preview or a download). */
    val canSearchSubtitles get() = canSwitchQuality && live == null && item?.type in setOf("Movie", "Episode", "Video", "MusicVideo")

    /**
     * X-03: after a subtitle download, reload at the current position (ExoPlayer needs a new MediaItem with
     * the extra SubtitleConfiguration) and select the new external stream when [selectNew]. The server may
     * still be saving the file: up to 5 looks over about 3 s. Toasts "Sous-titre ajouté" or the failure.
     */
    fun refreshStreams(selectNew: Boolean = true) {
        val it = item ?: return
        if (!canSearchSubtitles || switching) return
        val before = streams
        scope.launch {
            var added: MediaStream? = null
            for (attempt in 0 until 5) {
                if (attempt > 0) delay(800)
                val fresh = runCatching { api.item(it.id) }.getOrNull() ?: continue
                val src = fresh.mediaSources.firstOrNull { s -> s.id == sourceId } ?: fresh.mediaSources.firstOrNull()
                added = SubtitleRules.added(before, src?.mediaStreams.orEmpty())
                if (added != null) {
                    item = fresh
                    break
                }
            }
            val sub = added
            var ok = false
            if (sub != null && itemId == it.id && !stopped) {
                var ended = false
                switching = true
                try {
                    load(player.currentPosition, audioIndex, if (selectNew) sub.index else subtitleIndex) {
                        ended = true
                        endSession(switching = true)
                    }
                    if (selectNew) rememberTrack("subtitle", sub.index)
                    ok = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (BuildConfig.DEBUG) Log.w("Wicaby", "subtitle refresh", e)
                    if (ended) error = refusal(e) ?: context.getString(R.string.playback_error)
                }
                switching = false
            }
            Toast.makeText(context, if (ok) R.string.subsearch_added else R.string.subsearch_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun presetHeight(cap: Int?): Int = Quality.PRESETS.firstOrNull { p -> p.bitrate == cap }?.height ?: 0

    private val remoteTarget = object : RemoteTarget {
        override fun pause() = player.pause()
        override fun unpause() = player.play()
        override fun playPause() = if (player.isPlaying) player.pause() else player.play()
        override fun stop() = onRemoteExit?.invoke() ?: this@Playback.stop()
        override fun seek(ms: Long) {
            if (live == null) player.seekTo(ms)
        }
        override fun next() = advance(auto = false)
        override fun previous() = this@Playback.previous()
        override fun audio(index: Int) = selectAudio(index)
        override fun subtitle(index: Int) = selectSubtitle(index)
        override fun enqueue(ids: List<String>, next: Boolean) = this@Playback.enqueue(ids, next)
    }

    private val reporter = SessionReporter(api)

    private fun body(event: String?): JsonObject {
        val volume = RemoteControl.streamVolume(context)
        return reporter.body(
            SessionReporter.State(
                itemId, source?.id, playSessionId, player.currentPosition * TICKS_PER_MS, !player.playWhenReady,
                muted = volume?.second == true, volume = volume?.first, playMethod = playMethod, canSeek = live == null,
                liveStreamId = liveStreamId, audio = audioIndex, subtitle = subtitleIndex ?: -1, rate = player.playbackParameters.speed,
            ),
            event,
        )
    }

    private fun report(path: String, event: String?) {
        if (preview || trailer || source == null) return
        reporter.report(path, body(event))
        // TP-09: Trakt follows Playing, Pause and Unpause (stop: endSession).
        val action = if (path == "/Sessions/Playing") "start" else when (event) { "Pause" -> "pause"; "Unpause" -> "start"; else -> null }
        val it = item
        if (action != null && it != null) TraktService.shared.scrobble(action, api, it, player.currentPosition, player.duration)
    }

    private fun ping() {
        val sid = playSessionId ?: return
        if (preview) return
        reporter.ping(sid)
    }

    private fun endEncoding() {
        val sid = playSessionId ?: return
        if (playMethod == "DirectPlay") return
        // Jellyfin 12.2 dropped this route: off for that server after one 404/405, its Stopped report ends the encode.
        val server = api.server.id
        if (server in noActiveEncodings) return
        Core.scope.launch {
            runCatching { api.raw("DELETE", "/Videos/ActiveEncodings", null, "DeviceId" to api.deviceId, "PlaySessionId" to sid) }
                .onFailure { e -> if ((e as? ApiException)?.status in setOf(404, 405)) noActiveEncodings += server }
        }
    }

    // Stopped report, then an explicit "played" when the credits were reached before the
    // server's own 90 % rule would mark it. Offline, both wait in OfflineProgress.
    // switching (X-02): the old session of an in-place reload, never marked played nor handed to onSessionEnd.
    private fun endSession(switching: Boolean = false) {
        // Live: the Stopped report goes through the ledger (released once), then the sweep.
        live?.let {
            it.stop()
            // That Stopped goes out off the report queue: what reports next on this DeviceId (a direct cast, cast spec
            // §8.4) waits for the Live TV requests in flight, bounded. Owner -1 holds no stream: this sweep closes nothing.
            reporter.after { LiveSession.shared.sweep(owner = -1, deadlineMs = 5_000) }
            started = false
            return
        }
        if (started && !preview && !trailer && source != null) {
            val payload = body(null)
            val pos = player.currentPosition
            val dur = player.duration
            val watched = !switching && isWatched(pos, dur, segments.credits)
            val byCredits = !switching && markPlayedByCredits(api.server.kind, pos, dur, segments.credits)
            val id = itemId
            val it = item
            val pending = PendingProgress(api.server.id, api.userId.orEmpty(), id, resumeFrom(pos, dur) * TICKS_PER_MS, watched, System.currentTimeMillis())
            // Queued here, before whatever reports next on this DeviceId (a direct cast, cast spec §8.4).
            val stopped = reporter.stopped(payload)
            if (it != null) TraktService.shared.scrobble("stop", api, it, pos, dur)
            Core.scope.launch {
                // Behind a hung server the queue can hold it a long time: past 10 s the position is kept offline too.
                val sent = withTimeoutOrNull(10_000) { stopped.await() } == true &&
                    (!byCredits || runCatching { api.setPlayed(id, true) }.isSuccess)
                if (!sent) OfflineProgress.add(pending)
                if (it != null && it.id == id && !switching) runCatching { onSessionEnd(SessionEnd(it, pos, dur, watched)) }
            }
        }
        endEncoding()
        started = false
    }

    fun stop() {
        if (stopped) return
        stopped = true
        recovery?.cancel()
        if (RemoteControl.target === remoteTarget) RemoteControl.target = null
        debugReceiver?.let { runCatching { context.unregisterReceiver(it) } }
        debugReceiver = null
        endSession()
        player.removeListener(listener)
        player.removeAnalyticsListener(probe)
        AvSync.release(this)
        player.stop()
        onStopped()
    }
}

// X-02 version switch: the other version's stream with the same type, language and forced flag
// (the same codec first). Index numbers differ between versions.
private fun sameTrack(from: List<MediaStream>, to: List<MediaStream>, index: Int?): Int? {
    val s = from.firstOrNull { it.index == index } ?: return null
    val pool = to.filter { it.type == s.type && it.language == s.language && it.isForced == s.isForced }
    return (pool.firstOrNull { it.codec == s.codec } ?: pool.firstOrNull())?.index
}

// X-05: series whose "tracks from the previous episode" toast was shown in this process.
private val tracksToasted: MutableSet<String> = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>()) // newKeySet() is API 24, minSdk is 23

// Servers where DELETE /Videos/ActiveEncodings answered 404/405 (Jellyfin 12.2), for this process.
private val noActiveEncodings: MutableSet<String> = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>()) // newKeySet() is API 24, minSdk is 23

/** "720p · 2 Mb/s" for a preset, "Originale" for null or Original. */
fun qualityLabel(context: Context, maxBitrate: Int?): String {
    val p = Quality.PRESETS.firstOrNull { it.bitrate == maxBitrate } ?: return context.getString(R.string.quality_original)
    val mbps = java.text.NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 2 }.format(p.bitrate / 1_000_000.0)
    return context.getString(R.string.quality_preset, p.height, mbps)
}

/** The control-bar value: "720p" for a preset, "Originale" otherwise; the bitrate stays in the sheet. */
fun qualityShortLabel(context: Context, maxBitrate: Int?): String =
    Quality.PRESETS.firstOrNull { it.bitrate == maxBitrate }?.let { "${it.height}p" } ?: context.getString(R.string.quality_original)

// FF/REW with chapters (X-04 rule): the next chapter start, or back to the current chapter's start,
// or to the one before when within 3 s of it; nothing within 500 ms of 0 or past the last chapter.
fun chapterTarget(starts: List<Long>, positionMs: Long, forward: Boolean): Long? {
    if (forward) return starts.firstOrNull { it > positionMs }
    if (positionMs < 500) return null
    val i = starts.indexOfLast { it <= positionMs }
    if (i < 0) return 0
    return if (positionMs - starts[i] < 3_000) starts.getOrNull(i - 1) ?: 0 else starts[i]
}

/**
 * X-03 subtitle search state, shared by the TV panel and the mobile sheet: the language (last search, then
 * the server's subtitle preference, then the UI language), an optional title filter applied 500 ms after
 * the last keystroke (the servers take no title), and the results. A pick downloads on the server (the row
 * spins), then [Playback.refreshStreams] reloads with the new track and toasts.
 */
class SubtitleSearch(private val context: Context, private val pb: Playback, private val api: Api, private val scope: CoroutineScope) {
    var language by mutableStateOf("")
        private set
    var results by mutableStateOf<List<RemoteSubtitle>?>(null)
        private set
    var failure by mutableStateOf<SubtitleRules.Failure?>(null)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var title by mutableStateOf("")
        private set
    private var query by mutableStateOf("")
    private var filterJob: Job? = null
    private var searchJob: Job? = null
    private val prefs get() = context.getSharedPreferences("subtitle_search", Context.MODE_PRIVATE)

    val shown: List<RemoteSubtitle>?
        get() {
            val q = fold(query)
            return if (q.isEmpty()) results else results?.filter { fold("${it.name.orEmpty()} ${it.providerName.orEmpty()}").contains(q) }
        }

    fun open() {
        scope.launch {
            val pref = runCatching { api.subtitleUser().first }.getOrNull()
            language = SubtitleRules.language(prefs.getString("language", null), pref, Core.locale.language)
            search()
        }
    }

    fun pickLanguage(lang: String) {
        language = lang
        prefs.edit().putString("language", lang).apply()
        search()
    }

    fun filter(t: String) {
        title = t
        filterJob?.cancel()
        filterJob = scope.launch {
            delay(500)
            query = t
        }
    }

    private fun search() {
        val id = pb.item?.id ?: return
        searchJob?.cancel()
        results = null
        failure = null
        searchJob = scope.launch {
            try {
                results = api.searchSubtitles(id, language, pb.sourceId)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                failure = SubtitleRules.failure(e)
                results = emptyList()
            }
        }
    }

    /** Downloads [r] (spinner on its row), then hands over to the player and calls [onClose]. */
    fun pick(r: RemoteSubtitle, onClose: () -> Unit) {
        val id = pb.item?.id ?: return
        if (busy != null) return
        busy = r.id
        failure = null
        scope.launch {
            try {
                api.downloadSubtitle(id, r.id, pb.sourceId)
                pb.refreshStreams()
                onClose()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                failure = SubtitleRules.failure(e)
            } finally {
                busy = null
            }
        }
    }

    companion object {
        private val rights = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

        /** False only when the user's policy is known to forbid downloads (a 403 is still mapped in the sheet). */
        // A file source has no subtitle search (caps subtitleSearch): its sidecar files only.
        suspend fun allowed(api: Api): Boolean = if (!api.server.caps.subtitleSearch) false else rights["${api.server.id}:${api.userId}"]
            ?: runCatching { api.subtitleUser().second }.getOrDefault(true).also { rights["${api.server.id}:${api.userId}"] = it }

        // The language picker: the ISO 639-2 codes both servers search by, named in the UI language.
        val LANGUAGES = listOf("fre" to "fr", "eng" to "en", "ger" to "de", "spa" to "es", "ita" to "it", "por" to "pt", "dut" to "nl", "jpn" to "ja", "kor" to "ko")

        fun languageName(code: String): String = LANGUAGES.firstOrNull { it.first == code }?.second
            ?.let { java.util.Locale(it).getDisplayLanguage(Core.locale).replaceFirstChar { c -> c.titlecase(Core.locale) } } ?: code

        private fun fold(s: String) = java.text.Normalizer.normalize(s.trim(), java.text.Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()
    }
}

// A file source's streams once the file is open: its embedded audio and subtitle tracks, in container order (the
// order applyTracks maps by), plus the external sidecar subtitles the source listed.
internal fun fileStreams(tracks: Tracks, known: List<MediaStream>): List<MediaStream> {
    val external = known.filter { it.isExternal }
    var audio = 0
    var text = 0
    val embedded = tracks.groups.mapNotNull { g ->
        val f = g.mediaTrackGroup.getFormat(0)
        when {
            g.type == C.TRACK_TYPE_AUDIO -> MediaStream(
                index = audio++, type = "Audio", codec = f.sampleMimeType?.substringAfter('/'), language = f.language,
                displayTitle = listOfNotNull(f.label ?: f.language, f.sampleMimeType?.substringAfter('/')?.uppercase(), f.channelCount.takeIf { it > 0 }?.let { "${it}ch" }).joinToString(" · "),
                isDefault = (f.selectionFlags and C.SELECTION_FLAG_DEFAULT) != 0, channels = f.channelCount.takeIf { it > 0 },
            )
            g.type == C.TRACK_TYPE_TEXT && !f.id.orEmpty().contains(EXT_PREFIX) && !g.mediaTrackGroup.id.contains(EXT_PREFIX) -> MediaStream(
                index = 500 + text++, type = "Subtitle", codec = (f.codecs ?: f.sampleMimeType)?.substringAfter('/'), language = f.language,
                displayTitle = f.label ?: f.language ?: "#$text", isForced = (f.selectionFlags and C.SELECTION_FLAG_FORCED) != 0,
            )
            else -> null
        }
    }
    return embedded + external
}
