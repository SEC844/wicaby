package com.wika.wicaby.core

import com.wika.wicaby.core.data.Chapter
import com.wika.wicaby.core.data.MediaSegment
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.VideoRange
import com.wika.wicaby.core.data.Versions
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.player.embySegments
import com.wika.wicaby.core.player.jellyfinSegments
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// Android side of the TS/Kotlin parity fixtures; the desktop side is tools/checks/parity-check.mjs.
class ParityFixturesTest {
    private fun cases(name: String): List<JsonObject> =
        json.parseToJsonElement(File("../../../tools/checks/fixtures/$name.json").readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

    private fun JsonObject.str(key: String): String? = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.long(key: String): Long? = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.long
    private fun JsonObject.name() = str("name")!!

    @Test
    fun hdr() {
        for (c in cases("hdr")) {
            val r = VideoRange.of(json.decodeFromJsonElement(MediaStream.serializer(), c["stream"]!!))
            // TS kinds; "HDR" (kind unknown) plays as HDR10 there, and SDR and "nothing known" are both no badge here.
            val kind = when (r.primary) {
                VideoRange.DV -> "dv"
                "HDR10+" -> "hdr10+"
                "HDR10", "HDR" -> "hdr10"
                "HLG" -> "hlg"
                else -> null
            }
            assertEquals(c.name(), c.str("kind")?.takeIf { it != "sdr" }, kind)
            assertEquals(c.name(), c.str("dvProfile"), r.dvProfile)
            assertEquals(c.name(), c.str("chip"), r.badge)
        }
    }

    @Test
    fun tracks() {
        for (c in cases("tracks")) {
            val s = json.decodeFromJsonElement(MediaSource.serializer(), c["source"]!!)
            assertEquals(c.name(), c.long("audio")?.toInt(), Versions.defaultAudioStream(s)?.index)
            assertEquals(c.name(), c.long("subtitle")?.toInt() ?: -1, Versions.defaultSubtitleIndex(s))
        }
    }

    @Test
    fun segments() {
        for (c in cases("segments")) {
            val s = c["chapters"]?.let { embySegments(json.decodeFromJsonElement(ListSerializer(Chapter.serializer()), it)) }
                ?: jellyfinSegments(json.decodeFromJsonElement(ListSerializer(MediaSegment.serializer()), c["segments"]!!))
            assertEquals(c.name(), listOf(c.long("introStartMs"), c.long("introEndMs"), c.long("creditsStartMs")), listOf(s.introStart, s.introEnd, s.credits))
        }
    }
}
