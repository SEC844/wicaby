package com.wika.wicaby.core.player

import android.app.Activity
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.livetv.CADENCE_FRAMES
import com.wika.wicaby.core.livetv.CadenceGate
import com.wika.wicaby.core.livetv.cadenceOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.abs
import kotlin.math.roundToInt

data class Mode(val id: Int, val width: Int, val height: Int, val refresh: Float, val hdr: Set<Int> = emptySet())

// Refresh rate = 1x or 2x the frame rate (x100 integers, so 23.976 prefers 23.976 Hz
// over 24 Hz but still accepts 24 Hz). 2.5x is 3:2 pulldown: no better than not switching.
// matchResolution picks the smallest mode that fits the video (the TV scales), otherwise
// the current resolution is kept.
fun bestMode(modes: List<Mode>, current: Mode, fps: Float, videoW: Int, videoH: Int, matchResolution: Boolean, hdrType: Int? = null): Mode? {
    if (fps < 10f) return null
    val f = (fps * 100).roundToInt()
    fun error(m: Mode): Pair<Int, Float>? {
        val r = (m.refresh * 100).roundToInt()
        return listOf(1, 2).map { k -> k to abs(r - f * k).toFloat() / (f * k) }.filter { it.second <= 0.002f }.minByOrNull { it.second }
    }
    var pool = modes
    if (hdrType != null && pool.any { hdrType in it.hdr }) pool = pool.filter { hdrType in it.hdr }
    val sizes = pool.map { it.width to it.height }.distinct()
    val order = if (!matchResolution) {
        listOf(current.width to current.height)
    } else {
        val fit = sizes.filter { (w, h) -> w >= videoW && h >= videoH && h >= 720 }.sortedBy { it.first * it.second }
        fit.ifEmpty { sizes.sortedByDescending { it.first * it.second }.take(1) }
    }
    for (size in order) {
        val best = pool.filter { (it.width to it.height) == size }
            .mapNotNull { m -> error(m)?.let { e -> Triple(m, e.second, e.first) } }
            .minWithOrNull(compareBy<Triple<Mode, Float, Int>> { it.second }.thenBy { it.third })
            ?.first ?: continue
        return best.takeIf { it.id != current.id }
    }
    return null
}

// Server stream -> Display.HdrCapabilities type, for picking a mode that keeps HDR.
fun hdrType(s: MediaStream?): Int? {
    val range = s?.videoRangeType.orEmpty().lowercase()
    val ext = s?.extendedVideoType.orEmpty().lowercase()
    return when {
        range.startsWith("dovi") && range != "doviinvalid" || ext == "dolbyvision" -> Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION
        range == "hlg" || ext == "hyperloggamma" -> Display.HdrCapabilities.HDR_TYPE_HLG
        range == "hdr10plus" || ext == "hdr10plus" -> Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS
        range == "hdr10" || ext == "hdr10" || s?.videoRange.equals("HDR", true) -> Display.HdrCapabilities.HDR_TYPE_HDR10
        else -> null
    }
}

// Sets the window's preferred display mode and waits for the TV to resync before playback starts.
class DisplaySwitcher(private val activity: Activity) {
    private val original = activity.window.attributes.preferredDisplayModeId
    private var switched = false

    @Suppress("DEPRECATION")
    private fun display(): Display? =
        if (Build.VERSION.SDK_INT >= 30) activity.display else activity.windowManager.defaultDisplay

    // Returns true when a switch happened (the caller then disables ExoPlayer's own frame-rate hints).
    suspend fun match(video: MediaStream?, matchResolution: Boolean): Boolean {
        if (video == null) return false
        val d = display() ?: return false
        val fps = video.realFrameRate ?: video.averageFrameRate ?: return false
        val modes = d.supportedModes.map { it.toMode() }
        val cur = d.mode.toMode()
        val target = bestMode(modes, cur, fps, video.width ?: 0, video.height ?: 0, matchResolution, hdrType(video)) ?: return switched
        val dm = activity.getSystemService(DisplayManager::class.java)
        val done = CompletableDeferred<Unit>()
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) {
                if (displayId == d.displayId && d.mode.modeId == target.id) done.complete(Unit)
            }
        }
        dm.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
        try {
            activity.window.attributes = activity.window.attributes.apply { preferredDisplayModeId = target.id }
            switched = true
            withTimeoutOrNull(5_000) { done.await() }
            // HDMI resync: TVs and AVRs drop the first second or two after a mode change.
            delay(1_500)
        } finally {
            dm.unregisterDisplayListener(listener)
        }
        return true
    }

    // Live (§21.5): the rate only, at once; the channel is already playing, so no resync wait.
    fun matchLive(hz: Float): Boolean {
        val d = display() ?: return false
        val cur = d.mode.toMode()
        val target = bestMode(d.supportedModes.map { it.toMode() }, cur, hz, 0, 0, matchResolution = false) ?: return false
        activity.window.attributes = activity.window.attributes.apply { preferredDisplayModeId = target.id }
        switched = true
        return true
    }

    fun restore() {
        if (!switched) return
        switched = false
        activity.window.attributes = activity.window.attributes.apply { preferredDisplayModeId = original }
    }
}

/**
 * Live display mode (§21.5, DM-1): measures each channel's cadence on its first decoded frames (not
 * MediaStream.realFrameRate, DVB says 25 for 50i) and hands [onSwitch] a display rate only when the
 * 24/50/60 family changes. Every first rendered frame (a zap) re-arms the measure.
 */
class LiveDisplayMode(player: ExoPlayer, private val isLive: () -> Boolean, private val onSwitch: (Float) -> Unit) {
    private val gate = CadenceGate()
    private val main = Handler(Looper.getMainLooper())
    private val pts = ArrayList<Long>(CADENCE_FRAMES)

    init {
        // Playback thread, once per frame: cheap until the measure is full.
        player.setVideoFrameMetadataListener { us, _, _, _ ->
            val fps = synchronized(pts) {
                if (pts.size >= CADENCE_FRAMES) return@setVideoFrameMetadataListener
                pts += us
                if (pts.size < CADENCE_FRAMES) return@setVideoFrameMetadataListener
                cadenceOf(pts)
            }
            main.post {
                if (!isLive()) return@post
                val hz = gate.next(fps)
                // Same line as the desktop's live-player.ts: zap checks count the "display" decisions.
                if (BuildConfig.DEBUG) Log.i("WicabyLive", "cadence $fps fps: ${hz?.let { "display $it Hz" } ?: "mode kept"}")
                hz?.let(onSwitch)
            }
        }
        player.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() {
                synchronized(pts) { pts.clear() }
            }
        })
    }
}

private fun Display.Mode.toMode() = Mode(
    modeId, physicalWidth, physicalHeight, refreshRate,
    if (Build.VERSION.SDK_INT >= 34) supportedHdrTypes.toSet() else emptySet(),
)
