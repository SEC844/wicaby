package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.pure.ExifReader
import com.wika.wicaby.core.files.pure.PhotoHead
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.util.Base64

// Android side of the EXIF reader vectors (photo file sources); the desktop side is tools/checks/photo-files-check.mjs.
// Both read tools/checks/fixtures/photos/exif-vectors.json in place: no copy to drift.
class ExifReaderTest {
    private val f = json.parseToJsonElement(File("../../../tools/checks/fixtures/photos/exif-vectors.json").readText()).jsonObject

    private fun PhotoHead.asMap(): Map<String, Any> = listOf(
        "takenAt" to takenAt, "offset" to offset, "orientation" to orientation, "lat" to lat, "lon" to lon, "alt" to alt,
        "make" to make, "model" to model, "lens" to lens, "exposureS" to exposureS, "fNumber" to fNumber, "focalMm" to focalMm,
        "iso" to iso, "width" to width, "height" to height, "more" to more,
    ).mapNotNull { (k, v) -> v?.let { k to it } }.toMap()

    private fun check(name: String, got: PhotoHead, want: JsonObject) {
        val g = got.asMap()
        assertEquals(name, want.keys, g.keys)
        for ((k, v) in want) {
            val p = v as? kotlinx.serialization.json.JsonPrimitive
            when {
                k == "more" -> assertEquals(name, PhotoHead.More(v.jsonObject["at"]!!.jsonPrimitive.long, v.jsonObject["length"]!!.jsonPrimitive.long), g[k])
                p != null && p.isString -> assertEquals("$name: $k", p.content, g[k])
                else -> assertEquals("$name: $k", p!!.double, (g[k] as Number).toDouble(), 1e-6)
            }
        }
    }

    private fun bytes(s: String) = Base64.getDecoder().decode(s)

    @Test
    fun vectors() {
        val vectors = f["vectors"]!!.jsonArray.map { it.jsonObject }
        for (v in vectors) {
            val name = v["name"]!!.jsonPrimitive.content
            check(name, ExifReader.read(bytes(v["b64"]!!.jsonPrimitive.content)), v["expected"]!!.jsonObject)
            v["item"]?.let { check("$name (item)", ExifReader.heicExifItem(bytes(it.jsonPrimitive.content)), v["itemExpected"]!!.jsonObject) }
        }
        assertEquals(true, vectors.size > 25)
    }

    @Test
    fun orientationNames() {
        f["orientationNames"]!!.jsonArray.forEachIndexed { i, n -> assertEquals(n.jsonPrimitive.content, ExifReader.orientationName(i + 1)) }
        assertEquals(null, ExifReader.orientationName(0))
        assertEquals(null, ExifReader.orientationName(9))
    }

    // Random bytes never throw (the desktop check runs the same seeds).
    @Test
    fun noiseNeverThrows() {
        for (i in 0 until 200) {
            val b = ByteArray(64 + i * 7) { k -> (((k + 1) * (2654435761L + i)).toInt() ushr 13).toByte() }
            if (i % 4 == 0) byteArrayOf(-1, -40, -1, -31, 0, 60, 0x45, 0x78, 0x69, 0x66, 0, 0).copyInto(b)
            ExifReader.read(b)
        }
    }
}
