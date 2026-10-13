package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Chapter
import com.wika.wicaby.core.data.MediaSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SegmentsTest {
    private fun ch(sec: Long, type: String) = Chapter(startPositionTicks = sec * 10_000_000, markerType = type)

    @Test
    fun embyMarkers() {
        val s = embySegments(listOf(ch(0, "Chapter"), ch(60, "IntroStart"), ch(150, "IntroEnd"), ch(300, "Chapter"), ch(2400, "CreditsStart")))
        assertEquals(60_000L, s.introStart)
        assertEquals(150_000L, s.introEnd)
        assertEquals(2_400_000L, s.credits)
        assertTrue(s.inIntro(60_000))
        assertFalse(s.inIntro(149_000)) // hidden in the last 2 s
        assertFalse(s.inIntro(30_000))
    }

    @Test
    fun embyIntroWithoutEndStopsAtNextChapter() {
        val s = embySegments(listOf(ch(0, "Chapter"), ch(20, "IntroStart"), ch(95, "Chapter")))
        assertEquals(95_000L, s.introEnd)
        assertNull(s.credits)
    }

    @Test
    fun jellyfinSegments() {
        val s = jellyfinSegments(listOf(MediaSegment("Intro", 10 * 10_000_000L, 70 * 10_000_000L), MediaSegment("Outro", 1300 * 10_000_000L, 1400 * 10_000_000L)))
        assertEquals(10_000L, s.introStart)
        assertEquals(70_000L, s.introEnd)
        assertEquals(1_300_000L, s.credits)
    }

    @Test
    fun jellyfinSkippableRanges() {
        fun seg(type: String, a: Long, b: Long) = MediaSegment(type, a * 10_000_000, b * 10_000_000)
        val s = jellyfinSegments(listOf(seg("Commercial", 600, 660), seg("Recap", 0, 45), seg("Intro", 50, 90), seg("Preview", 1400, 1440), seg("Unknown", 700, 800), seg("Recap", 900, 900)))
        assertEquals(listOf(SegmentKind.Recap, SegmentKind.Intro, SegmentKind.Commercial, SegmentKind.Preview), s.ranges.map { it.kind })
        assertEquals(SkipRange(SegmentKind.Recap, 0, 45_000), s.skippableAt(10_000))
        assertNull(s.skippableAt(44_000)) // last 2 s
        assertEquals(SegmentKind.Commercial, s.skippableAt(630_000)?.kind)
        assertNull(s.skippableAt(750_000)) // Unknown is not skippable
    }

    @Test
    fun embyMarkerRanges() {
        val s = embySegments(listOf(ch(0, "RecapStart"), ch(40, "RecapEnd"), ch(60, "IntroStart"), ch(150, "IntroEnd"), ch(800, "CommercialStart")))
        assertEquals(listOf(SegmentKind.Recap, SegmentKind.Intro), s.ranges.map { it.kind }) // a Start with no End is dropped
        assertEquals(SegmentKind.Intro, s.skippableAt(100_000)?.kind)
        assertEquals(60_000L, s.introStart)
    }

    @Test
    fun resumeThresholds() {
        val hour = 3_600_000L
        assertEquals(0L, resumeFrom(hour / 50, hour)) // 2 %
        assertEquals(hour / 2, resumeFrom(hour / 2, hour))
        assertEquals(0L, resumeFrom(hour * 95 / 100, hour))
        assertEquals(1234L, resumeFrom(1234, 0)) // unknown duration: trust the server
    }

    @Test
    fun watchedAtNinetyPercentOrCredits() {
        assertTrue(isWatched(900, 1000, null))
        assertFalse(isWatched(850, 1000, null))
        assertTrue(isWatched(850, 1000, 800))
        assertFalse(isWatched(10, 0, null))
    }

    @Test
    fun upNextTrigger() {
        assertEquals(2_400_000L, upNextAt(2_520_000, 2_400_000))
        assertEquals(2_490_000L, upNextAt(2_520_000, null))
        assertNull(upNextAt(0, null))
    }
}
