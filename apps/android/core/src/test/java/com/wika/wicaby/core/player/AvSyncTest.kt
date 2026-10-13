package com.wika.wicaby.core.player

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AvSyncTest {
    private val ep1 = AvSync.Keys("s:e1", "s:show")
    private val ep2 = AvSync.Keys("s:e2", "s:show")
    private val movie = AvSync.Keys("s:m", null)
    private val empty = JsonObject(emptyMap())

    @Test
    fun rememberedPerItemOnly() {
        var doc = AvSync.write(empty, AvSync.AUDIO, ep1, 150, seriesWide = false, now = 1)
        doc = AvSync.write(doc, AvSync.SUBTITLE, ep1, -300, seriesWide = false, now = 2)
        assertEquals(150, AvSync.read(doc, AvSync.AUDIO, ep1))
        assertEquals(-300, AvSync.read(doc, AvSync.SUBTITLE, ep1))
        // The next episode starts at 0.
        assertEquals(0, AvSync.read(doc, AvSync.AUDIO, ep2))
        assertEquals(0, AvSync.read(doc, AvSync.SUBTITLE, ep2))
        assertFalse(AvSync.seriesWide(doc, ep2))
    }

    @Test
    fun wholeSeriesCarriesOverUntilTurnedOff() {
        var doc = AvSync.write(empty, AvSync.AUDIO, ep1, 100, seriesWide = false, now = 1)
        doc = AvSync.setSeriesWide(doc, ep1, on = true, audioMs = 100, subtitleMs = 200, now = 2)
        assertTrue(AvSync.seriesWide(doc, ep2))
        assertEquals(100, AvSync.read(doc, AvSync.AUDIO, ep2))
        assertEquals(200, AvSync.read(doc, AvSync.SUBTITLE, ep2))
        // A step while series-wide moves the series value too.
        doc = AvSync.write(doc, AvSync.AUDIO, ep2, 150, seriesWide = true, now = 3)
        assertEquals(150, AvSync.read(doc, AvSync.AUDIO, AvSync.Keys("s:e3", "s:show")))
        // Off: the other episodes are back to 0, this one keeps what it shows.
        doc = AvSync.setSeriesWide(doc, ep2, on = false, audioMs = 150, subtitleMs = 200, now = 4)
        assertFalse(AvSync.seriesWide(doc, ep2))
        assertEquals(0, AvSync.read(doc, AvSync.AUDIO, AvSync.Keys("s:e3", "s:show")))
        assertEquals(150, AvSync.read(doc, AvSync.AUDIO, ep2))
        assertEquals(200, AvSync.read(doc, AvSync.SUBTITLE, ep2))
        assertEquals(100, AvSync.read(doc, AvSync.AUDIO, ep1))
    }

    @Test
    fun movieHasNoSeriesAndValuesAreClamped() {
        var doc = AvSync.write(empty, AvSync.AUDIO, movie, 9_000, seriesWide = true, now = 1)
        assertEquals(AvSync.MAX_MS, AvSync.read(doc, AvSync.AUDIO, movie))
        doc = AvSync.setSeriesWide(doc, movie, on = true, audioMs = 50, subtitleMs = 0, now = 2)
        assertFalse(AvSync.seriesWide(doc, movie))
        assertEquals(AvSync.MAX_MS, AvSync.read(doc, AvSync.AUDIO, movie))
        assertEquals(-AvSync.MAX_MS, AvSync.clamp(-12_000))
    }

    @Test
    fun survivesTheJsonRoundTrip() {
        val doc = AvSync.setSeriesWide(empty, ep1, on = true, audioMs = -50, subtitleMs = 400, now = 1)
        val back = com.wika.wicaby.core.data.json.parseToJsonElement(doc.toString()) as JsonObject
        assertEquals(-50, AvSync.read(back, AvSync.AUDIO, ep2))
        assertEquals(400, AvSync.read(back, AvSync.SUBTITLE, ep2))
    }

    @Test
    fun shiftsBelongToTheirPlayer() {
        val a = Any()
        val b = Any()
        AvSync.apply(a, 100, -200)
        assertEquals(100_000L, AvSync.audioUs)
        assertEquals(-200_000L, AvSync.subtitleUs)
        AvSync.apply(b, 50, 0)
        AvSync.release(a) // the old player closing late
        assertEquals(50_000L, AvSync.audioUs)
        AvSync.release(b)
        assertEquals(0L, AvSync.audioUs)
    }
}
