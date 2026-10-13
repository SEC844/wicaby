package com.wika.wicaby.core.player

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.SinglePeriodTimeline
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.extractor.DefaultExtractorsFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VodBufferCapTest {
    private val mib = 1024 * 1024

    @Test
    fun capFollowsTheHeapClass() {
        assertEquals(16 * mib, vodBufferBytes(32)) // floor
        assertEquals(16 * mib, vodBufferBytes(64))
        assertEquals(24 * mib, vodBufferBytes(96))
        assertEquals(64 * mib, vodBufferBytes(256))
        assertEquals(128 * mib, vodBufferBytes(512))
        assertEquals(128 * mib, vodBufferBytes(1024)) // ceiling, under Media3's ~130 MB default
    }

    // The bugs: the cap went on a load control the engine then replaced, and Media3 1.11 counts bytes only
    // through each DefaultLoadControl's own allocator, which ExoPlayer never got. Loading now stops at the
    // cap (and playback may start) for a server stream, a download (Media3's local-playback thresholds)
    // and the live profile's 16 MiB.
    @Test
    fun loadingStopsAtTheCap() {
        val cases = listOf(
            Triple("https://server.invalid/Videos/1/stream", false, vodBufferBytes(64)),
            Triple("file:///sdcard/Movies/1.mkv", false, vodBufferBytes(64)),
            Triple("https://server.invalid/LiveTv/1/stream.ts", true, LIVE_TARGET_BYTES),
        )
        for ((uri, live, cap) in cases) {
            val control = LiveProfileSwitch(DefaultExtractorsFactory(), vodBufferBytes(512))
            control.live = live
            val id = PlayerId.UNSET
            control.onPrepared(id)
            val timeline = SinglePeriodTimeline(7_200_000_000, true, false, false, null, MediaItem.fromUri(uri))
            // 1 s buffered (VOD and live minimums are higher): only the byte cap can stop loading.
            val params = LoadControl.Parameters(
                id, timeline, MediaSource.MediaPeriodId(timeline.getUidOfPeriod(0)), 0, 1_000_000, 1f, true, false, C.TIME_UNSET, C.TIME_UNSET,
            )
            control.onTracksSelected(params, TrackGroupArray.EMPTY, arrayOf())
            val allocator = control.getAllocator(id)
            val target = if (live) cap else vodBufferBytes(512)
            repeat(target / allocator.individualAllocationLength - 1) { allocator.allocate() }
            assertTrue(uri, control.shouldContinueLoading(params))
            allocator.allocate()
            assertFalse(uri, control.shouldContinueLoading(params))
            assertTrue(uri, control.shouldStartPlayback(LoadControl.Parameters(
                id, timeline, MediaSource.MediaPeriodId(timeline.getUidOfPeriod(0)), 0, 100_000, 1f, true, false, C.TIME_UNSET, C.TIME_UNSET,
            )))
            control.onReleased(id)
        }
    }

    // Field evidence (0.4.1 on a 32-bit Android TV): a 4K remux OOMed at a 192 MB heap growth limit. A 100 Mb/s
    // stream is fed the way ProgressiveMediaPeriod loads (1 MiB between continueLoading checks) while playback
    // drains it, for 10 minutes of media: the buffer never passes the cap plus one chunk, a quarter of the heap.
    @Test
    fun hundredMbpsRemuxStaysUnderTheCapOnA192MbHeap() {
        val memoryClass = 192
        val cap = vodBufferBytes(memoryClass)
        assertEquals(48 * mib, cap)
        val control = LiveProfileSwitch(DefaultExtractorsFactory(), cap)
        val id = PlayerId.UNSET
        control.onPrepared(id)
        val timeline = SinglePeriodTimeline(7_200_000_000, true, false, false, null, MediaItem.fromUri("https://server.invalid/Videos/1/stream"))
        fun params(bufferedUs: Long) = LoadControl.Parameters(
            id, timeline, MediaSource.MediaPeriodId(timeline.getUidOfPeriod(0)), 0, bufferedUs, 1f, true, false, C.TIME_UNSET, C.TIME_UNSET,
        )
        control.onTracksSelected(params(0), TrackGroupArray.EMPTY, arrayOf())
        val allocator = control.getAllocator(id)
        val chunk = allocator.individualAllocationLength
        val bytesPerSecond = 100_000_000L / 8
        val held = ArrayDeque<androidx.media3.exoplayer.upstream.Allocation>()
        fun bufferedUs() = held.size * chunk * 1_000_000L / bytesPerSecond
        var peak = 0
        var started = false
        // 100 ms ticks: load while the control asks for more, then play 100 ms worth once started.
        repeat(6_000) {
            var loadedThisTick = 0L
            while (loadedThisTick < bytesPerSecond && control.shouldContinueLoading(params(bufferedUs()))) {
                repeat((1024 * 1024) / chunk) { held.addLast(allocator.allocate()) }
                loadedThisTick += 1024 * 1024
                peak = maxOf(peak, allocator.totalBytesAllocated)
            }
            if (!started) started = control.shouldStartPlayback(params(bufferedUs()))
            if (started) repeat((bytesPerSecond / 10 / chunk).toInt().coerceAtMost(held.size)) { allocator.release(held.removeFirst()) }
        }
        assertTrue("playback started", started)
        assertTrue("peak $peak over ${cap + mib}", peak <= cap + mib)
        assertTrue("a quarter of the heap at most", peak <= (memoryClass / 4 + 1) * mib)
        // Under the 192 MiB growth limit with room for the decoders, the UI and the image cache.
        assertTrue(peak < memoryClass * mib / 3)
        control.onReleased(id)
    }
}
