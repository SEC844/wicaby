package com.wika.wicaby.core.player

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.DefaultAllocator
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import android.util.Log
import com.wika.wicaby.core.BuildConfig
import java.util.Collections
import java.util.WeakHashMap
import com.wika.wicaby.core.livetv.LivePort
import com.wika.wicaby.core.livetv.LiveTuner

// Media3 live profile (spec §8.9, [verify] V14 by measurement): start fast, cap memory on a 32-bit TV.
// buildEngine installs LiveProfileSwitch; ExoLivePort turns it on while a channel plays, so the same
// player instance serves VOD (Media3's durations, a heap-sized byte cap) and live, across zaps.

/** 4 s min / 15 s max buffer, playback after 1 s (2.5 s after a rebuffer), 16 MiB target, no back buffer. */
fun liveLoadControl(allocator: DefaultAllocator = DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE)): DefaultLoadControl = DefaultLoadControl.Builder()
    .setAllocator(allocator)
    .setBufferDurationsMs(4_000, 15_000, 1_000, 2_500)
    .setTargetBufferBytes(LIVE_TARGET_BYTES)
    .setPrioritizeTimeOverSizeThresholds(false)
    .setBackBuffer(0, false)
    .build()

const val LIVE_TARGET_BYTES = 16 * 1024 * 1024

/**
 * VOD byte target: a quarter of the app's heap class (ActivityManager.memoryClass, MB), 16 to 128 MiB.
 * Media3's default (~130 MB for video) sits on the Java heap and OOMs 32-bit TVs on high-bitrate remuxes.
 */
fun vodBufferBytes(memoryClassMb: Int): Int = (memoryClassMb / 4).coerceIn(16, 128) * 1024 * 1024

/** Faster first frames on IPTV MPEG-TS (DefaultExtractorsFactory.setTsExtractorFlags). */
const val LIVE_TS_FLAGS = DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS

/**
 * The engine's load control: Media3's default, or the live profile while [live]. Both instances see
 * every lifecycle call (their per-player state stays valid across a switch) and share one allocator;
 * the active one decides and runs last, so the allocator keeps its target size. Both keep no back
 * buffer, the one setting ExoPlayer reads only once.
 */
class LiveProfileSwitch(private val extractors: DefaultExtractorsFactory, private val vodTargetBytes: Int) : LoadControl {
    private val allocator = DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE)
    private val vod = DefaultLoadControl.Builder().setAllocator(allocator)
        .setTargetBufferBytes(vodTargetBytes)
        .setPrioritizeTimeOverSizeThresholds(false)
        .build()
    private val liveControl = liveLoadControl(allocator)

    @Volatile
    var live = false
        set(v) {
            field = v
            // Read when the next prepare() creates its extractors.
            extractors.setTsExtractorFlags(if (v) LIVE_TS_FLAGS else 0)
        }

    private val active get() = if (live) liveControl else vod

    private inline fun both(f: (LoadControl) -> Unit) {
        val l = live
        f(if (l) vod else liveControl)
        f(if (l) liveControl else vod)
    }

    fun register(player: ExoPlayer) {
        switches[player] = this
    }

    override fun onPrepared(playerId: PlayerId) = both { it.onPrepared(playerId) }
    override fun onTracksSelected(parameters: LoadControl.Parameters, trackGroups: TrackGroupArray, trackSelections: Array<out ExoTrackSelection?>) =
        both { it.onTracksSelected(parameters, trackGroups, trackSelections) }
    override fun onStopped(playerId: PlayerId) = both { it.onStopped(playerId) }
    override fun onReleased(playerId: PlayerId) = both { it.onReleased(playerId) }
    override fun getAllocator(playerId: PlayerId): Allocator = allocator
    override fun getBackBufferDurationUs(playerId: PlayerId) = active.getBackBufferDurationUs(playerId)
    override fun retainBackBufferFromKeyframe(playerId: PlayerId) = active.retainBackBufferFromKeyframe(playerId)

    // Media3 1.11 counts a player's bytes only through the allocator each DefaultLoadControl hands out, and
    // ExoPlayer holds this shared one (both profiles see one buffer): their byte targets never trip, so the
    // switch applies them. Full also starts playback, as Media3 does, so a big first GOP cannot stall.
    private fun full() = allocator.totalBytesAllocated >= if (live) LIVE_TARGET_BYTES else vodTargetBytes
    override fun shouldContinueLoading(parameters: LoadControl.Parameters) = active.shouldContinueLoading(parameters) && !full()
    override fun shouldStartPlayback(parameters: LoadControl.Parameters) = active.shouldStartPlayback(parameters) || full()
    override fun shouldContinuePreloading(playerId: PlayerId, timeline: Timeline, mediaPeriodId: MediaSource.MediaPeriodId, bufferedDurationUs: Long) =
        active.shouldContinuePreloading(playerId, timeline, mediaPeriodId, bufferedDurationUs)
}

private val switches: MutableMap<Player, LiveProfileSwitch> = Collections.synchronizedMap(WeakHashMap())

/** LiveTuner's view of the ExoPlayer: first frame (radio: ready without video), errors, end, play/pause and buffering. */
class ExoLivePort(private val player: ExoPlayer) : LivePort {
    private var tuner: LiveTuner? = null

    private val listener = object : Player.Listener {
        override fun onRenderedFirstFrame() {
            tuner?.onFirstFrame()
        }

        override fun onPlaybackStateChanged(state: Int) {
            val t = tuner ?: return
            if (state == Player.STATE_READY && !player.currentTracks.isTypeSelected(C.TRACK_TYPE_VIDEO)) t.onFirstFrame()
            if (state == Player.STATE_ENDED) t.onEnded() else t.onStateChanged()
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            tuner?.onStateChanged()
        }

        override fun onPlayerError(error: PlaybackException) {
            val status = (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
            tuner?.onError(error.errorCodeName, status)
        }
    }

    override fun attach(t: LiveTuner?) {
        if (t != null && tuner == null) player.addListener(listener)
        if (t == null && tuner != null) player.removeListener(listener)
        tuner = t
        switches[player]?.let {
            it.live = t != null
            if (BuildConfig.DEBUG) Log.d("WicabyLive", "live profile ${if (it.live) "on" else "off"}")
        }
    }

    override fun load(url: String, hls: Boolean, title: String) {
        val item = MediaItem.Builder()
            .setUri(url)
            .apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()
        player.setMediaItem(item)
        player.prepare()
        player.play()
    }

    override fun stop() = player.stop()

    override val playWhenReady get() = player.playWhenReady
    override val buffering get() = player.playbackState == Player.STATE_BUFFERING
}
