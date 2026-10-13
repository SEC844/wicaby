package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Both servers' field shapes for the same kinds of files.
class VideoRangeTest {
    private fun v(
        range: String? = null, rangeType: String? = null, ext: String? = null, sub: String? = null,
        transfer: String? = null, dvProfile: Int? = null, compat: Int? = null,
    ) = MediaStream(
        0, "Video", "hevc", videoRange = range, videoRangeType = rangeType, extendedVideoType = ext, extendedVideoSubType = sub,
        colorTransfer = transfer, dvProfile = dvProfile, dvBlSignalCompatibilityId = compat,
    )

    @Test
    fun emby() {
        VideoRange.of(v("HDR", ext = "DolbyVision", sub = "DoviProfile81", transfer = "smpte2084")).let {
            assertEquals("Dolby Vision · HDR10", it.badge)
            assertEquals("8.1", it.dvProfile)
        }
        VideoRange.of(v("HDR", ext = "DolbyVision", sub = "DoviProfile84", transfer = "arib-std-b67")).let {
            assertEquals("Dolby Vision · HLG", it.badge)
            assertEquals("8.4", it.dvProfile)
        }
        VideoRange.of(v("HDR", ext = "DolbyVision", sub = "DoviProfile50")).let {
            assertEquals("Dolby Vision", it.badge)
            assertEquals("5", it.dvProfile)
        }
        assertEquals("Dolby Vision · HDR10", VideoRange.of(v("HDR", ext = "DolbyVision", sub = "DoviProfile76")).badge)
        assertEquals("HDR10+", VideoRange.of(v("HDR", ext = "Hdr10Plus", transfer = "smpte2084")).badge)
        assertEquals("HDR10", VideoRange.of(v("HDR", ext = "Hdr10", transfer = "smpte2084")).badge)
        assertEquals("HLG", VideoRange.of(v("HDR", ext = "HyperLogGamma")).badge)
        // Older Emby: only the range and the transfer.
        assertEquals("HDR10", VideoRange.of(v("HDR", transfer = "smpte2084")).badge)
        assertEquals("HLG", VideoRange.of(v("HDR", transfer = "arib-std-b67")).badge)
        assertEquals("HDR", VideoRange.of(v("HDR")).badge)
        assertNull(VideoRange.of(v("SDR", transfer = "bt709")).badge)
        assertNull(VideoRange.of(null).badge)
    }

    @Test
    fun jellyfin() {
        VideoRange.of(v("HDR", "DOVIWithHDR10", dvProfile = 8, compat = 1)).let {
            assertEquals("Dolby Vision · HDR10", it.badge)
            assertEquals("8.1", it.dvProfile)
        }
        assertEquals("Dolby Vision · HLG", VideoRange.of(v("HDR", "DOVIWithHLG", dvProfile = 8, compat = 4)).badge)
        assertEquals("Dolby Vision", VideoRange.of(v("SDR", "DOVIWithSDR", dvProfile = 8, compat = 2)).badge)
        VideoRange.of(v("HDR", "DOVI", dvProfile = 5, compat = 0)).let {
            assertEquals("Dolby Vision", it.badge)
            assertEquals("5", it.dvProfile)
        }
        assertEquals("HDR10+", VideoRange.of(v("HDR", "HDR10Plus")).badge)
        assertEquals("HDR10", VideoRange.of(v("HDR", "HDR10")).badge)
        assertEquals("HLG", VideoRange.of(v("HDR", "HLG")).badge)
        assertNull(VideoRange.of(v("SDR", "SDR")).badge)
    }

    @Test
    fun jsonFieldsSurvive() {
        val s = json.decodeFromString(
            MediaStream.serializer(),
            """{"Index":0,"Type":"Video","VideoRange":"HDR","ExtendedVideoType":"DolbyVision","ExtendedVideoSubType":"DoviProfile81",
               "ColorTransfer":"smpte2084","DvProfile":8,"DvVersionMajor":1,"DvBlSignalCompatibilityId":1,"VideoRangeType":"DOVIWithHDR10"}""",
        )
        assertEquals("DoviProfile81", s.extendedVideoSubType)
        assertEquals("smpte2084", s.colorTransfer)
        assertEquals(8, s.dvProfile)
        assertEquals(1, s.dvVersionMajor)
        assertEquals("Dolby Vision · HDR10", VideoRange.of(s).badge)
    }
}
