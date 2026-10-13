package com.wika.wicaby.core.livetv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// DM-1 (spec §21.5): display mode for live, cadence from the first frames, switch only across 24/50/60.
class CadenceTest {
    // CADENCE_FRAMES presentation times at [fps], from [startUs].
    private fun frames(fps: Double, startUs: Long = 9_000_000_000L) = List(CADENCE_FRAMES) { startUs + (it * 1_000_000 / fps).toLong() }

    @Test
    fun families() {
        assertEquals(50, cadenceTarget(25f)?.family)
        assertEquals(50f, cadenceTarget(25f)?.hz)
        assertEquals(50f, cadenceTarget(50f)?.hz)
        assertEquals(59.94f, cadenceTarget(29.97f)?.hz)
        assertEquals(59.94f, cadenceTarget(59.94f)?.hz)
        assertEquals(23.976f, cadenceTarget(23.976f)?.hz)
        assertEquals(24f, cadenceTarget(24f)?.hz)
        for (v in listOf(null, 0f, 5f, 37f, 27.5f)) assertNull(cadenceTarget(v))
    }

    @Test
    fun measuredFromFrameTimes() {
        assertEquals(25f, cadenceOf(frames(25.0))!!, 0.01f)
        assertEquals(59.94f, cadenceOf(frames(60_000.0 / 1001))!!, 0.01f)
        // A zap gap and a duplicate timestamp in the window do not move the median.
        val mixed = frames(25.0).take(6) + frames(25.0, 9_100_000_000L).take(6) + listOf(9_100_000_000L + 6 * 40_000)
        assertEquals(25f, cadenceOf(mixed)!!, 0.01f)
        assertNull(cadenceOf(listOf(1L)))
        // 59.94 muxed with jittery 90 kHz PTS (1500/1504/1503 ticks, as mpv writes it): not 60, so the 59.94 Hz mode wins.
        val ticks = listOf(1500, 1504, 1500, 1504, 1500, 1500, 1503, 1500, 1504, 1500, 1500)
        val jittery = ticks.runningFold(0L) { t, d -> t + d }.map { it * 1000 / 90 }
        assertEquals(59.94f, cadenceOf(jittery)!!, 0.03f)
        assertEquals(59.94f, cadenceTarget(cadenceOf(jittery))!!.hz, 0.03f)
    }

    @Test
    fun zapsInsideAFamilyNeverSwitch() {
        val gate = CadenceGate()
        assertEquals(50f, gate.next(cadenceOf(frames(25.0)))) // first channel: matched once
        var switches = 0
        // 20 zaps between two 1080i25 channels.
        repeat(20) { i -> if (gate.next(cadenceOf(frames(25.0, 1_000_000L * i))) != null) switches++ }
        assertEquals(0, switches)
        // 1080i25 → 720p60: one switch, then none on the same family.
        assertEquals(59.94f, gate.next(cadenceOf(frames(60_000.0 / 1001)))!!, 0.01f)
        assertNull(gate.next(cadenceOf(frames(60.0))))
        assertNull(gate.next(null)) // radio: keep
        assertEquals(60, gate.family)
    }
}
