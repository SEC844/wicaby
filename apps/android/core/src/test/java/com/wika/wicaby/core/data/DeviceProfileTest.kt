package com.wika.wicaby.core.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceProfileTest {
    private val h264 = VideoCaps(1920, 1080, 60, setOf("baseline", "constrained baseline", "main", "high"), 51)
    private val hevcSdr = VideoCaps(3840, 2160, 30, setOf("main", "main 10"), 153, tenBit = true)

    private fun profiles(p: JsonObject, codec: String) =
        p["CodecProfiles"]!!.jsonArray.map { it.jsonObject }.filter { it["Codec"]?.jsonPrimitive?.content == codec }

    private fun cond(profile: JsonObject, key: String, property: String): JsonObject? =
        (profile[key] as? JsonArray)?.map { it.jsonObject }?.firstOrNull { it["Property"]!!.jsonPrimitive.content == property }

    @Test
    fun levels() {
        assertEquals(51, avcLevel(0x8000))
        assertEquals(41, avcLevel(0x1000))
        assertEquals(153, hevcLevel(0x10000)) // Main tier 5.1
        assertEquals(153, hevcLevel(0x20000)) // High tier 5.1
        assertEquals(186, hevcLevel(0x2000000))
        assertEquals(0, hevcLevel(0))
    }

    @Test
    fun h264WithoutHigh10IsCappedAt8Bit() {
        val p = buildDeviceProfile(Caps(mapOf("h264" to h264), setOf("aac")), 20_000_000, jellyfin = false)
        val main = profiles(p, "h264").first()
        assertEquals("8", cond(main, "Conditions", "VideoBitDepth")!!["Value"]!!.jsonPrimitive.content)
        assertFalse(cond(main, "Conditions", "VideoProfile")!!["Value"]!!.jsonPrimitive.content.contains("high 10"))
        assertEquals("51", cond(main, "Conditions", "VideoLevel")!!["Value"]!!.jsonPrimitive.content)
        assertEquals("1920", cond(main, "Conditions", "Width")!!["Value"]!!.jsonPrimitive.content)
    }

    @Test
    fun fourKThirtyGetsAFrameRateCapOnlyAbove1080p() {
        val p = buildDeviceProfile(Caps(mapOf("hevc" to hevcSdr), setOf("aac")), 20_000_000, jellyfin = false)
        val fps = profiles(p, "hevc").first { it["ApplyConditions"] != null }
        assertEquals("30", cond(fps, "Conditions", "VideoFramerate")!!["Value"]!!.jsonPrimitive.content)
        assertEquals("Height", cond(fps, "ApplyConditions", "Height")!!["Property"]!!.jsonPrimitive.content)
    }

    @Test
    fun embyGetsSdrOnlyWhenNoHdrDisplay() {
        val p = buildDeviceProfile(Caps(mapOf("hevc" to hevcSdr), setOf("aac")), 20_000_000, jellyfin = false)
        assertEquals("SDR", cond(profiles(p, "hevc").first(), "Conditions", "VideoRange")!!["Value"]!!.jsonPrimitive.content)
        assertFalse(p.toString().contains("VideoRangeType"))

        val hdr = buildDeviceProfile(Caps(mapOf("hevc" to hevcSdr.copy(ranges = setOf(Range.HDR10))), setOf("aac")), 20_000_000, jellyfin = false)
        assertNull(cond(profiles(hdr, "hevc").first(), "Conditions", "VideoRange"))
    }

    @Test
    fun jellyfinRangeExclusions() {
        val none = unsupportedRanges(hevcSdr, dvHdr10PlusBug = false)
        assertTrue(none.containsAll(listOf("HDR10", "HDR10Plus", "HLG", "DOVI", "DOVIWithHDR10", "DOVIWithEL")))
        assertFalse("DOVIWithSDR" in none)

        val hdr10 = unsupportedRanges(hevcSdr.copy(ranges = setOf(Range.HDR10)), dvHdr10PlusBug = false)
        assertFalse("HDR10" in hdr10)
        assertFalse("HDR10Plus" in hdr10)
        assertFalse("DOVIWithHDR10" in hdr10) // profile 8.1 falls back to HDR10
        assertTrue("DOVI" in hdr10) // profile 5 has no fallback

        val fire = unsupportedRanges(hevcSdr.copy(ranges = setOf(Range.HDR10, Range.DV5, Range.DV8)), dvHdr10PlusBug = true)
        assertTrue("DOVIWithHDR10Plus" in fire)
        assertFalse("DOVI" in fire)

        val p = buildDeviceProfile(Caps(mapOf("hevc" to hevcSdr), setOf("aac")), 20_000_000, jellyfin = true)
        val range = profiles(p, "hevc").first { cond(it, "Conditions", "VideoRangeType") != null }
        assertEquals("NotEquals", cond(range, "Conditions", "VideoRangeType")!!["Condition"]!!.jsonPrimitive.content)
        assertEquals("EqualsAny", cond(range, "ApplyConditions", "VideoRangeType")!!["Condition"]!!.jsonPrimitive.content)
    }

    @Test
    fun bitmapSubtitlesBurnInWhenTranscoding() {
        val p = buildDeviceProfile(Caps(mapOf("h264" to h264), setOf("aac")), 20_000_000, jellyfin = false)
        val subs = p["SubtitleProfiles"]!!.jsonArray.map { it.jsonObject["Format"]!!.jsonPrimitive.content to it.jsonObject["Method"]!!.jsonPrimitive.content }
        assertTrue("pgssub" to "Encode" in subs)
        assertTrue("pgssub" to "Embed" in subs)
        assertTrue("dvdsub" to "Encode" in subs)
        assertFalse("srt" to "Encode" in subs)
    }
}
