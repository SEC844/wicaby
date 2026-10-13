package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Android side of the photos parity vectors (spec PH-01); the desktop side is tools/checks/photos-check.mjs. Both
// read tools/checks/fixtures/photos/photo-fixtures.json in place, so there is no copy to drift.
class PhotoFixturesTest {
    private val f = json.parseToJsonElement(File("../../../tools/checks/fixtures/photos/photo-fixtures.json").readText()).jsonObject

    private fun cases(name: String) = f[name]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.str(k: String) = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.int(k: String) = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.int
    private fun JsonObject.dbl(k: String) = this[k]!!.jsonPrimitive.double
    private fun JsonObject.name() = str("name")!!
    private fun doubles(a: JsonArray) = a.map { it.jsonPrimitive.double }
    private fun near(msg: String, want: Double, got: Double) = assertEquals(msg, want, got, 1e-6)

    private fun templates(lang: String) = f["templates"]!!.jsonObject[lang]!!.jsonObject.let {
        ExifTemplates(it.str("aperture")!!, it.str("exposure")!!, it.str("focal")!!, it.str("iso")!!, it.str("dimensions")!!, it.str("altitude")!!, it.str("location")!!)
    }

    @Test
    fun stringsMatchTheTemplates() {
        for ((dir, lang) in listOf("values" to "fr", "values-en" to "en")) {
            val xml = File("src/main/res/$dir/strings.xml").readText().replace("\\u00A0", " ")
            val got = Regex("""<string name="photos_exif_(\w+)_value">(.*?)</string>""").findAll(xml).associate { it.groupValues[1] to it.groupValues[2] }
            val t = templates(lang)
            assertEquals(dir, mapOf("aperture" to t.aperture, "exposure" to t.exposure, "focal" to t.focal, "iso" to t.iso, "dimensions" to t.dimensions, "altitude" to t.altitude, "location" to t.location), got)
        }
    }

    @Test
    fun takenAt() {
        for (c in cases("takenAt")) assertEquals(c.name(), c.str("expected"), takenAt(c.str("premiereDate"), c.str("dateCreated"), c.int("offsetMin")))
    }

    @Test
    fun toAsset() {
        for (c in cases("toAsset")) {
            val a = toAsset(json.decodeFromJsonElement(Item.serializer(), c["item"]!!), c.int("offsetMin"), c["withLocation"]!!.jsonPrimitive.boolean)
            val e = c["expected"]!!.jsonObject
            assertEquals(c.name(), listOf(e.str("id"), e.str("serverId"), e.str("kind"), e.str("takenAt"), e.int("rotate"), e["favorite"]!!.jsonPrimitive.boolean), listOf(a.id, a.serverId, a.kind, a.takenAt, a.rotate, a.favorite))
            near(c.name(), e.dbl("aspect"), a.aspect)
            assertEquals(c.name(), listOf(e["durationMs"]?.jsonPrimitive?.long, e.str("thumbTag"), e.str("blurHash"), e["lat"]?.jsonPrimitive?.double, e["lon"]?.jsonPrimitive?.double), listOf(a.durationMs, a.thumbTag, a.blurHash, a.lat, a.lon))
        }
    }

    @Test
    fun orientation() {
        for (c in cases("orientation")) {
            val w = c.int("width")!!
            val h = c.int("height")!!
            near(c.name(), c.dbl("aspect"), displayAspect(w, h, c.str("orientation")))
            assertEquals(c.name(), c.int("rotate"), rotation(c.str("orientation"), w, h, c.int("decodedW")!!, c.int("decodedH")!!))
            assertEquals(c.name(), c["relayout"]!!.jsonPrimitive.boolean, needsRelayout(c.dbl("aspect"), c.int("decodedW")!!, c.int("decodedH")!!, c.int("rotate")!!))
        }
    }

    @Test
    fun justify() {
        for (c in cases("justify")) {
            val rows = justify(doubles(c["aspects"]!!.jsonArray), c.dbl("width"), c.dbl("targetH"), c.dbl("gap"), c.dbl("maxScale"))
            val want = c["rows"]!!.jsonArray.map { it.jsonObject }
            assertEquals(c.name(), want.size, rows.size)
            rows.zip(want).forEachIndexed { i, (r, e) ->
                near("${c.name()} row $i top", e.dbl("top"), r.top)
                near("${c.name()} row $i height", e.dbl("height"), r.height)
                val items = e["items"]!!.jsonArray.map { it.jsonObject }
                assertEquals("${c.name()} row $i", items.map { it.int("index") }, r.items.map { it.index })
                r.items.zip(items).forEach { (it, ei) ->
                    near("${c.name()} row $i x", ei.dbl("x"), it.x)
                    near("${c.name()} row $i w", ei.dbl("w"), it.w)
                }
            }
        }
    }

    @Test
    fun sortAndBuckets() {
        for (c in cases("sort")) {
            val assets = c["assets"]!!.jsonArray.map { it.jsonObject.let { a -> PhotoAsset(a.str("id")!!, "", "photo", a.str("takenAt")!!, 1.0) } }
            assertEquals(c.name(), c["expected"]!!.jsonArray.map { it.jsonPrimitive.content }, assets.sortedWith(BY_TAKEN_DESC).map { it.id })
        }
        for (c in cases("buckets")) {
            val want = c["expected"]!!.jsonArray.map { it.jsonObject.let { b -> Bucket(b.str("key")!!, b.int("count")!!, b.int("firstIndex")!!) } }
            assertEquals(c.name(), want, buckets(c["takenAt"]!!.jsonArray.map { it.jsonPrimitive.content }, c.str("unit")!!))
        }
    }

    @Test
    fun layoutTimeline() {
        for (c in cases("layoutTimeline")) {
            val bs = c["buckets"]!!.jsonArray.map { it.jsonObject.let { b -> Bucket(b.str("key")!!, b.int("count")!!, b.int("firstIndex")!!) } }
            val got = layoutTimeline(bs, doubles(c["aspects"]!!.jsonArray), c.dbl("width"), c.dbl("targetH"), c.dbl("gap"), c.dbl("headerH"))
            val want = c["expected"]!!.jsonArray.map { it.jsonObject }
            assertEquals(c.name(), want.size, got.size)
            got.zip(want).forEach { (s, e) ->
                assertEquals(c.name(), listOf(e.str("key"), e.int("rows"), e.int("first")), listOf(s.key, s.rows.size, s.rows.firstOrNull()?.items?.firstOrNull()?.index))
                near("${c.name()} ${s.key} top", e.dbl("top"), s.top)
                near("${c.name()} ${s.key} height", e.dbl("height"), s.height)
            }
        }
    }

    @Test
    fun memories() {
        for (c in cases("memories")) {
            val want = c["expected"]!!.jsonArray.map { it.jsonObject.let { m -> Memory(m.int("yearsAgo")!!, m["indexes"]!!.jsonArray.map { i -> i.jsonPrimitive.int }) } }
            assertEquals(c.name(), want, memories(c["takenAt"]!!.jsonArray.map { it.jsonPrimitive.content }, c.str("today")!!))
        }
    }

    @Test
    fun exif() {
        for (c in cases("exif")) {
            val item = json.decodeFromJsonElement(Item.serializer(), JsonObject(c["item"]!!.jsonObject + ("Id" to json.parseToJsonElement("\"x\""))))
            val want = c["expected"]!!.jsonArray.map { p -> p.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } }
            assertEquals(c.name(), want, formatExif(exifOf(item), c.str("lang")!!, templates(c.str("lang")!!), c.str("aperture")!!))
        }
        assertTrue(formatExif(Exif(apertureAv = 2.97), "fr", templates("fr")).isEmpty())
    }
}
