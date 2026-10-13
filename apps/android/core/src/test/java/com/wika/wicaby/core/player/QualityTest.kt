package com.wika.wicaby.core.player

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wika.wicaby.core.data.capHeight
import java.io.File

// X-02: the golden vectors of CK/fixtures/quality/quality.json, shared with tools/checks/quality-check.mjs
// (D/shared/quality-presets.ts). Gradle runs unit tests from the module directory.
class QualityTest {
    private val fx = Json.parseToJsonElement(File("../../../tools/checks/fixtures/quality/quality.json").readText()).jsonObject

    @Test
    fun presetTable() {
        val expected = fx.getValue("presets").jsonArray.map { r -> r.jsonArray.let { it[0].jsonPrimitive.int to it[1].jsonPrimitive.int } }
        assertEquals(expected, Quality.PRESETS.map { it.bitrate to it.height })
        assertEquals(fx.getValue("original").jsonPrimitive.int, Quality.ORIGINAL)
    }

    @Test
    fun shownPresets() {
        for (c in fx.getValue("shown").jsonArray.map { it.jsonObject }) {
            val rows = Quality.rows(c["bitrate"]?.jsonPrimitive?.intOrNull, c["height"]?.jsonPrimitive?.intOrNull, 9_000_000_000, 7_200_000)
            assertNull("Original first", rows.first().maxBitrate)
            assertEquals(c.getValue("name").jsonPrimitive.content, c.getValue("presets").jsonArray.map { it.jsonPrimitive.int }, rows.drop(1).map { it.maxBitrate })
        }
        // Acceptance 1: the 20 Mbps 1080p preset covers an 18 Mbps 1080p source.
        assertTrue(Quality.coversSource(Quality.PRESETS.first(), 18_000_000, 1080))
    }

    @Test
    fun sizes() {
        for (c in fx.getValue("size").jsonArray.map { it.jsonObject }) {
            assertEquals(c.getValue("bytes").jsonPrimitive.long, Quality.estimateSize(c.getValue("bitrate").jsonPrimitive.int, c.getValue("durationMs").jsonPrimitive.long))
        }
        val rows = Quality.rows(18_000_000, 1080, 5_481_000_000, 2_400_000)
        val r2 = rows.first { it.maxBitrate == 2_000_000 }
        assertEquals(Quality.estimateSize(2_000_000, 2_400_000), r2.size)
        assertEquals(Math.round(r2.size!! * 100.0 / 5_481_000_000).toInt(), r2.percent)
        assertEquals(100, rows.first().percent)
        assertTrue(Quality.rows(null, null, null, 0).all { it.size == null && it.percent == null })
    }

    @Test
    fun versionLabels() {
        for (v in fx.getValue("versions").jsonArray.map { it.jsonObject }) {
            val w = v.getValue("width").jsonPrimitive.int
            val h = v.getValue("height").jsonPrimitive.int
            val codec = v.getValue("codec").jsonPrimitive.content
            val hdr = v["hdr"]?.jsonPrimitive?.content
            assertEquals(v.getValue("label").jsonPrimitive.content, Quality.versionLabel(w, h, codec, hdr))
            assertEquals(v.getValue("signature").jsonPrimitive.content, Quality.signature(w, h, codec, hdr))
        }
    }

    // A preset caps the decoder's size in the profile (720p: 1280x720); an unknown size takes the cap.
    @Test
    fun presetCapsHeight() {
        val caps = com.wika.wicaby.core.data.Caps(
            mapOf("hevc" to com.wika.wicaby.core.data.VideoCaps(3840, 2160), "h264" to com.wika.wicaby.core.data.VideoCaps(0, 0)), setOf("aac"),
        ).capHeight(720)
        assertEquals(1280 to 720, caps.video.getValue("hevc").let { it.maxWidth to it.maxHeight })
        assertEquals(1280 to 720, caps.video.getValue("h264").let { it.maxWidth to it.maxHeight })
        val small = com.wika.wicaby.core.data.Caps(mapOf("h264" to com.wika.wicaby.core.data.VideoCaps(640, 360)), setOf("aac"))
        assertEquals(small, small.capHeight(720))
        assertEquals(small, small.capHeight(0))
    }
}
