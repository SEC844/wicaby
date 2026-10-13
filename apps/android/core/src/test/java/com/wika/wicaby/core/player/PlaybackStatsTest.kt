package com.wika.wicaby.core.player

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
