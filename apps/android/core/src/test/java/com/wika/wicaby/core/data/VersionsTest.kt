package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

class VersionsTest {
    private val uhd = listOf(
        MediaStream(0, "Video", "hevc", width = 3840, height = 2160, videoRange = "HDR", videoRangeType = "HDR10"),
        MediaStream(1, "Audio", "truehd", language = "fre", isDefault = true, channels = 8, displayTitle = "Français TrueHD Atmos 7.1"),
    )
    private val hd = listOf(
        MediaStream(0, "Video", "h264", width = 1920, height = 800),
        MediaStream(1, "Audio", "ac3", language = "eng", channels = 6),
        MediaStream(2, "Subtitle", "subrip", language = "fre", isForced = true),
    )

    @Test
    fun qualityLabel() {
        assertEquals("4K HDR10 · HEVC · Atmos", Versions.quality(MediaSource("a", mediaStreams = uhd)))
        assertEquals("1080p · H.264 · 5.1", Versions.quality(MediaSource("b", mediaStreams = hd)))
    }

    @Test
    fun namesWinOverQuality() {
        val labels = Versions.labels(
            "Inception",
            listOf(MediaSource("a", name = "Inception - Director's Cut", mediaStreams = uhd), MediaSource("b", name = "Inception (2010).mkv", mediaStreams = hd)),
        )
        // The second name is only the title and year: its quality and languages tell it apart.
        assertEquals(listOf("Director's Cut", "1080p · H.264 · 5.1 · EN"), labels)
    }

    @Test
    fun sameNamesGetQualityThenNumbers() {
        assertEquals(
            listOf("Version 4K · 4K HDR10 · HEVC · Atmos", "Version 4K · 1080p · H.264 · 5.1"),
            Versions.labels("X", listOf(MediaSource("a", name = "Version 4K", mediaStreams = uhd), MediaSource("b", name = "Version 4K", mediaStreams = hd))),
        )
        assertEquals(listOf("1080p · H.264 · 5.1 (1)", "1080p · H.264 · 5.1 (2)"), Versions.labels("X", listOf(MediaSource("a", mediaStreams = hd), MediaSource("b", mediaStreams = hd))))
    }

    @Test
    fun defaults() {
        val s = MediaSource("b", mediaStreams = hd)
        assertEquals(1, Versions.defaultAudioStream(s)?.index)
        // The server's pick only: a French forced track under English audio is not a default.
        assertEquals(-1, Versions.defaultSubtitleIndex(s))
        assertEquals(2, Versions.defaultSubtitleIndex(s.copy(defaultSubtitleStreamIndex = 2)))
        assertEquals(-1, Versions.defaultSubtitleIndex(s.copy(defaultSubtitleStreamIndex = -1)))
        assertEquals("FR", Versions.languages(MediaSource("a", mediaStreams = uhd)))
    }
}
