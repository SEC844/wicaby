package com.wika.wicaby.core.player

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackStatsTest {
    @Test
    fun codecNames() {
        assertEquals("HEVC", PlaybackStats.codecName(MimeTypes.VIDEO_H265))
        assertEquals("E-AC3 Atmos", PlaybackStats.codecName(MimeTypes.AUDIO_E_AC3_JOC))
        assertEquals("TrueHD", PlaybackStats.codecName(MimeTypes.AUDIO_TRUEHD))
        assertEquals("X-FOO", PlaybackStats.codecName("video/x-foo"))
        assertNull(PlaybackStats.codecName(null))
    }

    @Test
    fun profiles() {
        assertEquals("Main 10", PlaybackStats.profile("hvc1.2.4.L153.B0"))
        assertEquals("Main", PlaybackStats.profile("hev1.A1.60.L93.B0"))
        assertEquals("High", PlaybackStats.profile("avc1.640028"))
        assertEquals("Profile 8", PlaybackStats.profile("dvh1.08.06"))
        assertNull(PlaybackStats.profile("mp4a.40.2"))
        assertNull(PlaybackStats.profile(null))
    }

    @Test
    fun hdrFromTheDecodedFormat() {
        assertEquals("HDR10", PlaybackStats.hdr(MimeTypes.VIDEO_H265, C.COLOR_TRANSFER_ST2084))
        assertEquals("HLG", PlaybackStats.hdr(MimeTypes.VIDEO_H265, C.COLOR_TRANSFER_HLG))
        assertEquals("Dolby Vision", PlaybackStats.hdr(MimeTypes.VIDEO_DOLBY_VISION, C.COLOR_TRANSFER_ST2084))
        assertNull(PlaybackStats.hdr(MimeTypes.VIDEO_H264, C.COLOR_TRANSFER_SDR))
        assertNull(PlaybackStats.hdr(MimeTypes.VIDEO_H264, Format.NO_VALUE))
    }

    @Test
    fun channelLayouts() {
        assertEquals("2.0", PlaybackStats.channels(2))
        assertEquals("5.1", PlaybackStats.channels(6))
        assertEquals("7.1", PlaybackStats.channels(8))
        assertEquals("4 ch", PlaybackStats.channels(4))
        assertNull(PlaybackStats.channels(Format.NO_VALUE))
    }

    @Test
    fun hardwareOrSoftware() {
        assertFalse(PlaybackStats.isSoftware("c2.qti.hevc.decoder"))
        assertFalse(PlaybackStats.isSoftware("OMX.MTK.VIDEO.DECODER.HEVC"))
        assertTrue(PlaybackStats.isSoftware("c2.android.hevc.decoder"))
        assertTrue(PlaybackStats.isSoftware("OMX.google.aac.decoder"))
        assertTrue(PlaybackStats.isSoftware("ffmpegLib-6.0"))
        assertTrue(PlaybackStats.isSoftware("libdav1d"))
    }

    @Test
    fun transcodeUrlFields() {
        val url = "/videos/1/master.m3u8?MediaSourceId=1&VideoCodec=h264&VideoBitrate=7616000&AudioBitrate=384000&TranscodeReasons=ContainerNotSupported%2CAudioCodecNotSupported"
        assertEquals(listOf("ContainerNotSupported", "AudioCodecNotSupported"), PlaybackStats.reasons(url))
        assertEquals(8_000_000L, PlaybackStats.transcodeBitrate(url))
        assertEquals(emptyList<String>(), PlaybackStats.reasons("/videos/1/stream?static=true"))
        assertNull(PlaybackStats.transcodeBitrate("/videos/1/stream?static=true"))
        assertEquals(emptyList<String>(), PlaybackStats.reasons(null))
    }

    @Test
    fun lineSkipsMissingParts() {
        assertEquals("HEVC · 3840×2160 · HDR10", PlaybackStats.line("HEVC", null, "3840×2160", "", "HDR10"))
        assertNull(PlaybackStats.line(null, " "))
    }

    @Test
    fun levels() {
        assertEquals("5.1", PlaybackStats.level("hvc1.2.4.L153.B0"))
        assertEquals("4.0", PlaybackStats.level("hev1.1.6.H120.90"))
        assertEquals("4.0", PlaybackStats.level("avc1.640028"))
        assertEquals("5.1", PlaybackStats.level("avc1.4D0033"))
        assertEquals("4.0", PlaybackStats.level("av01.0.08M.10"))
        assertEquals("5.1", PlaybackStats.level("vp09.02.51.10"))
        assertEquals("6", PlaybackStats.level("dvh1.08.06"))
        assertNull(PlaybackStats.level("av01.0.31M.08"))
        assertNull(PlaybackStats.level("mp4a.40.2"))
        assertNull(PlaybackStats.level("hvc1.2.4"))
        assertNull(PlaybackStats.level(null))
    }

    @Test
    fun subtitleFormats() {
        assertEquals("SRT", PlaybackStats.subtitleFormat("subrip"))
        assertEquals("PGS", PlaybackStats.subtitleFormat("PGSSUB"))
        assertEquals("VobSub", PlaybackStats.subtitleFormat("dvd_subtitle"))
        assertEquals("ASS", PlaybackStats.subtitleFormat("ass"))
        assertEquals("XSUB", PlaybackStats.subtitleFormat("xsub"))
        assertNull(PlaybackStats.subtitleFormat(" "))
        assertNull(PlaybackStats.subtitleFormat(null))
    }

    @Test
    fun transcodeReasonsAreWordedOrSpacedOut() {
        // Every reason the desktop dashboard words has its string.
        listOf(
            "ContainerNotSupported", "VideoCodecNotSupported", "AudioCodecNotSupported", "SubtitleCodecNotSupported", "ContainerBitrateExceedsLimit",
            "VideoBitrateNotSupported", "AudioBitrateNotSupported", "VideoResolutionNotSupported", "VideoLevelNotSupported", "VideoProfileNotSupported",
            "VideoBitDepthNotSupported", "VideoFramerateNotSupported", "VideoRangeTypeNotSupported", "RefFramesNotSupported", "AnamorphicVideoNotSupported",
            "InterlacedVideoNotSupported", "AudioChannelsNotSupported", "AudioProfileNotSupported", "AudioSampleRateNotSupported", "AudioBitDepthNotSupported",
            "SecondaryAudioNotSupported", "AudioIsExternal", "DirectPlayError", "UnknownVideoStreamInfo", "UnknownAudioStreamInfo", "StreamCountExceedsLimit",
        ).forEach { assertNotNull(it, PlaybackStats.reasonText(it)) }
        assertNull(PlaybackStats.reasonText("NewThingNotSupported"))
        assertEquals("New Thing Not Supported", PlaybackStats.spaced("NewThingNotSupported"))
    }

    @Test
    fun connectionPath() {
        assertEquals(PlaybackStats.Link.Local, PlaybackStats.link(false, "192.168.1.5"))
        assertEquals(PlaybackStats.Link.Local, PlaybackStats.link(false, "nas"))
        assertEquals(PlaybackStats.Link.Local, PlaybackStats.link(false, "nas.local"))
        assertEquals(PlaybackStats.Link.Remote, PlaybackStats.link(false, "media.example.org"))
        assertEquals(PlaybackStats.Link.Remote, PlaybackStats.link(false, "203.0.113.7"))
        // The mesh wins, even for a LAN address it forwards.
        assertEquals(PlaybackStats.Link.Mesh, PlaybackStats.link(true, "100.64.0.3"))
        assertEquals(PlaybackStats.Link.Mesh, PlaybackStats.link(true, "192.168.1.5"))
    }
}
